import { ProcessingStatusRepository } from '../src/modules/documents/processing-status.repository';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigurationService } from '../src/configuration/configuration.module';
import { PdfTextExtractionHandler } from '../src/infrastructure/worker/pdf-text-extraction.handler';
import { Client } from '@elastic/elasticsearch';
import { readFileSync } from 'node:fs';
import { ElasticsearchStore } from '../src/infrastructure/search/elasticsearch-store';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  createPrismaClient,
  PrismaClient,
  ProcessingRepository,
  SearchEnrollmentRepository,
  SearchPersistenceRepository,
  searchGenerationFingerprint,
  embeddingProfileFingerprint,
  type ProcessingMessage,
} from '@qyvra/database';
import type { Storage } from '@qyvra/storage';
import { validateTestEnvironment } from './configuration.fixture';
import {
  PDF_EXTRACTOR,
  IsolatedPdfParser,
} from '../src/infrastructure/extraction/pdf-parser';
import { SearchIndexHandler } from '../src/infrastructure/worker/search-index.handler';
import { SearchTextExtractionHandler } from '../src/infrastructure/worker/search-text-extraction.handler';
import { StoredFileIntegrityHandler } from '../src/infrastructure/worker/stored-file-integrity.handler';
import {
  ProcessingMessageHandler,
  type ProcessingJobHandler,
} from '../src/infrastructure/worker/processing-message-handler';
import {
  SearchStoreFailure,
  type LexicalStore,
  type SearchRecord,
} from '../src/infrastructure/search/lexical-store';
import {
  indexName,
  recordId,
  SEARCH_MAPPING_VERSION,
  SEARCH_ANALYZER_VERSION,
  SEARCH_SEGMENTATION_VERSION,
} from '../src/infrastructure/search/search-index';

const url = process.env.TEST_DATABASE_URL;
const limits = {
  maxBytes: 52428800,
  maxPages: 500,
  maxCharacters: 5000000,
  maxTextBytes: 20000000,
  timeoutMs: 10000,
  heapMb: 256,
};
const config = validateTestEnvironment({
  DATABASE_URL: 'postgresql://localhost/search_test',
  ELASTICSEARCH_ENABLED: 'true',
  ELASTICSEARCH_URL: 'http://127.0.0.1:9200',
  ELASTICSEARCH_ALLOW_HTTP: 'true',
  ELASTICSEARCH_USERNAME: 'fixture',
  ELASTICSEARCH_PASSWORD: 'synthetic-fixture-password',
}).elasticsearch;

(url ? describe : describe.skip)(
  'lexical publication (real SQL/parser; simulated search transport)',
  () => {
    let db: PrismaClient,
      repository: ProcessingRepository,
      enrollment: SearchEnrollmentRepository;
    const users: string[] = [],
      profiles: string[] = [],
      generations: string[] = [];
    beforeAll(async () => {
      if (!url || !/test/i.test(new URL(url).pathname))
        throw Error('Disposable test database required');
      db = createPrismaClient({
        url,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 15000,
        poolSize: 6,
      });
      repository = new ProcessingRepository(db);
      enrollment = new SearchEnrollmentRepository(db);
      await db.$connect();
    });
    afterEach(async () => {
      await db.document.deleteMany({ where: { userId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
      await db.embeddingProfile.deleteMany({
        where: { id: { in: profiles.splice(0) } },
      });
      await db.searchIndexGeneration.deleteMany({
        where: { id: { in: generations.splice(0) } },
      });
    });
    afterAll(async () => {
      await db.$disconnect();
    });
    async function fixture(file = 'multi.pdf', serving = true) {
      const bytes = await readFile(resolve(__dirname, 'fixtures/pdf', file));
      const user = await db.user.create({
        data: { email: `${randomUUID()}@example.invalid` },
      });
      users.push(user.id);
      const document = await db.document.create({
        data: { userId: user.id, title: 'Lexical fixture' },
      });
      const id = randomUUID();
      const version = await db.documentVersion.create({
        data: {
          id,
          userId: user.id,
          documentId: document.id,
          versionNumber: 1,
          originalFilename: file,
          storageKey: `documents/${user.id}/${document.id}/${id}/original.pdf`,
          mimeType: 'application/pdf',
          pageCount: 1,
          fileSize: bytes.length,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        },
      });
      const number = Math.floor(Math.random() * 100000000) + 1;
      const identity = {
        schemaVersion: 1,
        mappingVersion: SEARCH_MAPPING_VERSION,
        analyzerVersion: SEARCH_ANALYZER_VERSION,
        ...PDF_EXTRACTOR,
        segmentationVersion: SEARCH_SEGMENTATION_VERSION,
      };
      const fingerprint = searchGenerationFingerprint(identity);
      const target = { id: randomUUID(), generation: number, fingerprint };
      const gen = await new SearchPersistenceRepository(db).createGeneration({
        ...identity,
        generation: number,
        metadataIndexName: indexName(config.indexPrefix, target, 'metadata'),
        pageIndexName: indexName(config.indexPrefix, target, 'pages'),
      });
      generations.push(gen.id);
      if (serving)
        await db.searchIndexGeneration.update({
          where: { id: gen.id },
          data: { status: 'SERVING' },
        });
      const policy = { enabled: true, generationFingerprint: fingerprint };
      const projection = await db.$transaction((tx) =>
        enrollment.enrollInTransaction(tx, user.id, document.id, policy),
      );
      if (!projection) throw Error('Enrollment failed');
      const storage = {
        open: jest.fn(async () => Readable.from(bytes)),
      } as unknown as Storage;
      const remote = new Map<string, SearchRecord>();
      const store = {
        createIndexes: jest.fn(async () => {}),
        upsert: jest.fn(async (_target, records: SearchRecord[]) => {
          for (const record of records)
            remote.set(recordId(record), structuredClone(record));
        }),
        verifyPublication: jest.fn(
          async (_target, _user, _scope, records: SearchRecord[]) => {
            for (const record of records)
              expect(remote.get(recordId(record))).toEqual(record);
          },
        ),
      } as unknown as jest.Mocked<LexicalStore>;
      const index = new SearchIndexHandler(db, store, config);
      const text = new SearchTextExtractionHandler(
        db,
        storage,
        new IsolatedPdfParser(limits),
        limits,
      );
      const worker = new ProcessingMessageHandler(repository, [
        index,
        text,
        new StoredFileIntegrityHandler(db, storage, 10000),
      ]);
      async function run(type: ProcessingMessage['jobType']) {
        const job = await db.processingJob.findFirstOrThrow({
          where: { documentVersionId: id, jobType: type },
          orderBy: { generation: 'desc' },
        });
        const outbox = await db.processingOutbox.findFirstOrThrow({
          where: { processingJobId: job.id },
          orderBy: { dispatchSequence: 'desc' },
        });
        const message = outbox.payload as unknown as ProcessingMessage;
        expect(await worker.handle(message, false)).toBe('ack');
        return {
          job: await db.processingJob.findUniqueOrThrow({
            where: { id: job.id },
          }),
          message,
        };
      }
      async function verifyFile() {
        await db.$transaction((tx) =>
          repository.createInTransaction(tx, {
            userId: user.id,
            documentId: document.id,
            documentVersionId: id,
            correlationId: randomUUID(),
            maxAttempts: 3,
          }),
        );
        return run('VERIFY_STORED_FILE');
      }
      return {
        user,
        document,
        version,
        policy,
        projection,
        storage,
        store,
        remote,
        index,
        text,
        worker,
        run,
        verifyFile,
      };
    }
    it('publishes metadata first, then verified canonical pages in a new immutable revision without AI', async () => {
      const f = await fixture();
      expect((await f.run('INDEX_SEARCH')).job.status).toBe('COMPLETED');
      const metadata = await db.versionSearchProjection.findUniqueOrThrow({
        where: { id: f.projection.id },
      });
      expect(metadata).toMatchObject({
        status: 'READY',
        metadataReady: true,
        textCoverage: 'PENDING',
        expectedRecordCount: 1,
      });
      expect(
        await db.processingJob.count({
          where: { documentId: f.document.id, jobType: 'EXTRACT_SEARCH_TEXT' },
        }),
      ).toBe(0);
      await f.verifyFile();
      const extraction = await f.run('EXTRACT_SEARCH_TEXT');
      expect(extraction.job.status).toBe('COMPLETED');
      await f.run('INDEX_SEARCH');
      const state = await db.documentSearchState.findUniqueOrThrow({
        where: { documentId: f.document.id },
        include: { readyProjection: true },
      });
      expect(state.desiredRevision).toBe(2);
      expect(state.readyProjection).toMatchObject({
        status: 'READY',
        textCoverage: 'READY',
        expectedRecordCount: 3,
        extractedTextId: extraction.job.extractedTextId,
      });
      expect(
        [...f.remote.values()]
          .filter(
            (r) =>
              r.projectionId === state.readyProjectionId && r.kind === 'page',
          )
          .map((r) => (r.kind === 'page' ? [r.pageNumber, r.text] : [])),
      ).toEqual([
        [1, 'First page'],
        [3, 'Third page'],
      ]);
      expect(
        await db.aiProcessingRun.count({
          where: { documentId: f.document.id },
        }),
      ).toBe(0);
      expect(
        await db.processingJob.count({
          where: {
            documentId: f.document.id,
            jobType: { in: ['EXTRACT_TEXT', 'GENERATE_EMBEDDINGS'] },
          },
        }),
      ).toBe(0);
      expect(await f.worker.handle(extraction.message, true)).toBe('ack');
      expect(
        await db.extractedText.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(1);
    });
    it.each(['empty.pdf', 'encrypted.pdf', 'malformed.pdf'])(
      'retains explicit metadata-only coverage for %s',
      async (file) => {
        const f = await fixture(file);
        await f.verifyFile();
        await f.run('INDEX_SEARCH');
        expect((await f.run('EXTRACT_SEARCH_TEXT')).job.status).toBe('FAILED');
        await f.run('INDEX_SEARCH');
        const state = await db.documentSearchState.findUniqueOrThrow({
          where: { documentId: f.document.id },
          include: { readyProjection: true },
        });
        expect(state.readyProjection).toMatchObject({
          metadataReady: true,
          expectedRecordCount: 1,
          textCoverage: file === 'malformed.pdf' ? 'FAILED' : 'UNSUPPORTED',
        });
        expect(
          await db.extractedText.count({
            where: { documentVersionId: f.version.id },
          }),
        ).toBe(0);
      },
    );
    it('does not publish READY on partial/uncertain remote writes and retries deterministic IDs', async () => {
      const f = await fixture();
      f.store.upsert.mockImplementationOnce(async (_t, records) => {
        f.remote.set(recordId(records[0]), records[0]);
        throw new SearchStoreFailure('SEARCH_TIMEOUT');
      });
      const first = await f.run('INDEX_SEARCH');
      expect(first.job.status).toBe('RETRYING');
      expect(
        await db.versionSearchProjection.findUnique({
          where: { id: f.projection.id },
        }),
      ).toMatchObject({ status: 'BUILDING', expectedRecordCount: 1 });
      expect(
        await db.documentSearchState.findUnique({
          where: { documentId: f.document.id },
        }),
      ).toMatchObject({ readyProjectionId: null });
      await db.processingJob.update({
        where: { id: first.job.id },
        data: { availableAt: new Date() },
      });
      await repository.scheduleRetryDispatch(first.job.id, new Date());
      expect((await f.run('INDEX_SEARCH')).job.status).toBe('COMPLETED');
      expect(f.remote.size).toBe(1);
      expect(f.store.verifyPublication).toHaveBeenCalledTimes(1);
    });
    it.each(['archive', 'delete', 'version', 'generation'])(
      'fences %s during publication',
      async (event) => {
        const f = await fixture();
        f.store.verifyPublication.mockImplementationOnce(async () => {
          await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM documents WHERE id=${f.document.id}::uuid FOR UPDATE`;
            if (event === 'archive')
              await tx.document.update({
                where: { id: f.document.id },
                data: { isArchived: true, status: 'ARCHIVED' },
              });
            if (event === 'delete')
              await tx.document.update({
                where: { id: f.document.id },
                data: { deletedAt: new Date() },
              });
            if (event === 'version')
              await tx.documentVersion.create({
                data: {
                  ...f.version,
                  id: randomUUID(),
                  versionNumber: 2,
                  storageKey: `documents/${f.user.id}/${f.document.id}/${randomUUID()}/original.pdf`,
                  checksumSha256: createHash('sha256')
                    .update('new-version-fixture')
                    .digest('hex'),
                },
              });
            if (event === 'generation')
              await tx.searchIndexGeneration.update({
                where: { id: f.projection.indexGenerationId },
                data: { status: 'RETIRED' },
              });
            await enrollment.invalidateInTransaction(
              tx,
              f.user.id,
              f.document.id,
            );
          });
        });
        expect((await f.run('INDEX_SEARCH')).job.status).toBe('CANCELLED');
        expect(
          await db.documentSearchState.findUnique({
            where: { documentId: f.document.id },
          }),
        ).toMatchObject({ readyProjectionId: null });
        expect(f.remote.size).toBe(1); // Physical orphans do not establish SQL authorization.
      },
    );
    it('rolls back SQL READY after external writes when completion fails, then safely recovers', async () => {
      const f = await fixture();
      const job = await db.processingJob.findFirstOrThrow({
        where: { searchProjectionId: f.projection.id },
      });
      const claimed = await repository.claim(job.id, new Date(), 120000);
      if (!claimed.leaseToken) throw Error('No lease');
      const input = {
        jobId: job.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        leaseToken: claimed.leaseToken,
        attempt: claimed.attempts,
      };
      const result = await f.index.execute(input);
      if (result.kind !== 'success' || !result.commit)
        throw Error('No publication');
      const commit = result.commit;
      await expect(
        repository.complete(
          job.id,
          claimed.leaseToken,
          new Date(),
          async (tx, j) => {
            await commit(tx, j);
            throw Error('rollback fixture');
          },
        ),
      ).rejects.toThrow();
      expect(
        await db.versionSearchProjection.findUnique({
          where: { id: f.projection.id },
        }),
      ).toMatchObject({ status: 'BUILDING' });
      expect(f.remote.size).toBe(1);
      await repository.complete(job.id, claimed.leaseToken, new Date(), commit);
      expect(
        await db.documentSearchState.findUnique({
          where: { documentId: f.document.id },
        }),
      ).toMatchObject({ readyProjectionId: f.projection.id });
    });

    it('AI and lexical extraction prepared concurrently converge on one canonical artifact', async () => {
      const f = await fixture();
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
      await repository.requestAiProcessing({
        userId: f.user.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        correlationId: randomUUID(),
        maxAttempts: 3,
        ...PDF_EXTRACTOR,
        embeddingProfileId: profile.id,
        chunkAlgorithm: 'planned',
        chunkAlgorithmVersion: 'v1',
        tokenizer: 'planned',
        tokenizerVersion: 'v1',
        chunkSize: 512,
        chunkOverlap: 64,
      });
      await f.verifyFile();
      await f.run('INDEX_SEARCH');
      const ai = new PdfTextExtractionHandler(
        db,
        f.storage,
        new IsolatedPdfParser(limits),
        limits,
      );
      const prepare = async (handler: ProcessingJobHandler) => {
        const job = await db.processingJob.findFirstOrThrow({
          where: { documentVersionId: f.version.id, jobType: handler.jobType },
        });
        const claim = await repository.claim(job.id, new Date(), 120000);
        if (!claim.leaseToken) throw Error('Lease missing');
        const result = await handler.execute({
          jobId: job.id,
          documentId: f.document.id,
          documentVersionId: f.version.id,
          leaseToken: claim.leaseToken,
          attempt: claim.attempts,
        });
        if (result.kind !== 'success' || !result.commit)
          throw Error('Extraction missing');
        return { claim, commit: result.commit };
      };
      const [a, b] = await Promise.all([prepare(ai), prepare(f.text)]);
      const completed = await Promise.all([
        repository.complete(
          a.claim.id,
          a.claim.leaseToken!,
          new Date(),
          a.commit,
        ),
        repository.complete(
          b.claim.id,
          b.claim.leaseToken!,
          new Date(),
          b.commit,
        ),
      ]);
      expect(completed[0].extractedTextId).toBe(completed[1].extractedTextId);
      expect(
        await db.extractedText.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(1);
      expect(
        await db.processingJob.count({
          where: {
            documentVersionId: f.version.id,
            jobType: 'GENERATE_CHUNKS',
          },
        }),
      ).toBe(1);
    });
    it('archive during extraction commits no artifact; restore uses a fresh revision and delayed messages stay stale', async () => {
      const f = await fixture();
      await f.verifyFile();
      await f.run('INDEX_SEARCH');
      const parser = {
        parse: jest.fn(async (bytes: Buffer, timeout: number) => {
          await db.$transaction(async (tx) => {
            await tx.document.update({
              where: { id: f.document.id },
              data: { isArchived: true, status: 'ARCHIVED' },
            });
            await enrollment.invalidateInTransaction(
              tx,
              f.user.id,
              f.document.id,
            );
          });
          return new IsolatedPdfParser(limits).parse(bytes, timeout);
        }),
      };
      const extraction = new SearchTextExtractionHandler(
        db,
        f.storage,
        parser,
        limits,
      );
      const job = await db.processingJob.findFirstOrThrow({
        where: {
          documentVersionId: f.version.id,
          jobType: 'EXTRACT_SEARCH_TEXT',
        },
      });
      const intent = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: job.id },
      });
      const message = intent.payload as unknown as ProcessingMessage;
      expect(
        await new ProcessingMessageHandler(repository, [extraction]).handle(
          message,
          false,
        ),
      ).toBe('ack');
      expect(
        await db.extractedText.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(0);
      await db.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: f.document.id },
          data: { isArchived: false, status: 'UPLOADED' },
        });
        await enrollment.enrollInTransaction(
          tx,
          f.user.id,
          f.document.id,
          f.policy,
        );
      });
      await f.run('INDEX_SEARCH');
      expect(await f.worker.handle(message, true)).toBe('ack');
      await f.run('EXTRACT_SEARCH_TEXT');
      await f.run('INDEX_SEARCH');
      expect(
        await db.documentSearchState.findUnique({
          where: { documentId: f.document.id },
          include: { readyProjection: true },
        }),
      ).toMatchObject({
        readyProjection: { textCoverage: 'READY', status: 'READY' },
      });
    });
    it('fences canonical metadata changes even without the immediate lifecycle hook', async () => {
      const f = await fixture();
      f.store.verifyPublication.mockImplementationOnce(async () => {
        await db.document.update({
          where: { id: f.document.id },
          data: { title: 'New canonical metadata' },
        });
      });
      expect((await f.run('INDEX_SEARCH')).job.status).toBe('CANCELLED');
      expect(
        await db.documentSearchState.findUnique({
          where: { documentId: f.document.id },
        }),
      ).toMatchObject({ readyProjectionId: null });
    });
    it('propagates permanent file integrity failure into explicit metadata-only coverage', async () => {
      const f = await fixture();
      await f.run('INDEX_SEARCH');
      f.storage.open = jest.fn(async () =>
        Readable.from(Buffer.from('invalid stored bytes')),
      );
      expect((await f.verifyFile()).job.status).toBe('FAILED');
      await f.run('INDEX_SEARCH');
      expect(
        await db.documentSearchState.findUnique({
          where: { documentId: f.document.id },
          include: { readyProjection: true },
        }),
      ).toMatchObject({
        readyProjection: {
          textCoverage: 'FAILED',
          status: 'READY',
          expectedRecordCount: 1,
        },
      });
    });
    it('concurrent duplicate messages perform one logical metadata publication', async () => {
      const f = await fixture();
      const intent = await db.processingOutbox.findFirstOrThrow({
        where: {
          job: {
            searchProjectionId: f.projection.id,
            jobType: 'INDEX_SEARCH',
          },
        },
      });
      const message = intent.payload as unknown as ProcessingMessage;
      await Promise.all([
        f.worker.handle(message, false),
        f.worker.handle(message, false),
      ]);
      expect(
        (
          await db.processingJob.findUniqueOrThrow({
            where: { id: message.jobId },
          })
        ).status,
      ).toBe('COMPLETED');
      expect(f.store.upsert).toHaveBeenCalledTimes(1);
      expect(f.remote.size).toBe(1);
    });

    it('partial page publication stays BUILDING until a deterministic retry verifies the entire manifest', async () => {
      const f = await fixture();
      await f.verifyFile();
      await f.run('INDEX_SEARCH');
      await f.run('EXTRACT_SEARCH_TEXT');
      f.store.upsert.mockImplementationOnce(async (_target, records) => {
        f.remote.set(recordId(records[0]), records[0]);
        throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
      });
      const failed = await f.run('INDEX_SEARCH');
      expect(failed.job.status).toBe('RETRYING');
      const p = await db.versionSearchProjection.findUniqueOrThrow({
        where: { id: failed.job.searchProjectionId! },
      });
      expect(p).toMatchObject({
        status: 'BUILDING',
        expectedRecordCount: 3,
        metadataReady: false,
      });
      await db.processingJob.update({
        where: { id: failed.job.id },
        data: { availableAt: new Date() },
      });
      await repository.scheduleRetryDispatch(failed.job.id, new Date());
      await f.run('INDEX_SEARCH');
      expect(
        [...f.remote.values()].filter((r) => r.projectionId === p.id),
      ).toHaveLength(3);
      expect(
        await db.documentSearchState.findUnique({
          where: { documentId: f.document.id },
        }),
      ).toMatchObject({ readyProjectionId: p.id });
    });
    it('an expired attempt cannot commit publication and durable interruption recovery republishes safely', async () => {
      const f = await fixture();
      const job = await db.processingJob.findFirstOrThrow({
        where: { searchProjectionId: f.projection.id, jobType: 'INDEX_SEARCH' },
      });
      const claimed = await repository.claim(job.id, new Date(), 120000);
      if (!claimed.leaseToken) throw Error('Lease missing');
      const result = await f.index.execute({
        jobId: job.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        leaseToken: claimed.leaseToken,
        attempt: claimed.attempts,
      });
      if (result.kind !== 'success' || !result.commit)
        throw Error('No prepared publication');
      await db.processingJob.update({
        where: { id: job.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      await expect(
        repository.complete(
          job.id,
          claimed.leaseToken,
          new Date(),
          result.commit,
        ),
      ).rejects.toMatchObject({ code: 'CONCURRENT_CHANGE' });
      await repository.recoverInterrupted(
        job.id,
        claimed.leaseToken,
        new Date(),
      );
      await db.processingJob.update({
        where: { id: job.id },
        data: { availableAt: new Date() },
      });
      await repository.scheduleRetryDispatch(job.id, new Date());
      await f.run('INDEX_SEARCH');
      expect(f.remote.size).toBe(1);
      expect(
        await db.documentSearchState.findUnique({
          where: { documentId: f.document.id },
        }),
      ).toMatchObject({ readyProjectionId: f.projection.id });
    });

    it('uses authoritative generation status when it becomes serving during publication', async () => {
      const f = await fixture('multi.pdf', false);
      f.store.verifyPublication.mockImplementationOnce(async () => {
        await db.searchIndexGeneration.update({
          where: { id: f.projection.indexGenerationId },
          data: { status: 'SERVING' },
        });
      });
      expect((await f.run('INDEX_SEARCH')).job.status).toBe('COMPLETED');
      expect(
        await db.documentSearchState.findUnique({
          where: { documentId: f.document.id },
        }),
      ).toMatchObject({ readyProjectionId: f.projection.id });
    });

    it('reports owned current coverage through the existing status repository and rejects foreign or stale metadata', async () => {
      const f = await fixture();
      await f.run('INDEX_SEARCH');
      const status = new ProcessingStatusRepository(
        new PrismaService(db),
        new ConfigurationService(
          validateTestEnvironment({
            DATABASE_URL: url,
            SEARCH_ENROLLMENT_ENABLED: 'true',
            SEARCH_GENERATION_FINGERPRINT: f.policy.generationFingerprint,
          }),
        ),
      );
      expect(
        await status.findOwnedVersion(f.user.id, f.document.id, f.version.id),
      ).toMatchObject({
        aiReadiness: 'UNAVAILABLE',
        search: {
          metadataReady: true,
          textCoverage: 'PENDING',
          projectionStatus: 'READY',
        },
      });
      expect(
        await status.findOwnedVersion(
          randomUUID(),
          f.document.id,
          f.version.id,
        ),
      ).toBeNull();
      await db.document.update({
        where: { id: f.document.id },
        data: { title: 'Changed metadata' },
      });
      expect(
        (await status.findOwnedVersion(f.user.id, f.document.id, f.version.id))
          ?.search,
      ).toBeUndefined();
    });

    it('rechecks generation retirement inside completion after the repository eligibility read', async () => {
      const f = await fixture();
      const job = await db.processingJob.findFirstOrThrow({
        where: { searchProjectionId: f.projection.id, jobType: 'INDEX_SEARCH' },
      });
      const claimed = await repository.claim(job.id, new Date(), 120000);
      if (!claimed.leaseToken) throw Error('Lease missing');
      const result = await f.index.execute({
        jobId: job.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        leaseToken: claimed.leaseToken,
        attempt: claimed.attempts,
      });
      if (result.kind !== 'success' || !result.commit)
        throw Error('No prepared publication');
      const commit = result.commit;
      await expect(
        repository.complete(
          job.id,
          claimed.leaseToken,
          new Date(),
          async (tx, j) => {
            await db.searchIndexGeneration.update({
              where: { id: f.projection.indexGenerationId },
              data: { status: 'RETIRED' },
            });
            return commit(tx, j);
          },
        ),
      ).rejects.toMatchObject({ code: 'INELIGIBLE_DOCUMENT' });
      expect(
        await db.versionSearchProjection.findUnique({
          where: { id: f.projection.id },
        }),
      ).toMatchObject({ status: 'BUILDING' });
      expect(await repository.cancelObsoleteSearchJob(job.id, new Date())).toBe(
        true,
      );
    });
    (process.env.TEST_ELASTICSEARCH_URL ? it : it.skip)(
      'publishes real PDF pages through Elasticsearch and SQL before completing',
      async () => {
        const f = await fixture();
        const settings = validateTestEnvironment({
          DATABASE_URL: url,
          ELASTICSEARCH_ENABLED: 'true',
          ELASTICSEARCH_URL: process.env.TEST_ELASTICSEARCH_URL,
          ELASTICSEARCH_ALLOW_HTTP: 'true',
          ELASTICSEARCH_USERNAME: process.env.TEST_ELASTICSEARCH_USERNAME,
          ELASTICSEARCH_PASSWORD: process.env.TEST_ELASTICSEARCH_PASSWORD,
          ELASTICSEARCH_API_KEY: process.env.TEST_ELASTICSEARCH_API_KEY,
          ELASTICSEARCH_CA_FILE: process.env.TEST_ELASTICSEARCH_CA_FILE,
        }).elasticsearch;
        const real = new ElasticsearchStore(settings);
        const admin = new Client({
          node: settings.url,
          auth: settings.apiKey
            ? { apiKey: settings.apiKey }
            : { username: settings.username!, password: settings.password! },
          maxRetries: 0,
          tls: {
            rejectUnauthorized: true,
            ...(settings.caFile ? { ca: readFileSync(settings.caFile) } : {}),
          },
        });
        const gen = await db.searchIndexGeneration.findUniqueOrThrow({
          where: { id: f.projection.indexGenerationId },
        });
        f.store.createIndexes.mockImplementation((...args) =>
          real.createIndexes(...args),
        );
        f.store.upsert.mockImplementation((...args) => real.upsert(...args));
        f.store.verifyPublication.mockImplementation((...args) =>
          real.verifyPublication(...args),
        );
        try {
          await f.verifyFile();
          await f.run('INDEX_SEARCH');
          await f.run('EXTRACT_SEARCH_TEXT');
          const completed = await f.run('INDEX_SEARCH');
          expect(completed.job.status).toBe('COMPLETED');
          const p = await db.versionSearchProjection.findUniqueOrThrow({
            where: { id: completed.job.searchProjectionId! },
          });
          expect(p).toMatchObject({
            status: 'READY',
            metadataReady: true,
            textCoverage: 'READY',
            expectedRecordCount: 3,
          });
          const scope = {
            documentId: p.documentId,
            documentVersionId: p.documentVersionId,
            projectionId: p.id,
            revision: p.revision,
          };
          const pages = await real.verify(
            gen,
            'pages',
            f.user.id,
            scope,
            (p.expectedRecordIds as string[]).filter((id) =>
              id.includes(':page:'),
            ),
          );
          expect(pages).toMatchObject([
            { pageNumber: 1, text: 'First page' },
            { pageNumber: 3, text: 'Third page' },
          ]);
          expect(await f.worker.handle(completed.message, true)).toBe('ack');
        } finally {
          for (const kind of ['metadata', 'pages'] as const) {
            const inspected = await real.inspect(gen, kind);
            if (inspected.exists && inspected.compatible)
              await admin.indices.delete({
                index: indexName(config.indexPrefix, gen, kind),
              });
          }
          await real.close();
          await admin.close();
        }
      },
    );
  },
);
