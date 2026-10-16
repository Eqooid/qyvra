import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  ProcessingRepository,
  SearchPersistenceRepository,
  type PrismaClient,
  type ProcessingMessage,
} from '@qyvra/database';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import {
  parseProcessingMessage,
  serializeProcessingMessage,
} from '../src/infrastructure/messaging/processing-message';

const url = process.env.TEST_DATABASE_URL;
const describeDatabase = url ? describe : describe.skip;

describeDatabase(
  'v3 search contracts through real SQL outbox and worker boundary',
  () => {
    let db: PrismaClient;
    let owner: string;
    let generation: string;
    beforeAll(async () => {
      if (!url || !/test/i.test(new URL(url).pathname))
        throw new Error('Use a migrated disposable TEST_DATABASE_URL.');
      db = createPrismaClient({
        url,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 8000,
        poolSize: 4,
      });
      await db.$connect();
    });
    afterAll(async () => {
      if (!db) return;
      if (owner) {
        await db.document.deleteMany({ where: { userId: owner } });
        await db.user.delete({ where: { id: owner } });
      }
      if (generation)
        await db.searchIndexGeneration.delete({ where: { id: generation } });
      await db.$disconnect();
    });
    it('publishes canonical v3 once and never claims or completes absent search handlers', async () => {
      const repository = new ProcessingRepository(db),
        search = new SearchPersistenceRepository(db);
      const unique = randomUUID();
      const g = await search.createGeneration({
        generation: randomInt(1, 2147483647),
        schemaVersion: 1,
        mappingVersion: 'v1-' + unique,
        analyzerVersion: 'v1',
        extractor: 'pdf',
        extractorVersion: 'v1',
        normalizationVersion: 'nfc-lf-v1',
        segmentationVersion: 'v1',
        metadataIndexName: 'qyvra-search-' + unique + '-metadata',
        pageIndexName: 'qyvra-search-' + unique + '-pages',
      });
      generation = g.id;
      const user = await db.user.create({
        data: { email: unique + '@example.invalid' },
      });
      owner = user.id;
      const document = await db.document.create({
        data: { userId: owner, title: 'Contract fixture' },
      });
      const version = await db.documentVersion.create({
        data: {
          userId: owner,
          documentId: document.id,
          versionNumber: 1,
          originalFilename: 'fixture.png',
          storageKey: 'test/' + unique,
          mimeType: 'image/png',
          fileSize: 12,
          checksumSha256: createHash('sha256').update(unique).digest('hex'),
        },
      });
      const owned = {
        userId: owner,
        documentId: document.id,
        documentVersionId: version.id,
      };
      const created = await db.$transaction(async (tx) => {
        await search.initializeStateInTransaction(tx, owned);
        const projection = await search.createProjectionInTransaction(tx, {
          ...owned,
          indexGenerationId: g.id,
          revision: 1,
          metadataHash: (
            await tx.$queryRaw<
              { hash: string }[]
            >`SELECT search_metadata_hash(${version.id}::uuid) AS hash`
          )[0].hash,
        });
        return search.createJobInTransaction(tx, {
          ...owned,
          searchProjectionId: projection.id,
          jobType: 'INDEX_SEARCH',
          maxAttempts: 3,
          correlationId: randomUUID(),
        });
      });
      const delivered: ProcessingMessage[] = [];
      const now = new Date();
      const dispatcher = new OutboxDispatcher(
        repository,
        {
          publishProcessing: async (message) => {
            delivered.push(
              parseProcessingMessage(
                JSON.parse(
                  serializeProcessingMessage(message).toString('utf8'),
                ),
              ),
            );
          },
        },
        { pollIntervalMs: 1000, batchSize: 10, leaseMs: 1000 },
        () => now,
        ['INDEX_SEARCH'],
      );
      await dispatcher.dispatchOnce();
      await dispatcher.dispatchOnce();
      const messages = delivered.filter(
        (message) => message.messageId === created.outbox.id,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        schemaVersion: 3,
        indexGenerationId: g.id,
        revision: 1,
      });
      expect(
        (
          await db.processingOutbox.findUniqueOrThrow({
            where: { id: created.outbox.id },
          })
        ).status,
      ).toBe('PUBLISHED');
      const handler = new ProcessingMessageHandler(repository, [], () => now);
      expect(await handler.handle(messages[0], false)).toBe('dead-letter');
      const saved = await db.processingJob.findUniqueOrThrow({
        where: { id: created.job.id },
      });
      expect(saved.status).toBe('PENDING');
      expect(saved.attempts).toBe(0);
      expect(saved.completedAt).toBeNull();
      expect(saved.leaseToken).toBeNull();
    });
  },
);
