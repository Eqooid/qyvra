import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:http';
import { connect } from 'amqplib';
import {
  LocalFileStorage,
  STORAGE,
  StorageError,
  type Storage,
} from '@qyvra/storage';
import { ProcessingRepository } from '@qyvra/database';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import { ProcessingRecovery } from '../src/infrastructure/outbox/processing-recovery.service';
import { RabbitMqPublisher } from '../src/infrastructure/messaging/rabbitmq.publisher';
import { RabbitMqConsumer } from '../src/infrastructure/messaging/rabbitmq.consumer';
import { parseProcessingMessage } from '../src/infrastructure/messaging/processing-message';
import { PROCESSING_QUEUE } from '../src/infrastructure/messaging/rabbitmq-topology';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import { StoredFileIntegrityHandler } from '../src/infrastructure/worker/stored-file-integrity.handler';
import { RedisProcessingProgressStore } from '../src/infrastructure/progress/redis-processing-progress.store';
import { createTestOwner } from './owner.fixture';
import { validateTestEnvironment } from './configuration.fixture';
import { pdfFixture } from './upload.fixture';

const brokerUrl = process.env.TEST_RABBITMQ_URL;
const describeBroker =
  process.env.TEST_DATABASE_URL && brokerUrl ? describe : describe.skip;

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Scheduled processing did not reach its expected state.');
}

describeBroker('upload scheduling through the Phase 3 infrastructure', () => {
  let app: INestApplication;
  let server: Server;
  let db: PrismaService;
  let directory: string;
  const users: string[] = [];

  beforeAll(async () => {
    if (
      !process.env.TEST_DATABASE_URL ||
      !/test/i.test(new URL(process.env.TEST_DATABASE_URL).pathname)
    )
      throw new Error('Use a disposable migrated TEST_DATABASE_URL.');
    directory = await mkdtemp(join(tmpdir(), 'qyvra-t07-test-'));
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      UPLOAD_QPDF_PATH: process.env.UPLOAD_QPDF_PATH,
      REDIS_URL: process.env.TEST_REDIS_URL,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(STORAGE)
      .useValue(new LocalFileStorage(join(directory, 'objects')))
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
    db = app.get(PrismaService);
  });

  afterAll(async () => {
    if (db) {
      await db.client.documentUpload.deleteMany({
        where: { userId: { in: users } },
      });
      await db.client.document.deleteMany({ where: { userId: { in: users } } });
      await db.client.authSession.deleteMany({
        where: { userId: { in: users } },
      });
      await db.client.user.deleteMany({ where: { id: { in: users } } });
    }
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('verifies a real uploaded file through outbox, RabbitMQ and the production handler', async () => {
    if (!brokerUrl) throw new Error('TEST_RABBITMQ_URL is required.');
    const owner = await createTestOwner(db, users);
    const correlationId = randomUUID();
    const repository = new ProcessingRepository(db.client);
    const progress = new RedisProcessingProgressStore({
      url: process.env.TEST_REDIS_URL,
      ttlSeconds: 180,
      connectTimeoutMs: 500,
      commandTimeoutMs: 500,
    });
    const report = jest.spyOn(progress, 'report');
    const integrity = new StoredFileIntegrityHandler(
      db.client,
      new LocalFileStorage(join(directory, 'objects')),
      90000,
      progress,
    );
    const execution = jest.spyOn(integrity, 'execute');
    const consumer = new RabbitMqConsumer(
      new ProcessingMessageHandler(
        repository,
        [integrity],
        undefined,
        undefined,
        progress,
      ),
      {
        url: brokerUrl,
        connectTimeoutMs: 3000,
        prefetch: 1,
        reconnectDelayMs: 100,
        shutdownTimeoutMs: 1000,
      },
    );
    const publisher = new RabbitMqPublisher({
      url: brokerUrl,
      connectTimeoutMs: 3000,
      confirmTimeoutMs: 10000,
    });
    try {
      await consumer.start();
      const response = await request(server)
        .post('/api/v1/documents')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Protection', '1')
        .set('Idempotency-Key', randomUUID())
        .set('X-Correlation-Id', correlationId)
        .field('title', 'Scheduled document')
        .attach('file', pdfFixture(randomUUID()), 'scheduled.pdf')
        .expect(201);
      const versionId = response.body.data.version.id as string;
      const job = await db.client.processingJob.findFirstOrThrow({
        where: { documentVersionId: versionId },
        include: { outbox: true },
      });
      expect(job.outbox).toHaveLength(1);
      expect(job.outbox[0].status).toBe('PENDING');
      expect(job.correlationId).toBe(correlationId);

      const dispatcher = new OutboxDispatcher(repository, publisher, {
        pollIntervalMs: 1000,
        batchSize: 10,
        leaseMs: 30000,
      });
      await dispatcher.dispatchOnce();
      await waitFor(
        async () => (await repository.findById(job.id))?.status === 'COMPLETED',
      );
      const status = await request(server)
        .get(
          `/api/v1/documents/${job.documentId}/versions/${versionId}/processing`,
        )
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(status.body.data.jobs).toMatchObject([
        {
          id: job.id,
          status: 'COMPLETED',
          attempts: 1,
          failureCode: null,
          progress: null,
        },
      ]);
      if (process.env.TEST_REDIS_URL) {
        expect(report).toHaveBeenCalledWith(job.id, 1, 0, 'PREPARING');
        expect(report).toHaveBeenCalledWith(job.id, 1, 99, 'FINALIZING');
        expect(await progress.read(job.id, 1)).toBeNull();
      }
      expect(
        execution.mock.calls.filter(([input]) => input.jobId === job.id),
      ).toHaveLength(1);
      expect(execution).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          documentVersionId: versionId,
          attempt: 1,
        }),
      );
      expect(
        (
          await db.client.processingOutbox.findUniqueOrThrow({
            where: { id: job.outbox[0].id },
          })
        ).status,
      ).toBe('PUBLISHED');
      await publisher.publishProcessing(
        parseProcessingMessage(job.outbox[0].payload),
      );
      const broker = await connect(brokerUrl);
      try {
        const channel = await broker.createChannel();
        await waitFor(
          async () =>
            (await channel.checkQueue(PROCESSING_QUEUE)).messageCount === 0 &&
            consumer.activeCount() === 0,
        );
        await channel.close();
      } finally {
        await broker.close();
      }
      expect(
        execution.mock.calls.filter(([input]) => input.jobId === job.id),
      ).toHaveLength(1);
      expect((await repository.findById(job.id))?.attempts).toBe(1);
    } finally {
      await consumer.stop();
      await publisher.onApplicationShutdown();
      await progress.onApplicationShutdown();
    }
  });

  it('persists terminal failures for corrupted and missing stored files', async () => {
    if (!brokerUrl) throw new Error('TEST_RABBITMQ_URL is required.');
    const owner = await createTestOwner(db, users);
    const repository = new ProcessingRepository(db.client);
    const integrity = new StoredFileIntegrityHandler(
      db.client,
      new LocalFileStorage(join(directory, 'objects')),
      90000,
    );
    const consumer = new RabbitMqConsumer(
      new ProcessingMessageHandler(repository, [integrity]),
      {
        url: brokerUrl,
        connectTimeoutMs: 3000,
        prefetch: 1,
        reconnectDelayMs: 100,
        shutdownTimeoutMs: 1000,
      },
    );
    const publisher = new RabbitMqPublisher({
      url: brokerUrl,
      connectTimeoutMs: 3000,
      confirmTimeoutMs: 10000,
    });
    try {
      await consumer.start();
      const response = await request(server)
        .post('/api/v1/documents')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Protection', '1')
        .set('Idempotency-Key', randomUUID())
        .field('title', 'Corrupt after upload')
        .attach('file', pdfFixture(randomUUID()), 'corrupt.pdf')
        .expect(201);
      const versionId = response.body.data.version.id as string;
      const version = await db.client.documentVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      await writeFile(
        join(directory, 'objects', ...version.storageKey.split('/')),
        Buffer.alloc(version.fileSize, 42),
      );
      const job = await db.client.processingJob.findFirstOrThrow({
        where: { documentVersionId: versionId },
      });
      const dispatcher = new OutboxDispatcher(repository, publisher, {
        pollIntervalMs: 1000,
        batchSize: 10,
        leaseMs: 30000,
      });
      await dispatcher.dispatchOnce();
      await waitFor(
        async () => (await repository.findById(job.id))?.status === 'FAILED',
      );
      expect((await repository.findById(job.id))?.lastFailureCode).toBe(
        'FILE_CHECKSUM_MISMATCH',
      );
      expect((await repository.findById(job.id))?.attempts).toBe(1);
      expect((await repository.findById(job.id))?.completedAt).toBeInstanceOf(
        Date,
      );

      const missingResponse = await request(server)
        .post('/api/v1/documents')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Protection', '1')
        .set('Idempotency-Key', randomUUID())
        .field('title', 'Missing after upload')
        .attach('file', pdfFixture(randomUUID()), 'missing.pdf')
        .expect(201);
      const missingVersionId = missingResponse.body.data.version.id as string;
      const missingVersion = await db.client.documentVersion.findUniqueOrThrow({
        where: { id: missingVersionId },
      });
      await rm(
        join(directory, 'objects', ...missingVersion.storageKey.split('/')),
      );
      const missingJob = await db.client.processingJob.findFirstOrThrow({
        where: { documentVersionId: missingVersionId },
      });
      await dispatcher.dispatchOnce();
      await waitFor(
        async () =>
          (await repository.findById(missingJob.id))?.status === 'FAILED',
      );
      expect((await repository.findById(missingJob.id))?.lastFailureCode).toBe(
        'FILE_NOT_FOUND',
      );
      const document = await db.client.document.findUniqueOrThrow({
        where: { id: missingVersion.documentId },
      });
      expect(document.status).toBe('UPLOADED');
      expect(document.deletedAt).toBeNull();
    } finally {
      await consumer.stop();
      await publisher.onApplicationShutdown();
    }
  });

  it('persists a retry due time after a transient storage outage', async () => {
    if (!brokerUrl) throw new Error('TEST_RABBITMQ_URL is required.');
    const owner = await createTestOwner(db, users);
    const repository = new ProcessingRepository(db.client);
    const unavailableStorage = {
      open: jest.fn().mockRejectedValue(new StorageError('UNAVAILABLE')),
    } as unknown as Storage;
    const consumer = new RabbitMqConsumer(
      new ProcessingMessageHandler(repository, [
        new StoredFileIntegrityHandler(db.client, unavailableStorage, 90000),
      ]),
      {
        url: brokerUrl,
        connectTimeoutMs: 3000,
        prefetch: 1,
        reconnectDelayMs: 100,
        shutdownTimeoutMs: 1000,
      },
    );
    const publisher = new RabbitMqPublisher({
      url: brokerUrl,
      connectTimeoutMs: 3000,
      confirmTimeoutMs: 10000,
    });
    try {
      await consumer.start();
      const response = await request(server)
        .post('/api/v1/documents')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Protection', '1')
        .set('Idempotency-Key', randomUUID())
        .field('title', 'Transient storage failure')
        .attach('file', pdfFixture(randomUUID()), 'transient.pdf')
        .expect(201);
      const job = await db.client.processingJob.findFirstOrThrow({
        where: { documentVersionId: response.body.data.version.id as string },
      });
      const dispatcher = new OutboxDispatcher(repository, publisher, {
        pollIntervalMs: 1000,
        batchSize: 10,
        leaseMs: 30000,
      });
      await dispatcher.dispatchOnce();
      await waitFor(
        async () => (await repository.findById(job.id))?.status === 'RETRYING',
      );
      const retried = await repository.findById(job.id);
      expect(retried?.attempts).toBe(1);
      expect(retried?.lastFailureCode).toBe('STORAGE_READ_FAILED');
      expect(retried?.availableAt.getTime()).toBeGreaterThan(
        job.availableAt.getTime(),
      );
      // This test stops at durable RETRYING; keep later coordinator tests isolated.
      await db.client.document.delete({ where: { id: job.documentId } });
    } finally {
      await consumer.stop();
      await publisher.onApplicationShutdown();
    }
  });

  it('recovers a transient integrity failure through a second durable delivery', async () => {
    if (!brokerUrl) throw new Error('TEST_RABBITMQ_URL is required.');
    const owner = await createTestOwner(db, users);
    const repository = new ProcessingRepository(db.client);
    const actualStorage = new LocalFileStorage(join(directory, 'objects'));
    const open = jest
      .fn()
      .mockRejectedValueOnce(new StorageError('UNAVAILABLE'))
      .mockImplementation((key: string) => actualStorage.open(key));
    const storage = { open } as unknown as Storage;
    const integrity = new StoredFileIntegrityHandler(db.client, storage, 90000);
    const execution = jest.spyOn(integrity, 'execute');
    let now = new Date(Date.now() + 2000);
    const consumer = new RabbitMqConsumer(
      new ProcessingMessageHandler(repository, [integrity], () => now),
      {
        url: brokerUrl,
        connectTimeoutMs: 3000,
        prefetch: 1,
        reconnectDelayMs: 100,
        shutdownTimeoutMs: 1000,
      },
    );
    const publisher = new RabbitMqPublisher({
      url: brokerUrl,
      connectTimeoutMs: 3000,
      confirmTimeoutMs: 10000,
    });
    const dispatcher = new OutboxDispatcher(
      repository,
      publisher,
      { pollIntervalMs: 1000, batchSize: 10, leaseMs: 30000 },
      () => now,
    );
    const recovery = new ProcessingRecovery(
      repository,
      { pollIntervalMs: 5000, batchSize: 10 },
      () => now,
    );
    try {
      await consumer.start();
      const response = await request(server)
        .post('/api/v1/documents')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Protection', '1')
        .set('Idempotency-Key', randomUUID())
        .field('title', 'Recovered integrity check')
        .attach('file', pdfFixture(randomUUID()), 'recovered.pdf')
        .expect(201);
      const job = await db.client.processingJob.findFirstOrThrow({
        where: { documentVersionId: response.body.data.version.id as string },
      });
      await dispatcher.dispatchOnce();
      await waitFor(
        async () => (await repository.findById(job.id))?.status === 'RETRYING',
      );
      const retry = await repository.findById(job.id);
      expect(retry?.attempts).toBe(1);
      const retryStatus = await request(server)
        .get(
          `/api/v1/documents/${job.documentId}/versions/${job.documentVersionId}/processing`,
        )
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(retryStatus.body.data.jobs).toMatchObject([
        {
          id: job.id,
          status: 'RETRYING',
          attempts: 1,
          nextRetryAt: retry?.availableAt.toISOString(),
          failureCode: 'TEMPORARY_PROCESSING_ERROR',
        },
      ]);
      expect(await recovery.runOnce()).toEqual({ recovered: 0, scheduled: 0 });
      if (!retry) throw new Error('Retry state missing.');
      now = new Date(retry.availableAt.getTime() + 1);
      expect(await recovery.runOnce()).toEqual({ recovered: 0, scheduled: 1 });
      expect(await recovery.runOnce()).toEqual({ recovered: 0, scheduled: 0 });
      const intents = await db.client.processingOutbox.findMany({
        where: { processingJobId: job.id },
        orderBy: { dispatchSequence: 'asc' },
      });
      expect(intents).toHaveLength(2);
      expect(intents.map((intent) => intent.dispatchSequence)).toEqual([1, 2]);
      expect(intents[0].id).not.toBe(intents[1].id);
      expect(intents[0].correlationId).toBe(intents[1].correlationId);
      await dispatcher.dispatchOnce();
      await waitFor(
        async () => (await repository.findById(job.id))?.status === 'COMPLETED',
      );
      expect(execution).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(2);
      expect((await repository.findById(job.id))?.attempts).toBe(2);
      expect(
        (
          await db.client.processingOutbox.findUniqueOrThrow({
            where: { id: intents[1].id },
          })
        ).status,
      ).toBe('PUBLISHED');
    } finally {
      await consumer.stop();
      await publisher.onApplicationShutdown();
    }
  });

  it('recovers an expired worker lease without replaying a live attempt', async () => {
    if (!brokerUrl) throw new Error('TEST_RABBITMQ_URL is required.');
    const owner = await createTestOwner(db, users);
    const repository = new ProcessingRepository(db.client);
    let now = new Date(Date.now() + 2000);
    const publisher = new RabbitMqPublisher({
      url: brokerUrl,
      connectTimeoutMs: 3000,
      confirmTimeoutMs: 10000,
    });
    const dispatcher = new OutboxDispatcher(
      repository,
      publisher,
      { pollIntervalMs: 1000, batchSize: 10, leaseMs: 30000 },
      () => now,
    );
    const recovery = new ProcessingRecovery(
      repository,
      { pollIntervalMs: 5000, batchSize: 10 },
      () => now,
    );
    const integrity = new StoredFileIntegrityHandler(
      db.client,
      new LocalFileStorage(join(directory, 'objects')),
      90000,
    );
    const consumer = new RabbitMqConsumer(
      new ProcessingMessageHandler(repository, [integrity], () => now),
      {
        url: brokerUrl,
        connectTimeoutMs: 3000,
        prefetch: 1,
        reconnectDelayMs: 100,
        shutdownTimeoutMs: 1000,
      },
    );
    try {
      const response = await request(server)
        .post('/api/v1/documents')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Protection', '1')
        .set('Idempotency-Key', randomUUID())
        .field('title', 'Interrupted integrity check')
        .attach('file', pdfFixture(randomUUID()), 'interrupted.pdf')
        .expect(201);
      const job = await db.client.processingJob.findFirstOrThrow({
        where: { documentVersionId: response.body.data.version.id as string },
      });
      await dispatcher.dispatchOnce();
      const claimed = await repository.claim(job.id, now, 1000);
      expect(claimed.attempts).toBe(1);
      expect(await recovery.runOnce()).toEqual({ recovered: 0, scheduled: 0 });
      now = new Date(now.getTime() + 1001);
      expect(await recovery.runOnce()).toEqual({ recovered: 1, scheduled: 0 });
      const retry = await repository.findById(job.id);
      expect(retry?.status).toBe('RETRYING');
      expect(retry?.lastFailureCode).toBe('WORKER_INTERRUPTED');
      if (!retry) throw new Error('Recovered retry state missing.');
      now = new Date(retry.availableAt.getTime() + 1);
      expect(await recovery.runOnce()).toEqual({ recovered: 0, scheduled: 1 });
      await dispatcher.dispatchOnce();
      await consumer.start();
      await waitFor(
        async () => (await repository.findById(job.id))?.status === 'COMPLETED',
      );
      expect((await repository.findById(job.id))?.attempts).toBe(2);
      expect(
        await db.client.processingOutbox.count({
          where: { processingJobId: job.id },
        }),
      ).toBe(2);
    } finally {
      await consumer.stop();
      await publisher.onApplicationShutdown();
    }
  });
});
