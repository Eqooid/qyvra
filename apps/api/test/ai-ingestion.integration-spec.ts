import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import {
  createPrismaClient,
  embeddingProfileFingerprint,
  ProcessingRepository,
  type PrismaClient,
  type ProcessingMessage,
} from '@qyvra/database';
import { LocalFileStorage } from '@qyvra/storage';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings as configurationToken } from '../src/configuration/configuration.module';
import { createTestOwner } from './owner.fixture';
import { ConfigurationService } from '../src/configuration/configuration.module';
import { validateEnvironment } from '../src/configuration/environment';
import { PrismaService } from '../src/database/prisma.service';
import { AiIngestionService } from '../src/modules/ai/ai-ingestion.service';
import { UploadRepository } from '../src/modules/documents/upload.repository';
import { DocumentsService } from '../src/modules/documents/documents.service';
import { DeterministicChunker } from '../src/modules/ai/deterministic-chunker';
import { IsolatedPdfParser } from '../src/infrastructure/extraction/pdf-parser';
import { StoredFileIntegrityHandler } from '../src/infrastructure/worker/stored-file-integrity.handler';
import { PdfTextExtractionHandler } from '../src/infrastructure/worker/pdf-text-extraction.handler';
import { ChunkGenerationHandler } from '../src/infrastructure/worker/chunk-generation.handler';
import { EmbeddingGenerationHandler } from '../src/infrastructure/worker/embedding-generation.handler';
import { VectorIndexHandler } from '../src/infrastructure/worker/vector-index.handler';
import { VectorRemovalHandler } from '../src/infrastructure/worker/vector-removal.handler';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import { QdrantVectorStore } from '../src/infrastructure/vectors/qdrant-vector-store';
import type { EmbeddingRequest } from '../src/modules/ai/embedding-provider';

const url = process.env.TEST_DATABASE_URL;
const storageRoot = resolve(tmpdir(), 'qyvra-t08-tests', randomUUID());
jest.setTimeout(60000);
(url ? describe : describe.skip)(
  'canonical AI ingestion scheduling (PostgreSQL)',
  () => {
    let db: PrismaClient, repository: ProcessingRepository;
    const users: string[] = [],
      profiles: string[] = [],
      keys: string[] = [];
    const storage = new LocalFileStorage(storageRoot);
    beforeAll(async () => {
      if (!url || !/test/i.test(new URL(url).pathname))
        throw Error('Disposable database required');
      db = createPrismaClient({
        url,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 10000,
        poolSize: 5,
      });
      repository = new ProcessingRepository(db);
      await db.$connect();
    });
    afterAll(async () => {
      try {
        await db.document.deleteMany({ where: { userId: { in: users } } });
        await db.documentUpload.deleteMany({
          where: { userId: { in: users } },
        });
        await db.authSession.deleteMany({ where: { userId: { in: users } } });
        await db.user.deleteMany({ where: { id: { in: users } } });
        await db.embeddingProfile.deleteMany({
          where: { id: { in: profiles } },
        });
        for (const key of keys) await storage.delete(key);
      } finally {
        await db.$disconnect();
      }
    });
    async function fixture(file = 'single.pdf') {
      const bytes = await readFile(resolve(__dirname, 'fixtures/pdf', file));
      const user = await db.user.create({
        data: { email: `${randomUUID()}@example.invalid` },
      });
      users.push(user.id);
      const identity = {
        provider: 'test',
        model: randomUUID(),
        modelRevision: 'v1',
        dimensions: 3,
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
      const settings = validateEnvironment({
        DATABASE_URL: url,
        LOCAL_STORAGE_ROOT: storageRoot,
        AI_INGESTION_ENABLED: 'true',
        AI_INGESTION_PROFILE_FINGERPRINT: profile.fingerprint,
        CHUNK_SIZE_TOKENS: '32',
        CHUNK_OVERLAP_TOKENS: '8',
      });
      const configuration = new ConfigurationService(settings);
      const prisma = new PrismaService(db);
      const scheduler = new AiIngestionService(prisma, configuration);
      const uploads = new UploadRepository(prisma, configuration, scheduler);
      const documents = new DocumentsService(prisma, scheduler);
      const provider = {
        embed: jest.fn(async (request: EmbeddingRequest) =>
          request.inputs.map((input) => ({
            id: input.id,
            vector: [1, 2, input.text.length],
          })),
        ),
      };
      const vectorConfig = {
        enabled: true,
        url: process.env.TEST_QDRANT_URL,
        timeoutMs: 5000,
        batchSize: 2,
      };
      const store = new QdrantVectorStore(vectorConfig);
      const worker = new ProcessingMessageHandler(repository, [
        new StoredFileIntegrityHandler(db, storage, 10000),
        new PdfTextExtractionHandler(
          db,
          storage,
          new IsolatedPdfParser(settings.extraction),
          settings.extraction,
        ),
        new ChunkGenerationHandler(
          db,
          new DeterministicChunker(),
          settings.chunking,
        ),
        new EmbeddingGenerationHandler(db, provider, {
          ...settings.embedding,
          enabled: true,
          profileFingerprint: profile.fingerprint,
        }),
        new VectorIndexHandler(db, store, vectorConfig),
        new VectorRemovalHandler(db, store),
      ]);
      async function upload(
        documentId = randomUUID(),
        scope = 'create',
        pdf = bytes,
      ) {
        const key = randomUUID(),
          versionId = randomUUID();
        const reservation = await uploads.reserve(user.id, key, scope);
        const storageKey = `documents/${user.id}/${documentId}/${versionId}/original.pdf`;
        await storage.save(storageKey, Readable.from([pdf]));
        keys.push(storageKey);
        const file = {
          key: storageKey,
          filename: fileName(pdf),
          mime: 'application/pdf',
          size: pdf.length,
          checksum: createHash('sha256').update(pdf).digest('hex'),
          dto: { title: 'AI ingestion PDF' },
        };
        const result = await uploads.complete(
          user.id,
          key,
          reservation.attemptId,
          documentId,
          versionId,
          file,
          1,
          scope,
          randomUUID(),
        );
        return { documentId, versionId, key, reservation, file, result, scope };
      }
      return {
        user,
        profile,
        scheduler,
        uploads,
        documents,
        provider,
        worker,
        upload,
        prisma,
        configuration,
      };
    }
    function fileName(bytes: Buffer) {
      return `fixture-${bytes.length}.pdf`;
    }
    async function execute(worker: ProcessingMessageHandler, jobId: string) {
      const event = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: jobId },
        orderBy: { dispatchSequence: 'desc' },
      });
      expect(
        await worker.handle(
          event.payload as unknown as ProcessingMessage,
          false,
        ),
      ).toBe('ack');
      expect(await repository.findById(jobId)).toMatchObject({
        status: 'COMPLETED',
      });
    }
    async function drain(worker: ProcessingMessageHandler, versionId: string) {
      for (let i = 0; i < 12; i++) {
        const job = await db.processingJob.findFirst({
          where: {
            documentVersionId: versionId,
            status: { in: ['PENDING', 'QUEUED'] },
          },
          orderBy: { createdAt: 'asc' },
        });
        if (!job) return;
        await execute(worker, job.id);
      }
      throw Error('Pipeline did not drain within its bounded stage count');
    }

    it('atomically enrolls upload, reuses receipt and coalesces concurrent requests without AI work in HTTP', async () => {
      const f = await fixture();
      const u = await f.upload();
      expect(
        await db.aiProcessingRun.count({
          where: { documentVersionId: u.versionId },
        }),
      ).toBe(1);
      expect(
        await db.processingJob.count({
          where: { documentVersionId: u.versionId },
        }),
      ).toBe(1);
      expect(f.provider.embed).not.toHaveBeenCalled();
      const replay = await f.uploads.complete(
        f.user.id,
        u.key,
        u.reservation.attemptId,
        u.documentId,
        u.versionId,
        u.file,
        1,
        u.scope,
        randomUUID(),
      );
      expect(replay.replay).toBe(true);
      const key = randomUUID();
      const receipts = await Promise.all([
        f.scheduler.reprocess(
          f.user.id,
          u.documentId,
          u.versionId,
          'repair',
          key,
        ),
        f.scheduler.reprocess(
          f.user.id,
          u.documentId,
          u.versionId,
          'repair',
          key,
        ),
      ]);
      expect(receipts[0]).toEqual(receipts[1]);
      expect(
        await db.aiProcessingRun.count({
          where: { documentVersionId: u.versionId },
        }),
      ).toBe(1);
      await expect(
        f.scheduler.reprocess(
          f.user.id,
          u.documentId,
          u.versionId,
          'index',
          key,
        ),
      ).rejects.toThrow('different mode');
      await expect(
        f.scheduler.reprocess(
          randomUUID(),
          u.documentId,
          u.versionId,
          'repair',
          randomUUID(),
        ),
      ).rejects.toThrow();
    });

    it('exposes the authenticated CSRF-protected 202 route with strict DTOs and owned receipts', async () => {
      const f = await fixture();
      const u = await f.upload();
      const owner = await createTestOwner(f.prisma, users);
      const config = validateEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: url,
        LOCAL_STORAGE_ROOT: storageRoot,
        AI_INGESTION_ENABLED: 'true',
        AI_INGESTION_PROFILE_FINGERPRINT: f.profile.fingerprint,
        CHUNK_SIZE_TOKENS: '32',
        CHUNK_OVERLAP_TOKENS: '8',
      });
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(configurationToken.KEY)
        .useValue(config)
        .compile();
      const app = module.createNestApplication();
      configureApplication(app, config);
      await app.init();
      try {
        // Create a session for the actual document owner, without changing ownership.
        const { randomBytes } = await import('node:crypto');
        const token = randomBytes(32).toString('base64url');
        await db.authSession.create({
          data: {
            userId: f.user.id,
            tokenHash: createHash('sha256').update(token).digest('hex'),
            createdAt: new Date(Date.now() - 60000),
            expiresAt: new Date(Date.now() + 3600000),
            lastSeenAt: new Date(),
          },
        });
        const cookie = `document_tracker_session=${token}`;
        const path = `/api/v1/documents/${u.documentId}/versions/${u.versionId}/ai/reprocess`;
        const call = () =>
          request(app.getHttpServer())
            .post(path)
            .set('Cookie', cookie)
            .set('X-CSRF-Protection', '1')
            .set('Idempotency-Key', randomUUID());
        await request(app.getHttpServer()).post(path).send({}).expect(401);
        await request(app.getHttpServer())
          .post(path)
          .set('Cookie', cookie)
          .send({})
          .expect(403);
        await call().send({ userId: owner.id }).expect(400);
        await call().send({ mode: 'rag' }).expect(400);
        await request(app.getHttpServer())
          .post(path)
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Protection', '1')
          .set('Idempotency-Key', randomUUID())
          .send({})
          .expect(404);
        const key = randomUUID();
        const first = await request(app.getHttpServer())
          .post(path)
          .set('Cookie', cookie)
          .set('X-CSRF-Protection', '1')
          .set('Idempotency-Key', key)
          .send({})
          .expect(202);
        const duplicate = await request(app.getHttpServer())
          .post(path)
          .set('Cookie', cookie)
          .set('X-CSRF-Protection', '1')
          .set('Idempotency-Key', key)
          .send({})
          .expect(202);
        expect(duplicate.body.data).toEqual(first.body.data);
        expect(Object.keys(first.body.data).sort()).toEqual([
          'generation',
          'runId',
          'status',
        ]);
      } finally {
        await app.close();
      }
    });

    it('rolls enrollment back with its document transaction; unsupported originals remain integrity-only', async () => {
      const f = await fixture();
      const document = await db.document.create({
        data: { userId: f.user.id, title: 'legacy' },
      });
      const version = await db.documentVersion.create({
        data: {
          documentId: document.id,
          userId: f.user.id,
          versionNumber: 1,
          originalFilename: 'image.png',
          mimeType: 'image/png',
          storageKey: 'fixture/image.png',
          fileSize: 10,
          checksumSha256: createHash('sha256')
            .update(randomUUID())
            .digest('hex'),
        },
      });
      expect(
        await db.$transaction((tx) =>
          f.scheduler.scheduleInTransaction(
            tx,
            f.user.id,
            document.id,
            version.id,
          ),
        ),
      ).toBeNull();
      const pdfVersion = await db.documentVersion.create({
        data: {
          userId: f.user.id,
          documentId: document.id,
          versionNumber: 2,
          originalFilename: 'legacy.pdf',
          mimeType: 'application/pdf',
          storageKey: 'fixture/legacy.pdf',
          fileSize: 10,
          pageCount: 1,
          checksumSha256: createHash('sha256')
            .update(randomUUID())
            .digest('hex'),
        },
      });
      await expect(
        db.$transaction(async (tx) => {
          await f.scheduler.scheduleInTransaction(
            tx,
            f.user.id,
            document.id,
            pdfVersion.id,
          );
          throw Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        await db.aiProcessingRun.count({
          where: { documentVersionId: pdfVersion.id },
        }),
      ).toBe(0);
      expect(
        await db.processingOutbox.count({
          where: { job: { documentVersionId: pdfVersion.id } },
        }),
      ).toBe(0);
    });

    it('backfill dry-run, keyset resume, skips archived/deleted/unsupported/historical and is rerunnable', async () => {
      const f = await fixture();
      const legacy: { id: string }[] = [];
      for (let i = 0; i < 5; i++) {
        const document = await db.document.create({
          data: {
            userId: f.user.id,
            title: 'legacy',
            ...(i === 2 ? { isArchived: true, status: 'ARCHIVED' } : {}),
            ...(i === 3 ? { deletedAt: new Date() } : {}),
          },
        });
        const version = await db.documentVersion.create({
          data: {
            documentId: document.id,
            userId: f.user.id,
            versionNumber: 1,
            originalFilename: 'legacy.pdf',
            mimeType: i === 4 ? 'image/png' : 'application/pdf',
            pageCount: i === 4 ? null : 1,
            storageKey: `fixture/${randomUUID()}.pdf`,
            fileSize: 10,
            checksumSha256: createHash('sha256')
              .update(randomUUID())
              .digest('hex'),
          },
        });
        legacy.push(version);
      }
      // Other tests leave eligible documents: inspect only this fixture's IDs.
      const dry = await f.scheduler.backfillBatch(100, undefined, true);
      expect(
        dry.results.filter((r) => legacy.some((v) => v.id === r.versionId)),
      ).toHaveLength(2);
      expect(
        await db.aiProcessingRun.count({
          where: { documentVersionId: { in: legacy.map((v) => v.id) } },
        }),
      ).toBe(0);
      let cursor: string | undefined;
      const scanned: string[] = [];
      for (let i = 0; i < 20; i++) {
        const batch = await f.scheduler.backfillBatch(2, cursor);
        scanned.push(...batch.results.map((r) => r.versionId));
        if (!batch.hasMore) break;
        cursor = batch.cursor!;
      }
      expect(new Set(scanned).size).toBe(scanned.length);
      await Promise.all([
        f.scheduler.backfillBatch(100),
        f.scheduler.backfillBatch(100),
      ]);
      for (const version of legacy.slice(0, 2))
        expect(
          await db.aiProcessingRun.count({
            where: { documentVersionId: version.id },
          }),
        ).toBe(1);
      await expect(f.scheduler.backfillBatch(101)).rejects.toThrow();
    });

    it('backfill does not reset deterministic no-text extraction failures', async () => {
      const f = await fixture('image-only.pdf');
      const u = await f.upload();
      const integrity = await db.processingJob.findFirstOrThrow({
        where: {
          documentVersionId: u.versionId,
          jobType: 'VERIFY_STORED_FILE',
        },
      });
      await execute(f.worker, integrity.id);
      const extraction = await db.processingJob.findFirstOrThrow({
        where: { documentVersionId: u.versionId, jobType: 'EXTRACT_TEXT' },
      });
      const event = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: extraction.id },
      });
      expect(
        await f.worker.handle(
          event.payload as unknown as ProcessingMessage,
          false,
        ),
      ).toBe('ack');
      expect(await repository.findById(extraction.id)).toMatchObject({
        status: 'FAILED',
      });
      await f.scheduler.backfillBatch(100);
      expect(
        await db.aiProcessingRun.count({
          where: { documentVersionId: u.versionId },
        }),
      ).toBe(1);
      expect(
        await db.processingJob.count({
          where: { documentVersionId: u.versionId, jobType: 'GENERATE_CHUNKS' },
        }),
      ).toBe(0);
    });

    (process.env.TEST_QDRANT_URL ? it : it.skip)(
      'real legacy PDF backfill → activation → archive/restore reuse → owned reindex → replacement/cleanup → new version → soft delete/restore',
      async () => {
        const f = await fixture();
        // Legacy upload uses the existing integrity-only boundary, with identical real storage.
        const oldUploads = new UploadRepository(f.prisma, f.configuration);
        const documentId = randomUUID(),
          versionId = randomUUID(),
          key = randomUUID();
        const bytes = await readFile(
          resolve(__dirname, 'fixtures/pdf/single.pdf'),
        );
        const storageKey = `documents/${f.user.id}/${documentId}/${versionId}/original.pdf`;
        await storage.save(storageKey, Readable.from([bytes]));
        keys.push(storageKey);
        const reservation = await oldUploads.reserve(f.user.id, key);
        await oldUploads.complete(
          f.user.id,
          key,
          reservation.attemptId,
          documentId,
          versionId,
          {
            key: storageKey,
            filename: 'legacy.pdf',
            mime: 'application/pdf',
            size: bytes.length,
            checksum: createHash('sha256').update(bytes).digest('hex'),
            dto: { title: 'legacy' },
          },
          1,
          'create',
          randomUUID(),
        );
        expect(
          await db.aiProcessingRun.count({
            where: { documentVersionId: versionId },
          }),
        ).toBe(0);
        await f.scheduler.backfillBatch(100);
        await drain(f.worker, versionId);
        const original = await db.versionReadyIndex.findFirstOrThrow({
          where: { documentVersionId: versionId },
        });
        expect(f.provider.embed).toHaveBeenCalled();
        const providerCalls = f.provider.embed.mock.calls.length;
        const sourceChunks = await db.documentChunk.findMany({
          where: { documentVersionId: versionId },
        });
        expect(sourceChunks.length).toBeGreaterThan(0);
        await f.documents.transition(f.user.id, documentId, 'archive');
        expect(
          await db.versionReadyIndex.count({
            where: { documentVersionId: versionId },
          }),
        ).toBe(0);
        // Restore before old cleanup finishes: new manifest cannot be deleted by old cleanup.
        await f.documents.transition(f.user.id, documentId, 'restore');
        const restoredRun = await db.aiProcessingRun.findFirstOrThrow({
          where: { documentVersionId: versionId },
          orderBy: { generation: 'desc' },
        });
        const reusedJobs = await db.processingJob.findMany({
          where: { aiRunId: restoredRun.id },
          orderBy: { createdAt: 'asc' },
        });
        expect(reusedJobs.filter((j) => j.status === 'COMPLETED')).toHaveLength(
          3,
        );
        expect(reusedJobs.find((j) => j.status === 'PENDING')?.jobType).toBe(
          'INDEX_VECTORS',
        );
        await drain(f.worker, versionId);
        const restored = await db.versionReadyIndex.findFirstOrThrow({
          where: { documentVersionId: versionId },
        });
        expect(restored.vectorIndexId).not.toBe(original.vectorIndexId);
        expect(f.provider.embed.mock.calls.length).toBe(providerCalls);
        const requestKey = randomUUID();
        const receipt = await f.scheduler.reprocess(
          f.user.id,
          documentId,
          versionId,
          'index',
          requestKey,
        );
        expect(
          (
            await db.versionReadyIndex.findFirstOrThrow({
              where: { documentVersionId: versionId },
            })
          ).vectorIndexId,
        ).toBe(restored.vectorIndexId);
        await drain(f.worker, versionId);
        expect(
          (
            await f.scheduler.reprocess(
              f.user.id,
              documentId,
              versionId,
              'index',
              requestKey,
            )
          )?.runId,
        ).toBe(receipt?.runId);
        expect(f.provider.embed.mock.calls.length).toBe(providerCalls);
        expect(
          await db.documentChunk.count({
            where: { documentVersionId: versionId },
          }),
        ).toBe(sourceChunks.length);
        for (const [mode, expected] of [
          ['extraction', 'EXTRACT_TEXT'],
          ['chunking', 'GENERATE_CHUNKS'],
          ['embedding', 'GENERATE_EMBEDDINGS'],
        ] as const) {
          const requested = await f.scheduler.reprocess(
            f.user.id,
            documentId,
            versionId,
            mode,
            randomUUID(),
          );
          expect(
            (
              await db.processingJob.findFirstOrThrow({
                where: { aiRunId: requested!.runId, status: 'PENDING' },
              })
            ).jobType,
          ).toBe(expected);
          await expect(
            f.scheduler.reprocess(
              f.user.id,
              documentId,
              versionId,
              'index',
              randomUUID(),
            ),
          ).rejects.toThrow('already active');
          await drain(f.worker, versionId);
          expect(f.provider.embed.mock.calls.length).toBe(providerCalls);
        }
        const changedSettings = validateEnvironment({
          DATABASE_URL: url,
          LOCAL_STORAGE_ROOT: storageRoot,
          AI_INGESTION_ENABLED: 'true',
          AI_INGESTION_PROFILE_FINGERPRINT: f.profile.fingerprint,
          CHUNK_SIZE_TOKENS: '16',
          CHUNK_OVERLAP_TOKENS: '4',
        });
        const changedScheduler = new AiIngestionService(
          f.prisma,
          new ConfigurationService(changedSettings),
        );
        const changed = await changedScheduler.reprocess(
          f.user.id,
          documentId,
          versionId,
          'repair',
          randomUUID(),
        );
        expect(
          (
            await db.processingJob.findFirstOrThrow({
              where: { aiRunId: changed!.runId, status: 'PENDING' },
            })
          ).jobType,
        ).toBe('GENERATE_CHUNKS');
        const changedVector = {
          enabled: true,
          url: process.env.TEST_QDRANT_URL,
          timeoutMs: 5000,
          batchSize: 2,
        };
        const changedStore = new QdrantVectorStore(changedVector);
        const changedWorker = new ProcessingMessageHandler(repository, [
          new ChunkGenerationHandler(
            db,
            new DeterministicChunker(),
            changedSettings.chunking,
          ),
          new EmbeddingGenerationHandler(db, f.provider, {
            ...changedSettings.embedding,
            enabled: true,
            profileFingerprint: f.profile.fingerprint,
          }),
          new VectorIndexHandler(db, changedStore, changedVector),
          new VectorRemovalHandler(db, changedStore),
        ]);
        await drain(changedWorker, versionId);
        expect(
          await db.extractedText.count({
            where: { documentVersionId: versionId },
          }),
        ).toBe(1);
        expect(
          await db.chunkSet.count({ where: { documentVersionId: versionId } }),
        ).toBe(2);
        expect(f.provider.embed.mock.calls.length).toBeGreaterThan(
          providerCalls,
        );
        const second = await f.upload(
          documentId,
          `versions:${documentId}`,
          await readFile(resolve(__dirname, 'fixtures/pdf/multi.pdf')),
        );
        expect(
          await db.versionReadyIndex.count({
            where: { documentVersionId: versionId },
          }),
        ).toBe(0);
        await expect(
          f.scheduler.reprocess(
            f.user.id,
            documentId,
            versionId,
            'repair',
            randomUUID(),
          ),
        ).rejects.toThrow('not eligible');
        await drain(f.worker, second.versionId);
        await drain(f.worker, versionId);
        await f.documents.transition(f.user.id, documentId, 'delete');
        expect(
          await db.versionReadyIndex.count({ where: { documentId } }),
        ).toBe(0);
        await f.documents.transition(f.user.id, documentId, 'restore');
        await drain(f.worker, second.versionId);
        expect(
          await db.versionReadyIndex.count({
            where: { documentVersionId: second.versionId },
          }),
        ).toBe(1);
        await f.documents.transition(f.user.id, documentId, 'delete');
        await drain(f.worker, second.versionId);
      },
    );
  },
);
