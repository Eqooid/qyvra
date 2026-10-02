import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import {
  createPrismaClient,
  ProcessingRepository,
  type PrismaClient,
  type ProcessingMessageV1,
} from '@qyvra/database';
import type { MessagePublisher } from '../src/infrastructure/messaging/message-publisher';
import { RabbitMqPublisher } from '../src/infrastructure/messaging/rabbitmq.publisher';
import { PROCESSING_QUEUE } from '../src/infrastructure/messaging/rabbitmq-topology';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const brokerUrl = process.env.TEST_RABBITMQ_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('outbox dispatcher against PostgreSQL', () => {
  let db: PrismaClient;
  let repository: ProcessingRepository;
  const users: string[] = [];
  const documents: string[] = [];
  const settings = { pollIntervalMs: 1000, batchSize: 10, leaseMs: 1000 };

  beforeAll(async () => {
    if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
      throw new Error('Use a migrated disposable TEST_DATABASE_URL.');
    db = createPrismaClient({
      url: databaseUrl,
      connectTimeoutMs: 2000,
      queryTimeoutMs: 5000,
      poolSize: 4,
    });
    repository = new ProcessingRepository(db);
    await db.$connect();
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of documents) await db.document.delete({ where: { id } });
    for (const id of users) await db.user.delete({ where: { id } });
    await db.$disconnect();
  });

  async function fixture() {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const document = await db.document.create({
      data: { userId: user.id, title: 'Outbox fixture' },
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
    return repository.create({
      userId: user.id,
      documentId: document.id,
      documentVersionId: version.id,
      correlationId: randomUUID(),
      maxAttempts: 3,
    });
  }

  it('one of two dispatchers claims and records a confirmed publication', async () => {
    const { outbox } = await fixture();
    const delivered: ProcessingMessageV1[] = [];
    const publisher: MessagePublisher = {
      publishProcessing: async (message) => {
        delivered.push(message);
      },
    };
    const now = new Date(Date.now() + 10);
    const first = new OutboxDispatcher(
      repository,
      publisher,
      settings,
      () => now,
    );
    const second = new OutboxDispatcher(
      repository,
      publisher,
      settings,
      () => now,
    );
    await Promise.all([first.dispatchOnce(), second.dispatchOnce()]);
    expect(
      delivered.filter((message) => message.messageId === outbox.id),
    ).toHaveLength(1);
    const saved = await db.processingOutbox.findUniqueOrThrow({
      where: { id: outbox.id },
    });
    expect(saved.status).toBe('PUBLISHED');
    expect(saved.publicationAttempts).toBe(1);
    expect(saved.publishedAt).not.toBeNull();
  });

  it('retains a failed publication until its retry time, then uses the same message ID', async () => {
    const { outbox } = await fixture();
    let now = new Date(Date.now() + 10);
    let fail = true;
    const delivered: string[] = [];
    const publisher: MessagePublisher = {
      publishProcessing: async (message) => {
        delivered.push(message.messageId);
        if (fail) throw new Error('broker unavailable');
      },
    };
    const dispatcher = new OutboxDispatcher(
      repository,
      publisher,
      settings,
      () => now,
    );
    await dispatcher.dispatchOnce();
    const failed = await db.processingOutbox.findUniqueOrThrow({
      where: { id: outbox.id },
    });
    expect(failed.status).toBe('PENDING');
    expect(failed.lastFailureCode).toBe('PUBLISH_FAILED');
    expect(failed.availableAt.getTime()).toBeGreaterThan(now.getTime());
    await dispatcher.dispatchOnce();
    expect(delivered).toEqual([outbox.id]);
    fail = false;
    now = new Date(failed.availableAt.getTime() + 1);
    await dispatcher.dispatchOnce();
    expect(delivered).toEqual([outbox.id, outbox.id]);
    expect(
      (
        await db.processingOutbox.findUniqueOrThrow({
          where: { id: outbox.id },
        })
      ).status,
    ).toBe('PUBLISHED');
  });

  it('replays a confirmed message after a failed publication-state update and expired lease', async () => {
    const { outbox } = await fixture();
    let now = new Date(Date.now() + 10);
    const delivered: string[] = [];
    const publisher: MessagePublisher = {
      publishProcessing: async (message) => {
        delivered.push(message.messageId);
      },
    };
    const failingRepository = Object.create(repository) as ProcessingRepository;
    failingRepository.markOutboxPublished = async () => {
      throw new Error('database unavailable');
    };
    await new OutboxDispatcher(
      failingRepository,
      publisher,
      settings,
      () => now,
    ).dispatchOnce();
    expect(
      (
        await db.processingOutbox.findUniqueOrThrow({
          where: { id: outbox.id },
        })
      ).status,
    ).toBe('PENDING');
    now = new Date(now.getTime() + settings.leaseMs + 1);
    await new OutboxDispatcher(
      repository,
      publisher,
      settings,
      () => now,
    ).dispatchOnce();
    expect(delivered).toEqual([outbox.id, outbox.id]);
    expect(
      (
        await db.processingOutbox.findUniqueOrThrow({
          where: { id: outbox.id },
        })
      ).status,
    ).toBe('PUBLISHED');
  });

  const itBroker = brokerUrl ? it : it.skip;
  itBroker(
    'delivers a stored outbox envelope to RabbitMQ before marking it published',
    async () => {
      if (!brokerUrl) throw new Error('TEST_RABBITMQ_URL is required.');
      const { outbox } = await fixture();
      const publisher = new RabbitMqPublisher({
        url: brokerUrl,
        connectTimeoutMs: 5000,
        confirmTimeoutMs: 10000,
      });
      const connection = await connect(brokerUrl);
      const channel = await connection.createChannel();
      try {
        const dispatcher = new OutboxDispatcher(repository, publisher, {
          ...settings,
          leaseMs: 30000,
        });
        await dispatcher.dispatchOnce();
        const received = await channel.get(PROCESSING_QUEUE, { noAck: false });
        expect(received).not.toBe(false);
        if (!received) return;
        expect(received.properties.messageId).toBe(outbox.id);
        expect(JSON.parse(received.content.toString('utf8')).messageId).toBe(
          outbox.id,
        );
        expect(
          (
            await db.processingOutbox.findUniqueOrThrow({
              where: { id: outbox.id },
            })
          ).status,
        ).toBe('PUBLISHED');
        channel.ack(received);
      } finally {
        await publisher.onApplicationShutdown();
        await channel.close();
        await connection.close();
      }
    },
  );
});
