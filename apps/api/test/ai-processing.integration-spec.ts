import { createHash, randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  embeddingProfileFingerprint,
  ProcessingRepository,
  type PrismaClient,
  type ProcessingMessage,
} from '@qyvra/database';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import { ProcessingRecovery } from '../src/infrastructure/outbox/processing-recovery.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'AI worker and outbox with PostgreSQL (broker boundary simulated)',
  () => {
    let db: PrismaClient;
    let repository: ProcessingRepository;
    const users: string[] = [],
      profiles: string[] = [];
    beforeAll(async () => {
      if (!url || !/test/i.test(new URL(url).pathname))
        throw Error('Use a disposable TEST_DATABASE_URL');
      db = createPrismaClient({
        url,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 10000,
        poolSize: 4,
      });
      repository = new ProcessingRepository(db);
      await db.$connect();
    });
    afterAll(async () => {
      try {
        await db.document.deleteMany({ where: { userId: { in: users } } });
        await db.user.deleteMany({ where: { id: { in: users } } });
        await db.embeddingProfile.deleteMany({
          where: { id: { in: profiles } },
        });
      } finally {
        await db.$disconnect();
      }
    });
    async function fixture() {
      const user = await db.user.create({
        data: { email: `${randomUUID()}@example.invalid` },
      });
      users.push(user.id);
      const document = await db.document.create({
        data: { userId: user.id, title: 'AI worker test' },
      });
      const version = await db.documentVersion.create({
        data: {
          userId: user.id,
          documentId: document.id,
          versionNumber: 1,
          originalFilename: 'test.pdf',
          storageKey: `test/${randomUUID()}`,
          mimeType: 'application/pdf',
          fileSize: 5,
          pageCount: 1,
          checksumSha256: createHash('sha256')
            .update(randomUUID())
            .digest('hex'),
        },
      });
      const identity = {
        profileVersion: 1,
        provider: 'test',
        model: randomUUID(),
        modelRevision: 'v1',
        dimensions: 3,
        distance: 'Cosine' as const,
        normalizationVersion: 'v1',
        tokenizer: 'test',
        tokenizerVersion: 'v1',
        documentInstruction: '',
        queryInstruction: '',
      };
      const profile = await db.embeddingProfile.create({
        data: {
          ...identity,
          fingerprint: embeddingProfileFingerprint(identity),
        },
      });
      profiles.push(profile.id);
      const run = await repository.requestAiProcessing({
        userId: user.id,
        documentId: document.id,
        documentVersionId: version.id,
        correlationId: randomUUID(),
        maxAttempts: 3,
        extractor: 'test',
        extractorVersion: 'v1',
        normalizationVersion: 'v1',
        chunkAlgorithm: 'test',
        chunkAlgorithmVersion: 'v1',
        tokenizer: 'test',
        tokenizerVersion: 'v1',
        chunkSize: 512,
        chunkOverlap: 64,
        embeddingProfileId: profile.id,
      });
      const verification = await db.processingJob.findFirstOrThrow({
        where: { documentVersionId: version.id, jobType: 'VERIFY_STORED_FILE' },
      });
      const claim = await repository.claim(verification.id, new Date(), 60000);
      await repository.complete(claim.id, claim.leaseToken!, new Date());
      const extraction = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
      });
      const outbox = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: extraction.id },
      });
      return { run, extraction, outbox };
    }
    it('duplicate confirmed publications deliver one unavailable-handler failure and stop the run', async () => {
      const { run, extraction, outbox } = await fixture();
      const delivered: ProcessingMessage[] = [];
      const dispatch = new OutboxDispatcher(
        repository,
        {
          publishProcessing: async (message) => {
            delivered.push(message);
          },
        },
        { pollIntervalMs: 1000, batchSize: 100, leaseMs: 1000 },
      );
      await dispatch.dispatchOnce();
      const message = delivered.find((value) => value.jobId === extraction.id)!;
      expect(message.schemaVersion).toBe(2);
      expect(
        (
          await db.processingOutbox.findUniqueOrThrow({
            where: { id: outbox.id },
          })
        ).status,
      ).toBe('PUBLISHED');
      const worker = new ProcessingMessageHandler(repository, []);
      const decisions = await Promise.all([
        worker.handle(message, false),
        worker.handle(message, false),
      ]);
      expect(decisions).toContain('ack');
      expect(
        decisions.every((decision) => ['ack', 'retry'].includes(decision)),
      ).toBe(true);
      expect(await worker.handle(message, true)).toBe('ack');
      const persisted = await repository.findById(extraction.id);
      expect(persisted).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        lastFailureCode: 'HANDLER_NOT_IMPLEMENTED',
      });
      expect(
        (await db.aiProcessingRun.findUniqueOrThrow({ where: { id: run.id } }))
          .status,
      ).toBe('FAILED');
      expect(
        await db.processingJob.count({
          where: { aiRunId: run.id, jobType: 'GENERATE_CHUNKS' },
        }),
      ).toBe(0);
    });
    it('worker interruption enters the shared retry/outbox coordinator without executing AI', async () => {
      const { extraction } = await fixture();
      const now = new Date(),
        claim = await repository.claim(extraction.id, now, 1000);
      const recovery = new ProcessingRecovery(
        repository,
        { pollIntervalMs: 1000, batchSize: 100 },
        () => new Date(now.getTime() + 1001),
      );
      await recovery.runOnce();
      const retry = await repository.findById(extraction.id);
      expect(retry).toMatchObject({
        status: 'RETRYING',
        attempts: 1,
        lastFailureCode: 'WORKER_INTERRUPTED',
      });
      const due = new ProcessingRecovery(
        repository,
        { pollIntervalMs: 1000, batchSize: 100 },
        () => retry!.availableAt,
      );
      await due.runOnce();
      await due.runOnce();
      expect(
        await db.processingOutbox.count({
          where: { processingJobId: extraction.id, dispatchSequence: 2 },
        }),
      ).toBe(1);
      await expect(
        repository.complete(extraction.id, claim.leaseToken!, new Date()),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });
  },
);
