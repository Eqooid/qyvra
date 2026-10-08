import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  embeddingProfileFingerprint,
  ProcessingRepository,
  type PrismaClient,
  type ProcessingMessage,
} from '@qyvra/database';
import {
  hashText,
  CHUNK_STRATEGY,
  DeterministicChunker,
} from '../src/modules/ai/deterministic-chunker';
import { PDF_EXTRACTOR } from '../src/infrastructure/extraction/pdf-parser';
import { ChunkGenerationHandler } from '../src/infrastructure/worker/chunk-generation.handler';
import { EmbeddingGenerationHandler } from '../src/infrastructure/worker/embedding-generation.handler';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import {
  EmbeddingFailure,
  embeddingInputHash,
  type EmbeddingProvider,
  type EmbeddingRequest,
} from '../src/modules/ai/embedding-provider';
import type { ApiConfiguration } from '../src/configuration/settings';
import { RabbitMqConsumer } from '../src/infrastructure/messaging/rabbitmq.consumer';
import { RabbitMqPublisher } from '../src/infrastructure/messaging/rabbitmq.publisher';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'embedding checkpoints and recovery (PostgreSQL, no paid calls)',
  () => {
    let db: PrismaClient, repository: ProcessingRepository;
    const users: string[] = [],
      profiles: string[] = [];
    beforeAll(async () => {
      if (!url || !/test/i.test(new URL(url).pathname))
        throw Error('Disposable test database required');
      db = createPrismaClient({
        url,
        queryTimeoutMs: 10000,
        connectTimeoutMs: 2000,
        poolSize: 5,
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
    async function envelope(id: string) {
      const outbox = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: id },
        orderBy: { dispatchSequence: 'desc' },
      });
      return outbox.payload as unknown as ProcessingMessage;
    }
    async function fixture(dimensions = 3) {
      const user = await db.user.create({
        data: { email: `${randomUUID()}@example.invalid` },
      });
      users.push(user.id);
      const document = await db.document.create({
        data: { userId: user.id, title: 'Embedding fixture' },
      });
      const version = await db.documentVersion.create({
        data: {
          id: randomUUID(),
          documentId: document.id,
          userId: user.id,
          versionNumber: 1,
          originalFilename: 'fixture.pdf',
          storageKey: `fixture/${randomUUID()}.pdf`,
          mimeType: 'application/pdf',
          fileSize: 10,
          pageCount: 1,
          checksumSha256: hashText('fixture'),
        },
      });
      const identity = {
        provider: 'test',
        model: randomUUID(),
        modelRevision: 'v1',
        dimensions,
        distance: 'Cosine' as const,
        profileVersion: 1,
        normalizationVersion: 'qyvra-embedding-input/v1',
        tokenizer: 'cl100k_base',
        tokenizerVersion: 'tiktoken-1.0.22',
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
        ...PDF_EXTRACTOR,
        ...CHUNK_STRATEGY,
        chunkSize: 32,
        chunkOverlap: 8,
        embeddingProfileId: profile.id,
      });
      const integrity = await db.processingJob.findFirstOrThrow({
        where: { documentVersionId: version.id, jobType: 'VERIFY_STORED_FILE' },
      });
      const verified = await repository.claim(integrity.id, new Date(), 120000);
      await repository.complete(verified.id, verified.leaseToken!, new Date());
      const extraction = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
      });
      const claimed = await repository.claim(extraction.id, new Date(), 120000);
      const text = 'Authoritative canonical text. Indonesian é 文 😀. '.repeat(
        30,
      );
      await repository.complete(
        claimed.id,
        claimed.leaseToken!,
        new Date(),
        async (tx) => {
          const artifact = await tx.extractedText.create({
            data: {
              userId: user.id,
              documentId: document.id,
              documentVersionId: version.id,
              extractionFingerprint: hashText(randomUUID()),
              ...PDF_EXTRACTOR,
              sourceChecksum: version.checksumSha256,
              contentHash: hashText(text),
              text,
              characterCount: [...text].length,
              pageCount: 1,
              pageSpans: [
                { pageNumber: 1, startOffset: 0, endOffset: [...text].length },
              ],
              outcome: 'COMPLETED',
            },
          });
          return { extractedTextId: artifact.id };
        },
      );
      const chunk = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: run.id, jobType: 'GENERATE_CHUNKS' },
      });
      const chunkHandler = new ChunkGenerationHandler(
        db,
        new DeterministicChunker(),
        {
          chunkSize: 32,
          chunkOverlap: 8,
          maxChunks: 10000,
          maxOutputBytes: 40000000,
          timeoutMs: 30000,
        },
      );
      expect(
        await new ProcessingMessageHandler(repository, [chunkHandler]).handle(
          await envelope(chunk.id),
          false,
        ),
      ).toBe('ack');
      const job = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: run.id, jobType: 'GENERATE_EMBEDDINGS' },
      });
      const chunks = await db.documentChunk.findMany({
        where: { chunkSetId: job.chunkSetId! },
        orderBy: { ordinal: 'asc' },
      });
      const config: ApiConfiguration['embedding'] = {
        enabled: true,
        profileFingerprint: profile.fingerprint,
        batchSize: 2,
        maxInputTokens: 8191,
        maxBatchTokens: 100000,
        timeoutMs: 1000,
        sendDimensions: true,
      };
      return {
        user,
        document,
        version,
        profile,
        run,
        job,
        chunks,
        config,
        message: await envelope(job.id),
      };
    }
    function fake() {
      const calls: EmbeddingRequest[] = [];
      const provider: EmbeddingProvider = {
        embed: jest.fn(async (request) => {
          calls.push(request);
          // Stable vectors tied to text, returned in reverse order to prove explicit ID mapping.
          return request.inputs
            .map((input) => ({
              id: input.id,
              vector: [1, 2, input.text.length],
            }))
            .reverse();
        }),
      };
      return { provider, calls };
    }
    function execution(
      job: Awaited<ReturnType<ProcessingRepository['claim']>>,
    ) {
      return {
        jobId: job.id,
        documentId: job.documentId,
        documentVersionId: job.documentVersionId,
        leaseToken: job.leaseToken!,
        attempt: job.attempts,
      };
    }
    it('persists exact owned vectors, schedules one indexing intent and handles duplicate/concurrent delivery', async () => {
      const f = await fixture(),
        { provider, calls } = fake();
      const worker = new ProcessingMessageHandler(repository, [
        new EmbeddingGenerationHandler(db, provider, f.config),
      ]);
      const decisions = await Promise.all([
        worker.handle(f.message, false),
        worker.handle(f.message, false),
      ]);
      expect(decisions).toContain('ack');
      expect(await worker.handle(f.message, true)).toBe('ack');
      expect(
        calls.flatMap((call) => call.inputs.map((input) => input.id)),
      ).toEqual(f.chunks.map((chunk) => chunk.id));
      const embeddings = await db.chunkEmbedding.findMany({
        where: { embeddingProfileId: f.profile.id },
      });
      expect(embeddings).toHaveLength(f.chunks.length);
      for (const chunk of f.chunks)
        expect(embeddings.find((e) => e.chunkId === chunk.id)).toMatchObject({
          userId: f.user.id,
          documentVersionId: f.version.id,
          inputHash: embeddingInputHash(chunk.text),
          vector: [1, 2, chunk.text.length],
          dimensions: 3,
        });
      expect(
        await db.processingJob.count({
          where: { aiRunId: f.run.id, jobType: 'INDEX_VECTORS' },
        }),
      ).toBe(1);
      const next = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: f.run.id, jobType: 'INDEX_VECTORS' },
      });
      expect(
        await db.processingOutbox.count({
          where: { processingJobId: next.id },
        }),
      ).toBe(1);
      expect(
        await db.versionVectorIndex.findUniqueOrThrow({
          where: { id: next.vectorIndexId! },
        }),
      ).toMatchObject({ status: 'BUILDING', confirmedPointCount: 0 });
    });
    it('keeps earlier batches on transient failure and resumes only missing chunks after durable retry', async () => {
      const f = await fixture(),
        { provider, calls } = fake();
      const normal = provider.embed.bind(provider);
      provider.embed = async (request) => {
        if (calls.length === 1)
          throw new EmbeddingFailure('EMBEDDING_RATE_LIMITED', true, 60000);
        return normal(request);
      };
      const worker = new ProcessingMessageHandler(repository, [
        new EmbeddingGenerationHandler(db, provider, f.config),
      ]);
      const before = Date.now();
      expect(await worker.handle(f.message, false)).toBe('ack');
      const retry = await repository.findById(f.job.id);
      expect(retry?.status).toBe('RETRYING');
      expect(retry!.availableAt.getTime()).toBeGreaterThanOrEqual(
        before + 60000,
      );
      expect(
        await db.chunkEmbedding.count({
          where: { embeddingProfileId: f.profile.id },
        }),
      ).toBe(2);
      expect(
        await db.processingJob.count({
          where: { aiRunId: f.run.id, jobType: 'INDEX_VECTORS' },
        }),
      ).toBe(0);
      // Advance only the test clock's due timestamp; no waiting/scheduler alternative.
      await db.processingJob.update({
        where: { id: f.job.id },
        data: { availableAt: new Date(Date.now() - 1) },
      });
      await repository.scheduleRetryDispatch(f.job.id, new Date());
      provider.embed = normal;
      expect(await worker.handle(await envelope(f.job.id), false)).toBe('ack');
      expect(
        new Set(calls.flatMap((call) => call.inputs.map((input) => input.id)))
          .size,
      ).toBe(f.chunks.length);
      expect(calls.flatMap((call) => call.inputs)).toHaveLength(
        f.chunks.length,
      );
    });
    it('recovers crash after checkpoint/before completion without repeating paid work', async () => {
      const f = await fixture(),
        { provider, calls } = fake();
      const handler = new EmbeddingGenerationHandler(db, provider, f.config);
      const claim = await repository.claim(f.job.id, new Date(), 120000);
      expect((await handler.execute(execution(claim))).kind).toBe('success');
      expect((await repository.findById(f.job.id))?.status).toBe('PROCESSING');
      const paid = calls.length;
      await db.processingJob.update({
        where: { id: f.job.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      await repository.recoverInterrupted(
        f.job.id,
        claim.leaseToken!,
        new Date(),
      );
      await db.processingJob.update({
        where: { id: f.job.id },
        data: { availableAt: new Date(Date.now() - 1) },
      });
      await repository.scheduleRetryDispatch(f.job.id, new Date());
      expect(
        await new ProcessingMessageHandler(repository, [handler]).handle(
          await envelope(f.job.id),
          true,
        ),
      ).toBe('ack');
      expect(calls).toHaveLength(paid);
    });
    it.each(['partial', 'zero', 'dimensions', 'duplicate'])(
      'rejects whole invalid %s batch, with no checkpoints/index',
      async (mode) => {
        const f = await fixture();
        const provider: EmbeddingProvider = {
          embed: async (request) => {
            const vectors = request.inputs.map((input) => ({
              id: input.id,
              vector:
                mode === 'zero'
                  ? [0, 0, 0]
                  : mode === 'dimensions'
                    ? [1, 2]
                    : [1, 2, 3],
            }));
            return mode === 'partial'
              ? vectors.slice(0, 1)
              : mode === 'duplicate'
                ? [vectors[0], vectors[0]]
                : vectors;
          },
        };
        expect(
          await new ProcessingMessageHandler(repository, [
            new EmbeddingGenerationHandler(db, provider, f.config),
          ]).handle(f.message, false),
        ).toBe('ack');
        expect((await repository.findById(f.job.id))?.lastFailureCode).toBe(
          'EMBEDDING_INVALID_OUTPUT',
        );
        expect(
          await db.chunkEmbedding.count({
            where: { embeddingProfileId: f.profile.id },
          }),
        ).toBe(0);
        expect(
          await db.processingJob.count({
            where: { aiRunId: f.run.id, jobType: 'INDEX_VECTORS' },
          }),
        ).toBe(0);
      },
    );
    it.each(['same', 'profile', 'chunks'])(
      'reprocesses %s identity without mixing checkpoints',
      async (mode) => {
        const f = await fixture(),
          initial = fake();
        await new ProcessingMessageHandler(repository, [
          new EmbeddingGenerationHandler(db, initial.provider, f.config),
        ]).handle(f.message, false);
        const indexing = await db.processingJob.findFirstOrThrow({
          where: { aiRunId: f.run.id, jobType: 'INDEX_VECTORS' },
        });
        const indexClaim = await repository.claim(
          indexing.id,
          new Date(),
          120000,
        );
        await repository.fail(
          indexClaim.id,
          indexClaim.leaseToken!,
          new Date(),
          'TEST_INTERRUPTED',
          false,
        );
        let profile = f.profile;
        if (mode === 'profile') {
          const identity = {
            profileVersion: 2,
            provider: f.profile.provider,
            model: f.profile.model,
            modelRevision: 'v2',
            dimensions: 4,
            distance: 'Cosine' as const,
            normalizationVersion: f.profile.normalizationVersion,
            tokenizer: f.profile.tokenizer,
            tokenizerVersion: f.profile.tokenizerVersion,
            documentInstruction: '',
            queryInstruction: '',
          };
          profile = await db.embeddingProfile.create({
            data: {
              ...identity,
              fingerprint: embeddingProfileFingerprint(identity),
            },
          });
          profiles.push(profile.id);
        }
        const run = await repository.requestAiProcessing(
          {
            userId: f.user.id,
            documentId: f.document.id,
            documentVersionId: f.version.id,
            ...PDF_EXTRACTOR,
            ...CHUNK_STRATEGY,
            chunkOverlap: f.run.chunkOverlap,
            chunkSize: mode === 'chunks' ? 64 : f.run.chunkSize,
            embeddingProfileId: profile.id,
            correlationId: randomUUID(),
            maxAttempts: 3,
          },
          true,
        );
        const extract = await db.processingJob.findFirstOrThrow({
          where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
        });
        const extraction = await repository.claim(
          extract.id,
          new Date(),
          120000,
        );
        await repository.complete(
          extraction.id,
          extraction.leaseToken!,
          new Date(),
          async () => ({ extractedTextId: f.job.extractedTextId! }),
        );
        const chunk = await db.processingJob.findFirstOrThrow({
          where: { aiRunId: run.id, jobType: 'GENERATE_CHUNKS' },
        });
        const chunkHandler = new ChunkGenerationHandler(
          db,
          new DeterministicChunker(),
          {
            chunkSize: 32,
            chunkOverlap: 8,
            maxChunks: 10000,
            maxOutputBytes: 40000000,
            timeoutMs: 30000,
          },
        );
        await new ProcessingMessageHandler(repository, [chunkHandler]).handle(
          await envelope(chunk.id),
          false,
        );
        const job = await db.processingJob.findFirstOrThrow({
          where: { aiRunId: run.id, jobType: 'GENERATE_EMBEDDINGS' },
        });
        const calls: string[] = [];
        const provider: EmbeddingProvider = {
          embed: async (request) => {
            calls.push(...request.inputs.map((input) => input.id));
            return request.inputs.map((input) => ({
              id: input.id,
              vector: Array.from(
                { length: request.profile.dimensions },
                (_, index) => index + 1,
              ),
            }));
          },
        };
        await new ProcessingMessageHandler(repository, [
          new EmbeddingGenerationHandler(db, provider, {
            ...f.config,
            profileFingerprint: profile.fingerprint,
          }),
        ]).handle(await envelope(job.id), false);
        expect((await repository.findById(job.id))?.status).toBe('COMPLETED');
        expect(
          await db.chunkEmbedding.count({
            where: {
              embeddingProfileId: f.profile.id,
              chunk: { chunkSetId: f.job.chunkSetId! },
            },
          }),
        ).toBe(f.chunks.length);
        if (mode === 'same') expect(calls).toHaveLength(0);
        else if (mode === 'profile') {
          expect(calls).toEqual(f.chunks.map((chunk) => chunk.id));
          expect(
            await db.chunkEmbedding.count({
              where: { embeddingProfileId: profile.id, dimensions: 4 },
            }),
          ).toBe(f.chunks.length);
        } else {
          expect(calls.length).toBeGreaterThan(0);
          expect(
            calls.every((id) => !f.chunks.some((chunk) => chunk.id === id)),
          ).toBe(true);
        }
      },
    );
    it('rolls back an interrupted batch and accepts realistic vectors within production query limits', async () => {
      const f = await fixture(1536);
      const claim = await repository.claim(f.job.id, new Date(), 120000);
      await expect(
        repository.checkpoint(
          claim.id,
          claim.leaseToken!,
          new Date(),
          async (tx) => {
            await tx.chunkEmbedding.create({
              data: {
                userId: f.user.id,
                documentId: f.document.id,
                documentVersionId: f.version.id,
                chunkId: f.chunks[0].id,
                embeddingProfileId: f.profile.id,
                dimensions: 1536,
                inputHash: embeddingInputHash(f.chunks[0].text),
                vector: Array(1536).fill(0.1) as number[],
              },
            });
            await tx.$executeRaw`SELECT 1 / 0`;
            return {};
          },
        ),
      ).rejects.toThrow();
      expect(
        await db.chunkEmbedding.count({
          where: { embeddingProfileId: f.profile.id },
        }),
      ).toBe(0);
      const productionDb = createPrismaClient({
        url: url!,
        queryTimeoutMs: 500,
        connectTimeoutMs: 2000,
        poolSize: 3,
      });
      const provider: EmbeddingProvider = {
        embed: async (request) =>
          request.inputs.map((input) => ({
            id: input.id,
            vector: Array.from(
              { length: request.profile.dimensions },
              (_, index) => (index + 1) / request.profile.dimensions,
            ),
          })),
      };
      try {
        const handler = new EmbeddingGenerationHandler(productionDb, provider, {
          ...f.config,
          batchSize: 32,
        });
        const result = await handler.execute(execution(claim));
        expect(result.kind).toBe('success');
        if (result.kind === 'success')
          await repository.complete(
            claim.id,
            claim.leaseToken!,
            new Date(),
            result.commit,
          );
        expect(
          await db.chunkEmbedding.count({
            where: { embeddingProfileId: f.profile.id },
          }),
        ).toBe(f.chunks.length);
      } finally {
        await productionDb.$disconnect();
      }
    });
    (process.env.TEST_RABBITMQ_URL ? it : it.skip)(
      'handles duplicate real RabbitMQ embedding delivery with one index intent',
      async () => {
        const f = await fixture(),
          { provider, calls } = fake();
        const worker = new ProcessingMessageHandler(repository, [
          new EmbeddingGenerationHandler(db, provider, f.config),
        ]);
        const consumer = new RabbitMqConsumer(worker, {
          url: process.env.TEST_RABBITMQ_URL,
          connectTimeoutMs: 3000,
          prefetch: 2,
          reconnectDelayMs: 100,
          shutdownTimeoutMs: 1000,
        });
        const publisher = new RabbitMqPublisher({
          url: process.env.TEST_RABBITMQ_URL,
          connectTimeoutMs: 3000,
          confirmTimeoutMs: 5000,
        });
        try {
          await consumer.start();
          await Promise.all([
            publisher.publishProcessing(f.message),
            publisher.publishProcessing(f.message),
          ]);
          for (
            let i = 0;
            i < 100 &&
            (await repository.findById(f.job.id))?.status !== 'COMPLETED';
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 50));
          expect(await repository.findById(f.job.id)).toMatchObject({
            status: 'COMPLETED',
            attempts: 1,
          });
          expect(calls.flatMap((call) => call.inputs)).toHaveLength(
            f.chunks.length,
          );
          const next = await db.processingJob.findFirstOrThrow({
            where: { aiRunId: f.run.id, jobType: 'INDEX_VECTORS' },
          });
          expect(
            await db.processingOutbox.count({
              where: { processingJobId: next.id },
            }),
          ).toBe(1);
        } finally {
          await consumer.stop();
          await publisher.onApplicationShutdown();
        }
      },
    );
    it('rejects corrupted input-hash checkpoints without replacing them or calling a provider', async () => {
      const f = await fixture(),
        { provider, calls } = fake();
      await db.chunkEmbedding.create({
        data: {
          userId: f.user.id,
          documentId: f.document.id,
          documentVersionId: f.version.id,
          chunkId: f.chunks[0].id,
          embeddingProfileId: f.profile.id,
          dimensions: 3,
          inputHash: '0'.repeat(64),
          vector: [1, 2, 3],
        },
      });
      await new ProcessingMessageHandler(repository, [
        new EmbeddingGenerationHandler(db, provider, f.config),
      ]).handle(f.message, false);
      expect(calls).toHaveLength(0);
      expect(await repository.findById(f.job.id)).toMatchObject({
        status: 'FAILED',
        lastFailureCode: 'EMBEDDING_CHECKPOINT_INVALID',
      });
      expect(
        await db.chunkEmbedding.count({
          where: { embeddingProfileId: f.profile.id },
        }),
      ).toBe(1);
    });
    it('rejects an incompatible profile before disclosure', async () => {
      const f = await fixture(),
        { provider, calls } = fake();
      const config = { ...f.config, profileFingerprint: '0'.repeat(64) };
      await new ProcessingMessageHandler(repository, [
        new EmbeddingGenerationHandler(db, provider, config),
      ]).handle(f.message, false);
      expect(calls).toHaveLength(0);
      expect((await repository.findById(f.job.id))?.lastFailureCode).toBe(
        'EMBEDDING_PROFILE_MISMATCH',
      );
    });
    it('fences lifecycle changes after provider disclosure and rolls back the entire batch', async () => {
      const f = await fixture();
      const provider: EmbeddingProvider = {
        embed: async (request) => {
          await db.document.update({
            where: { id: f.document.id },
            data: { isArchived: true, status: 'ARCHIVED' },
          });
          return request.inputs.map((input) => ({
            id: input.id,
            vector: [1, 2, 3],
          }));
        },
      };
      const claim = await repository.claim(f.job.id, new Date(), 120000);
      await expect(
        new EmbeddingGenerationHandler(db, provider, f.config).execute(
          execution(claim),
        ),
      ).rejects.toMatchObject({ code: 'INELIGIBLE_DOCUMENT' });
      expect(
        await db.chunkEmbedding.count({
          where: { embeddingProfileId: f.profile.id },
        }),
      ).toBe(0);
    });
    it('fences stale leases after provider output and bounds an unresponsive provider', async () => {
      const f = await fixture();
      const claim = await repository.claim(f.job.id, new Date(), 120000);
      const provider: EmbeddingProvider = {
        embed: async (request) => {
          await db.processingJob.update({
            where: { id: f.job.id },
            data: { leaseExpiresAt: new Date(Date.now() - 1) },
          });
          return request.inputs.map((input) => ({
            id: input.id,
            vector: [1, 2, 3],
          }));
        },
      };
      await expect(
        new EmbeddingGenerationHandler(db, provider, f.config).execute(
          execution(claim),
        ),
      ).rejects.toMatchObject({ code: 'CONCURRENT_CHANGE' });
      expect(
        await db.chunkEmbedding.count({
          where: { embeddingProfileId: f.profile.id },
        }),
      ).toBe(0);
      const g = await fixture();
      const stalled: EmbeddingProvider = {
        embed: () => new Promise(() => undefined),
      };
      await new ProcessingMessageHandler(repository, [
        new EmbeddingGenerationHandler(db, stalled, {
          ...g.config,
          timeoutMs: 20,
        }),
      ]).handle(g.message, false);
      expect(await repository.findById(g.job.id)).toMatchObject({
        status: 'RETRYING',
        lastFailureCode: 'EMBEDDING_TIMEOUT',
      });
    });
  },
);
