import { QdrantClient } from '@qdrant/js-client-rest';
import { RabbitMqConsumer } from '../src/infrastructure/messaging/rabbitmq.consumer';
import { RabbitMqPublisher } from '../src/infrastructure/messaging/rabbitmq.publisher';
import { QdrantVectorStore } from '../src/infrastructure/vectors/qdrant-vector-store';
import { VectorIndexHandler } from '../src/infrastructure/worker/vector-index.handler';
import { VectorRemovalHandler } from '../src/infrastructure/worker/vector-removal.handler';
import {
  vectorCollectionName,
  vectorPointId,
  VectorStoreFailure,
  type VectorStore,
  type VectorScope,
  type VectorPoint,
} from '../src/modules/ai/vector-store';
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
  type EmbeddingProvider,
  type EmbeddingRequest,
} from '../src/modules/ai/embedding-provider';
import type { ApiConfiguration } from '../src/configuration/settings';

const url = process.env.TEST_DATABASE_URL;
// These cases perform multiple complete SQL/Qdrant lifecycles, including collection rebuilds.
jest.setTimeout(30000);
(url && process.env.TEST_QDRANT_URL ? describe : describe.skip)(
  'vector indexing, activation and cleanup (PostgreSQL + real Qdrant)',
  () => {
    let db: PrismaClient, repository: ProcessingRepository;
    const settings: ApiConfiguration['vectorIndex'] = {
      enabled: true,
      url: process.env.TEST_QDRANT_URL,
      timeoutMs: 5000,
      batchSize: 2,
    };
    const admin = new QdrantClient({
      url: process.env.TEST_QDRANT_URL,
      checkCompatibility: false,
    });
    const store = new QdrantVectorStore(settings);
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
        for (const id of profiles)
          await admin.deleteCollection(vectorCollectionName(id));
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
        8,
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
    async function prepared() {
      const data = await fixture();
      const provider: EmbeddingProvider = {
        embed: jest.fn(async (request: EmbeddingRequest) =>
          request.inputs.map((input) => ({
            id: input.id,
            vector: [1, 2, input.text.length],
          })),
        ),
      };
      await new ProcessingMessageHandler(repository, [
        new EmbeddingGenerationHandler(db, provider, data.config),
      ]).handle(data.message, false);
      const job = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: data.run.id, jobType: 'INDEX_VECTORS' },
      });
      const index = await db.versionVectorIndex.findUniqueOrThrow({
        where: { id: job.vectorIndexId! },
      });
      const scope: VectorScope = {
        collectionName: index.collectionName,
        indexManifestId: index.id,
        embeddingProfileId: data.profile.id,
        embeddingProfileVersion: 1,
        userId: data.user.id,
        documentId: data.document.id,
        documentVersionId: data.version.id,
        chunkSetId: index.chunkSetId,
      };
      return { ...data, job, index, scope, provider };
    }
    function router(boundary: VectorStore = store) {
      return new ProcessingMessageHandler(repository, [
        new VectorIndexHandler(db, boundary, settings),
        new VectorRemovalHandler(db, boundary),
      ]);
    }
    async function archive(userId: string, documentId: string) {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM documents WHERE id=${documentId}::uuid FOR UPDATE`;
        await tx.document.update({
          where: { id: documentId },
          data: { isArchived: true, status: 'ARCHIVED' },
        });
        await repository.cancelUnfinishedForDocument(
          tx,
          userId,
          documentId,
          new Date(),
        );
      });
    }
    function wrapped(overrides: Partial<VectorStore>): VectorStore {
      return {
        ensureCollection: store.ensureCollection.bind(store),
        upsert: store.upsert.bind(store),
        verify: store.verify.bind(store),
        count: store.count.bind(store),
        remove: store.remove.bind(store),
        ...overrides,
      };
    }
    async function finish(id: string, boundary: VectorStore = store) {
      expect(await router(boundary).handle(await envelope(id), false)).toBe(
        'ack',
      );
      expect(await repository.findById(id)).toMatchObject({
        status: 'COMPLETED',
        lastFailureCode: null,
      });
    }
    async function cleanup(versionId: string) {
      await repository.reconcilePipelines(new Date(), 100);
      const job = await db.processingJob.findFirstOrThrow({
        where: {
          documentVersionId: versionId,
          jobType: 'REMOVE_VECTOR_INDEX',
          status: 'PENDING',
        },
      });
      await finish(job.id);
    }
    it('indexes actual vectors with exact provenance, activates atomically and tolerates duplicate deliveries', async () => {
      const data = await prepared();
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
      await finish(data.job.id);
      const manifest = await db.versionVectorIndex.findUniqueOrThrow({
        where: { id: data.index.id },
      });
      expect(manifest).toMatchObject({
        status: 'READY',
        confirmedPointCount: data.chunks.length,
        checkpointOrdinal: data.chunks.length - 1,
      });
      expect(await store.count(data.scope)).toBe(data.chunks.length);
      const found = await admin.retrieve(data.scope.collectionName, {
        ids: [vectorPointId(data.chunks[0].id, data.profile.id, data.index.id)],
        with_vector: true,
        with_payload: true,
      });
      expect(found[0].payload).toEqual({
        ...Object.fromEntries(
          Object.entries(data.scope).filter(
            ([key]) => key !== 'collectionName',
          ),
        ),
        chunkId: data.chunks[0].id,
        ordinal: 0,
        payloadSchemaVersion: 1,
        pageNumbers: [1],
      });
      expect(await router().handle(await envelope(data.job.id), true)).toBe(
        'ack',
      );
      expect(await store.count(data.scope)).toBe(data.chunks.length);
      expect(
        await db.versionReadyIndex.findFirst({
          where: { vectorIndexId: data.index.id },
        }),
      ).not.toBeNull();
      expect(
        (
          await db.aiProcessingRun.findUniqueOrThrow({
            where: { id: data.run.id },
          })
        ).status,
      ).toBe('READY');
    });
    it('resumes partial confirmed batches, repairs a lost collection, and never activates on failure', async () => {
      const data = await prepared();
      let writes = 0;
      const failing = wrapped({
        upsert: async (scope, points) => {
          if (++writes === 2)
            throw new VectorStoreFailure('VECTOR_UNAVAILABLE', true);
          await store.upsert(scope, points);
        },
      });
      await router(failing).handle(await envelope(data.job.id), false);
      expect((await repository.findById(data.job.id))?.status).toBe('RETRYING');
      expect(
        (
          await db.versionVectorIndex.findUniqueOrThrow({
            where: { id: data.index.id },
          })
        ).confirmedPointCount,
      ).toBe(2);
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
      await admin.deleteCollection(data.scope.collectionName);
      const retry = await repository.findById(data.job.id);
      await repository.scheduleRetryDispatch(data.job.id, retry!.availableAt);
      await db.processingJob.update({
        where: { id: data.job.id },
        data: { availableAt: new Date() },
      });
      await finish(data.job.id);
      expect(await store.count(data.scope)).toBe(data.chunks.length);
    });
    it('rebuilds from durable artifacts without embedding calls and preserves the old index until activation', async () => {
      const data = await prepared();
      await finish(data.job.id);
      const calls = (data.provider.embed as jest.Mock).mock.calls.length;
      const replacement = await repository.requestVectorRebuild(
        data.user.id,
        data.index.id,
      );
      expect(
        (await repository.requestVectorRebuild(data.user.id, data.index.id)).id,
      ).toBe(replacement.id);
      const job = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: replacement.id, jobType: 'INDEX_VECTORS' },
      });
      expect(
        (
          await db.versionReadyIndex.findFirstOrThrow({
            where: { documentVersionId: data.version.id },
          })
        ).vectorIndexId,
      ).toBe(data.index.id);
      expect(
        await db.processingOutbox.count({
          where: {
            job: {
              aiRunId: replacement.id,
              jobType: {
                in: ['EXTRACT_TEXT', 'GENERATE_CHUNKS', 'GENERATE_EMBEDDINGS'],
              },
            },
          },
        }),
      ).toBe(0);
      await finish(job.id);
      expect((data.provider.embed as jest.Mock).mock.calls.length).toBe(calls);
      expect(
        (
          await db.versionReadyIndex.findFirstOrThrow({
            where: { documentVersionId: data.version.id },
          })
        ).vectorIndexId,
      ).toBe(job.vectorIndexId);
      expect(
        (
          await db.versionVectorIndex.findUniqueOrThrow({
            where: { id: data.index.id },
          })
        ).status,
      ).toBe('REMOVAL_PENDING');
      await cleanup(data.version.id);
      expect(await store.count(data.scope)).toBe(0);
      const newIndex = await db.versionVectorIndex.findUniqueOrThrow({
        where: { id: job.vectorIndexId! },
      });
      expect(
        await store.count({ ...data.scope, indexManifestId: newIndex.id }),
      ).toBe(data.chunks.length);
      await expect(
        repository.requestVectorRebuild(randomUUID(), newIndex.id),
      ).rejects.toThrow('INELIGIBLE_DOCUMENT');
    });
    it('rebuilds after Qdrant collection loss using the persisted vectors only', async () => {
      const data = await prepared();
      await finish(data.job.id);
      await admin.deleteCollection(data.scope.collectionName);
      const replacement = await repository.requestVectorRebuild(
        data.user.id,
        data.index.id,
      );
      const job = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: replacement.id, jobType: 'INDEX_VECTORS' },
      });
      await finish(job.id);
      expect(
        await store.count({
          ...data.scope,
          indexManifestId: job.vectorIndexId!,
        }),
      ).toBe(data.chunks.length);
    });
    it('archive revokes eligibility before remote deletion and periodic cleanup catches late writes', async () => {
      const data = await prepared();
      await finish(data.job.id);
      const point = (
        await admin.retrieve(data.scope.collectionName, {
          ids: [
            vectorPointId(data.chunks[0].id, data.profile.id, data.index.id),
          ],
          with_vector: true,
          with_payload: true,
        })
      )[0];
      await archive(data.user.id, data.document.id);
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
      expect(await store.count(data.scope)).toBe(data.chunks.length);
      await cleanup(data.version.id);
      await admin.upsert(data.scope.collectionName, {
        wait: true,
        points: [
          {
            id: point.id,
            vector: point.vector as number[],
            payload: point.payload,
          },
        ],
      });
      expect(await store.count(data.scope)).toBe(1);
      await repository.reconcilePipelines(new Date(Date.now() + 601000), 100);
      const next = await db.processingJob.findFirstOrThrow({
        where: {
          documentVersionId: data.version.id,
          jobType: 'REMOVE_VECTOR_INDEX',
          status: 'PENDING',
        },
      });
      await db.processingJob.update({
        where: { id: next.id },
        data: { availableAt: new Date() },
      });
      await finish(next.id);
      expect(await store.count(data.scope)).toBe(0);
    });
    it('cleanup is manifest-scoped and does not delete another owner even in the same collection', async () => {
      const data = await prepared();
      await finish(data.job.id);
      const foreignScope = {
        ...data.scope,
        userId: randomUUID(),
        indexManifestId: randomUUID(),
      };
      const chunkId = randomUUID();
      const { collectionName: _collection, ...payload } = foreignScope;
      void _collection;
      const foreign: VectorPoint = {
        id: vectorPointId(
          chunkId,
          data.profile.id,
          foreignScope.indexManifestId,
        ),
        vector: [1, 2, 3],
        payload: {
          ...payload,
          chunkId,
          ordinal: 0,
          pageNumbers: [1],
          payloadSchemaVersion: 1,
        },
      };
      await store.upsert(foreignScope, [foreign]);
      await store.remove(data.scope);
      expect(await store.count(foreignScope)).toBe(1);
      expect(await store.count(data.scope)).toBe(0);
      await store.remove(data.scope);
      expect(await store.count(foreignScope)).toBe(1);
    });
    it('refuses incompatible collections without recreating them', async () => {
      const data = await prepared();
      await admin.createCollection(data.scope.collectionName, {
        vectors: { size: 4, distance: 'Dot' },
      });
      await router().handle(await envelope(data.job.id), false);
      expect(await repository.findById(data.job.id)).toMatchObject({
        status: 'FAILED',
        lastFailureCode: 'VECTOR_COLLECTION_INCOMPATIBLE',
      });
      expect(
        (await admin.getCollection(data.scope.collectionName)).config.params
          .vectors,
      ).toMatchObject({ size: 4, distance: 'Dot' });
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
    });
    it('stale workers cannot commit after archive during a remote write', async () => {
      const data = await prepared();
      const boundary = wrapped({
        upsert: async (scope, points) => {
          await archive(data.user.id, data.document.id);
          await store.upsert(scope, points);
        },
      });
      await router(boundary).handle(await envelope(data.job.id), false);
      expect((await repository.findById(data.job.id))?.status).toBe(
        'CANCELLED',
      );
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
      await cleanup(data.version.id);
      expect(await store.count(data.scope)).toBe(0);
    });
    it('worker crash after remote persistence resumes the same IDs under a new lease', async () => {
      const data = await prepared();
      const claimed = await repository.claim(data.job.id, new Date(), 120000);
      const result = await new VectorIndexHandler(db, store, settings).execute({
        jobId: claimed.id,
        documentId: claimed.documentId,
        documentVersionId: claimed.documentVersionId,
        leaseToken: claimed.leaseToken!,
        attempt: claimed.attempts,
      });
      expect(result.kind).toBe('success');
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
      await db.processingJob.update({
        where: { id: claimed.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      await repository.recoverInterrupted(
        claimed.id,
        claimed.leaseToken!,
        new Date(),
      );
      const retry = await repository.findById(claimed.id);
      await repository.scheduleRetryDispatch(claimed.id, retry!.availableAt);
      await db.processingJob.update({
        where: { id: claimed.id },
        data: { availableAt: new Date() },
      });
      await finish(claimed.id);
      expect(await store.count(data.scope)).toBe(data.chunks.length);
    });
    it('replays exhausted cleanup without restoring eligibility and permits safe post-cleanup purge', async () => {
      const data = await prepared();
      await finish(data.job.id);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM documents WHERE id=${data.document.id}::uuid FOR UPDATE`;
        await tx.document.update({
          where: { id: data.document.id },
          data: { deletedAt: new Date(), status: 'DELETING' },
        });
        await repository.cancelUnfinishedForDocument(
          tx,
          data.user.id,
          data.document.id,
          new Date(),
        );
      });
      const removal = await db.processingJob.findFirstOrThrow({
        where: { vectorIndexId: data.index.id, jobType: 'REMOVE_VECTOR_INDEX' },
      });
      await db.processingJob.update({
        where: { id: removal.id },
        data: { maxAttempts: 1 },
      });
      await router(
        wrapped({
          remove: async () => {
            throw new VectorStoreFailure('VECTOR_UNAVAILABLE', true);
          },
        }),
      ).handle(await envelope(removal.id), false);
      expect((await repository.findById(removal.id))?.status).toBe('FAILED');
      await expect(
        repository.replayVectorRemoval(randomUUID(), data.index.id),
      ).rejects.toThrow('INELIGIBLE_DOCUMENT');
      const replay = await repository.replayVectorRemoval(
        data.user.id,
        data.index.id,
      );
      expect(replay!.generation).toBe(removal.generation + 1);
      await finish(replay!.id);
      expect(await store.count(data.scope)).toBe(0);
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
      await db.document.delete({ where: { id: data.document.id } });
      expect(await store.count(data.scope)).toBe(0);
    });
    it('new versions revoke and clean old points while restore does not silently reactivate them', async () => {
      const data = await prepared();
      await finish(data.job.id);
      await archive(data.user.id, data.document.id);
      await cleanup(data.version.id);
      await db.document.update({
        where: { id: data.document.id },
        data: { isArchived: false, status: 'ACTIVE' },
      });
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
      const rebuilt = await repository.requestVectorRebuild(
        data.user.id,
        data.index.id,
      );
      const rebuiltJob = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: rebuilt.id, jobType: 'INDEX_VECTORS' },
      });
      await finish(rebuiltJob.id);
      const version = await db.documentVersion.create({
        data: {
          userId: data.user.id,
          documentId: data.document.id,
          versionNumber: 2,
          originalFilename: 'new.pdf',
          storageKey: `fixture/${randomUUID()}`,
          mimeType: 'application/pdf',
          fileSize: 10,
          pageCount: 1,
          checksumSha256: hashText('new'),
        },
      });
      await repository.create({
        userId: data.user.id,
        documentId: data.document.id,
        documentVersionId: version.id,
        maxAttempts: 3,
        correlationId: randomUUID(),
      });
      expect(
        await db.versionReadyIndex.count({
          where: { documentId: data.document.id },
        }),
      ).toBe(0);
      await cleanup(data.version.id);
      expect(
        await store.count({
          ...data.scope,
          indexManifestId: rebuiltJob.vectorIndexId!,
        }),
      ).toBe(0);
      await expect(
        repository.requestVectorRebuild(data.user.id, data.index.id),
      ).rejects.toThrow('INELIGIBLE_DOCUMENT');
    });
    (process.env.TEST_RABBITMQ_URL ? it : it.skip)(
      'indexes duplicate live RabbitMQ deliveries with one activation',
      async () => {
        const data = await prepared();
        const consumer = new RabbitMqConsumer(router(), {
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
          const message = await envelope(data.job.id);
          await Promise.all([
            publisher.publishProcessing(message),
            publisher.publishProcessing(message),
          ]);
          for (
            let i = 0;
            i < 200 &&
            (await repository.findById(data.job.id))?.status !== 'COMPLETED';
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 50));
          expect(await repository.findById(data.job.id)).toMatchObject({
            status: 'COMPLETED',
            attempts: 1,
          });
          expect(await store.count(data.scope)).toBe(data.chunks.length);
          expect(
            await db.versionReadyIndex.count({
              where: { vectorIndexId: data.index.id },
            }),
          ).toBe(1);
        } finally {
          await consumer.stop();
          await publisher.onApplicationShutdown();
        }
      },
    );
    it('sanitizes outages and rejects activation when verification is incomplete', async () => {
      const data = await prepared();
      const offline = new QdrantVectorStore({
        ...settings,
        url: 'http://127.0.0.1:1',
        timeoutMs: 100,
      });
      await router(offline).handle(await envelope(data.job.id), false);
      expect(await repository.findById(data.job.id)).toMatchObject({
        status: 'RETRYING',
        lastFailureCode: 'VECTOR_UNAVAILABLE',
      });
      expect(
        await db.versionReadyIndex.count({
          where: { documentVersionId: data.version.id },
        }),
      ).toBe(0);
    });
  },
);
