import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type ConfirmChannel } from 'amqplib';
import { NestFactory } from '@nestjs/core';
import {
  createPrismaClient,
  ProcessingRepository,
  type PrismaClient,
  type ProcessingMessageV1,
} from '@qyvra/database';
import {
  RabbitMqConsumer,
  type ProcessingDeliveryHandler,
} from '../src/infrastructure/messaging/rabbitmq.consumer';
import { RabbitMqPublisher } from '../src/infrastructure/messaging/rabbitmq.publisher';
import { parseProcessingMessage } from '../src/infrastructure/messaging/processing-message';
import {
  declareProcessingTopology,
  DEAD_QUEUE,
  PROCESSING_EXCHANGE,
  PROCESSING_QUEUE,
  PROCESSING_ROUTING_KEY,
} from '../src/infrastructure/messaging/rabbitmq-topology';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import {
  ProcessingMessageHandler,
  type ProcessingJobHandler,
} from '../src/infrastructure/worker/processing-message-handler';
import { WorkerModule } from '../src/infrastructure/worker/worker.module';
import { StoredFileIntegrityHandler } from '../src/infrastructure/worker/stored-file-integrity.handler';
import { workerReadyFile } from '../src/infrastructure/worker/worker-ready';

const databaseUrl = process.env.TEST_DATABASE_URL;
const brokerUrl = process.env.TEST_RABBITMQ_URL;
const describeInfrastructure =
  databaseUrl && brokerUrl ? describe : describe.skip;

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Worker integration condition was not reached.');
}

describeInfrastructure('dedicated worker infrastructure', () => {
  let db: PrismaClient;
  let repository: ProcessingRepository;
  let channel: ConfirmChannel;
  let broker: Awaited<ReturnType<typeof connect>>;
  const users: string[] = [];
  const documents: string[] = [];

  beforeAll(async () => {
    if (
      !databaseUrl ||
      !brokerUrl ||
      !/test/i.test(new URL(databaseUrl).pathname)
    )
      throw new Error(
        'Use an isolated migrated TEST_DATABASE_URL and TEST_RABBITMQ_URL.',
      );
    db = createPrismaClient({
      url: databaseUrl,
      connectTimeoutMs: 2000,
      queryTimeoutMs: 5000,
      poolSize: 4,
    });
    repository = new ProcessingRepository(db);
    await db.$connect();
    broker = await connect(brokerUrl);
    channel = await broker.createConfirmChannel();
    await declareProcessingTopology(channel);
    if (
      (await channel.checkQueue(PROCESSING_QUEUE)).messageCount !== 0 ||
      (await channel.checkQueue(DEAD_QUEUE)).messageCount !== 0
    )
      throw new Error('Worker tests require empty isolated RabbitMQ queues.');
  });

  afterAll(async () => {
    if (channel) await channel.close();
    if (broker) await broker.close();
    if (db) {
      for (const id of documents) await db.document.delete({ where: { id } });
      for (const id of users) await db.user.delete({ where: { id } });
      await db.$disconnect();
    }
  });

  async function fixture() {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const document = await db.document.create({
      data: { userId: user.id, title: 'Worker fixture' },
    });
    documents.push(document.id);
    const version = await db.documentVersion.create({
      data: {
        userId: user.id,
        documentId: document.id,
        versionNumber: 1,
        originalFilename: 'fixture.png',
        storageKey: `test/${randomUUID()}`,
        mimeType: 'image/png',
        fileSize: 12,
        checksumSha256: createHash('sha256').update(randomUUID()).digest('hex'),
      },
    });
    const result = await repository.create({
      userId: user.id,
      documentId: document.id,
      documentVersionId: version.id,
      correlationId: randomUUID(),
      maxAttempts: 3,
    });
    return {
      ...result,
      envelope: parseProcessingMessage(result.outbox.payload),
    };
  }

  function consumer(
    handler: ProcessingDeliveryHandler,
    shutdownTimeoutMs = 1000,
  ) {
    return new RabbitMqConsumer(handler, {
      url: brokerUrl,
      connectTimeoutMs: 3000,
      prefetch: 2,
      reconnectDelayMs: 100,
      shutdownTimeoutMs,
    });
  }

  async function publishRaw(
    payload: Buffer,
    messageId: string = randomUUID(),
    correlationId: string = randomUUID(),
  ) {
    channel.publish(PROCESSING_EXCHANGE, PROCESSING_ROUTING_KEY, payload, {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId,
      correlationId,
    });
    await channel.waitForConfirms();
  }

  async function drainDead(expected: number) {
    await waitFor(
      async () =>
        (await channel.checkQueue(DEAD_QUEUE)).messageCount >= expected,
    );
    for (let index = 0; index < expected; index++) {
      const delivery = await channel.get(DEAD_QUEUE, { noAck: false });
      expect(delivery).not.toBe(false);
      if (delivery) channel.ack(delivery);
    }
  }

  it('starts an independent Nest worker context and removes readiness on shutdown', async () => {
    const previousBrokerUrl = process.env.RABBITMQ_URL;
    const previousStorageRoot = process.env.LOCAL_STORAGE_ROOT;
    process.env.RABBITMQ_URL = brokerUrl;
    process.env.LOCAL_STORAGE_ROOT = join(
      tmpdir(),
      'qyvra-worker-test-storage',
    );
    try {
      const app = await NestFactory.createApplicationContext(WorkerModule, {
        logger: false,
      });
      try {
        expect(app.get(StoredFileIntegrityHandler)).toBeInstanceOf(
          StoredFileIntegrityHandler,
        );
        const runtime = app.get(RabbitMqConsumer);
        expect(runtime.isReady()).toBe(false);
        await runtime.start();
        expect(runtime.isReady()).toBe(true);
        expect(existsSync(workerReadyFile)).toBe(true);
      } finally {
        await app.close();
      }
      expect(existsSync(workerReadyFile)).toBe(false);
    } finally {
      if (previousBrokerUrl === undefined) delete process.env.RABBITMQ_URL;
      else process.env.RABBITMQ_URL = previousBrokerUrl;
      if (previousStorageRoot === undefined)
        delete process.env.LOCAL_STORAGE_ROOT;
      else process.env.LOCAL_STORAGE_ROOT = previousStorageRoot;
    }
  });

  it('relays a committed outbox message through RabbitMQ and completes only a test handler', async () => {
    const { job, outbox, envelope } = await fixture();
    const execute = jest.fn().mockResolvedValue({ kind: 'success' });
    const testHandler: ProcessingJobHandler = {
      jobType: 'VERIFY_STORED_FILE',
      execute,
    };
    const worker = consumer(
      new ProcessingMessageHandler(repository, [testHandler]),
    );
    const publisher = new RabbitMqPublisher({
      url: brokerUrl,
      connectTimeoutMs: 3000,
      confirmTimeoutMs: 10000,
    });
    try {
      await worker.start();
      expect(worker.isReady()).toBe(true);
      const dispatcher = new OutboxDispatcher(repository, publisher, {
        pollIntervalMs: 1000,
        batchSize: 10,
        leaseMs: 30000,
      });
      await dispatcher.dispatchOnce();
      await waitFor(
        async () => (await repository.findById(job.id))?.status === 'COMPLETED',
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await repository.findById(job.id))?.attempts).toBe(1);
      expect(
        (
          await db.processingOutbox.findUniqueOrThrow({
            where: { id: outbox.id },
          })
        ).status,
      ).toBe('PUBLISHED');
      await publisher.publishProcessing(envelope);
      await waitFor(
        async () =>
          (await channel.checkQueue(PROCESSING_QUEUE)).messageCount === 0,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await repository.findById(job.id))?.attempts).toBe(1);
    } finally {
      await worker.stop();
      await publisher.onApplicationShutdown();
    }
  });

  it('dead-letters malformed, unknown-version/type, and missing-job messages without execution', async () => {
    const execute = jest.fn();
    const worker = consumer(
      new ProcessingMessageHandler(repository, [
        { jobType: 'VERIFY_STORED_FILE', execute },
      ]),
    );
    const valid: ProcessingMessageV1 = {
      schemaVersion: 1,
      messageId: randomUUID(),
      type: 'processing.execute',
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      jobId: randomUUID(),
      documentId: randomUUID(),
      documentVersionId: randomUUID(),
      jobType: 'VERIFY_STORED_FILE',
      dispatchSequence: 1,
    };
    try {
      await worker.start();
      await publishRaw(Buffer.from('{not-json'));
      for (const bad of [
        { ...valid, schemaVersion: 2 },
        { ...valid, jobType: 'UNKNOWN' },
        { ...valid, jobId: 'bad-id' },
        valid,
      ])
        await publishRaw(
          Buffer.from(JSON.stringify(bad)),
          bad.messageId,
          bad.correlationId,
        );
      await drainDead(5);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
    }
  });

  it('dead-letters the known type without a production handler and leaves its job unclaimed', async () => {
    const { job, envelope } = await fixture();
    const worker = consumer(new ProcessingMessageHandler(repository, []));
    const publisher = new RabbitMqPublisher({
      url: brokerUrl,
      connectTimeoutMs: 3000,
      confirmTimeoutMs: 10000,
    });
    try {
      await worker.start();
      await publisher.publishProcessing(envelope);
      await drainDead(1);
      expect((await repository.findById(job.id))?.status).toBe('PENDING');
      expect((await repository.findById(job.id))?.attempts).toBe(0);
    } finally {
      await worker.stop();
      await publisher.onApplicationShutdown();
    }
  });

  it('redelivers an unacknowledged delivery after worker shutdown', async () => {
    let release: (() => void) | undefined;
    let received = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = consumer(
      {
        handle: async () => {
          received = true;
          await pending;
          return 'ack';
        },
      },
      50,
    );
    const observed: boolean[] = [];
    const second = consumer({
      handle: async (_message, redelivered) => {
        observed.push(redelivered);
        return 'ack';
      },
    });
    const message: ProcessingMessageV1 = {
      schemaVersion: 1,
      messageId: randomUUID(),
      type: 'processing.execute',
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      jobId: randomUUID(),
      documentId: randomUUID(),
      documentVersionId: randomUUID(),
      jobType: 'VERIFY_STORED_FILE',
      dispatchSequence: 1,
    };
    try {
      await first.start();
      await publishRaw(
        Buffer.from(JSON.stringify(message)),
        message.messageId,
        message.correlationId,
      );
      await waitFor(() => received);
      await first.stop();
      await second.start();
      await waitFor(() => observed.length === 1);
      expect(observed).toEqual([true]);
    } finally {
      release?.();
      await first.stop();
      await second.stop();
    }
  });
});
