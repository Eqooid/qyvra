import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Storage } from '@qyvra/storage';
import { SearchTextExtractionHandler } from '../src/infrastructure/worker/search-text-extraction.handler';
import { StoredFileIntegrityHandler } from '../src/infrastructure/worker/stored-file-integrity.handler';
import {
  createPrismaClient,
  PrismaClient,
  SearchPersistenceRepository,
  SearchEnrollmentRepository,
  SearchMaintenanceScheduler,
  ProcessingRepository,
  type ProcessingMessage,
} from '@qyvra/database';
import { SearchMaintenanceService } from '../src/modules/search/search-maintenance.service';
import { authorizeSearchOperator } from '../src/modules/search/search-maintenance.service';
import { SearchIndexHandler } from '../src/infrastructure/worker/search-index.handler';
import { SearchRemovalHandler } from '../src/infrastructure/worker/search-removal.handler';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import {
  PDF_EXTRACTOR,
  IsolatedPdfParser,
} from '../src/infrastructure/extraction/pdf-parser';
import {
  recordId,
  indexName,
  SEARCH_MAPPING_VERSION,
  SEARCH_ANALYZER_VERSION,
  SEARCH_SEGMENTATION_VERSION,
} from '../src/infrastructure/search/search-index';
import {
  SearchStoreFailure,
  type LexicalStore,
  type SearchRecord,
  type SearchGenerationTarget,
  type SearchProjectionScope,
} from '../src/infrastructure/search/lexical-store';
import { searchGenerationFingerprint } from '@qyvra/database';
import { validateTestEnvironment } from './configuration.fixture';

const url = process.env.TEST_DATABASE_URL;
const settings = validateTestEnvironment({
  DATABASE_URL: 'postgresql://localhost/search_test',
});
const config = settings.elasticsearch;
const identity = {
  schemaVersion: 1,
  mappingVersion: SEARCH_MAPPING_VERSION,
  analyzerVersion: SEARCH_ANALYZER_VERSION,
  segmentationVersion: SEARCH_SEGMENTATION_VERSION,
  ...PDF_EXTRACTOR,
};
(url ? describe : describe.skip)(
  'search maintenance (real PostgreSQL; simulated Elasticsearch)',
  () => {
    let db: PrismaClient,
      service: SearchMaintenanceService,
      store: LexicalStore,
      worker: ProcessingMessageHandler;
    let remote: Map<string, SearchRecord>,
      missing: Set<string>,
      offline: boolean;
    const users: string[] = [],
      generations: string[] = [],
      operations: string[] = [];
    let sequence = 1000;
    beforeAll(async () => {
      if (!url || !/test/i.test(new URL(url).pathname))
        throw Error('Disposable test database required');
      db = createPrismaClient({
        url,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 15000,
        poolSize: 8,
      });
      await db.$connect();
    });
    beforeEach(() => {
      remote = new Map();
      missing = new Set();
      offline = false;
      const matching = (
        target: SearchGenerationTarget,
        user: string,
        scope: SearchProjectionScope,
      ) =>
        [...remote.values()].filter(
          (r) =>
            r.indexGenerationId === target.id &&
            r.userId === user &&
            r.projectionId === scope.projectionId,
        );
      store = {
        availability: async () => ({ available: true, version: '9.4.6' }),
        inspect: async (target) => {
          if (offline) throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
          return { exists: !missing.has(target.id), compatible: true };
        },
        createIndexes: async (target) => {
          missing.delete(target.id);
        },
        upsert: async (_t, records) => {
          if (offline) throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
          for (const r of records) remote.set(recordId(r), structuredClone(r));
        },
        verify: async (target, kind, user, scope, ids) => {
          if (offline) throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
          return matching(target, user, scope).filter(
            (r) =>
              ids.includes(recordId(r)) &&
              (r.kind === 'metadata') === (kind === 'metadata'),
          );
        },
        verifyPublication: async (target, user, scope, records) => {
          if (offline) throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
          const actual = matching(target, user, scope);
          expect(actual).toHaveLength(records.length);
          for (const r of records) expect(remote.get(recordId(r))).toEqual(r);
        },
        remove: async (_t, _k, _u, _s, ids) => {
          if (offline) throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
          ids.forEach((id) => remote.delete(id));
        },
        query: async () => [],
        scan: async () => ({ records: [], next: null }),
        close: async () => {},
      };
      service = new SearchMaintenanceService(db, store, config.indexPrefix);
      worker = new ProcessingMessageHandler(new ProcessingRepository(db), [
        new SearchIndexHandler(db, store, config),
        new SearchRemovalHandler(db, store, config.indexPrefix),
      ]);
    });
    afterEach(async () => {
      await db.searchMaintenanceOperation.deleteMany({
        where: { id: { in: operations.splice(0) } },
      });
      await db.document.deleteMany({ where: { userId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
      await db.searchIndexGeneration.deleteMany({
        where: { id: { in: generations.splice(0) } },
      });
    });
    afterAll(async () => {
      await db.$disconnect();
    });
    async function generation(serving = false) {
      const n = sequence++,
        target = {
          id: randomUUID(),
          generation: n,
          fingerprint: searchGenerationFingerprint(identity),
        };
      const g = await new SearchPersistenceRepository(db).createGeneration({
        ...identity,
        generation: n,
        metadataIndexName: indexName(config.indexPrefix, target, 'metadata'),
        pageIndexName: indexName(config.indexPrefix, target, 'pages'),
      });
      generations.push(g.id);
      return serving
        ? db.searchIndexGeneration.update({
            where: { id: g.id },
            data: { status: 'SERVING' },
          })
        : g;
    }
    async function document(userId?: string) {
      const u = userId
        ? { id: userId }
        : await db.user.create({
            data: { email: `${randomUUID()}@example.invalid` },
          });
      if (!userId) users.push(u.id);
      const d = await db.document.create({
          data: { userId: u.id, title: 'Private maintenance fixture' },
        }),
        id = randomUUID();
      const v = await db.documentVersion.create({
        data: {
          id,
          userId: u.id,
          documentId: d.id,
          versionNumber: 1,
          originalFilename: 'fixture.png',
          mimeType: 'image/png',
          fileSize: 12,
          checksumSha256: createHash('sha256').update(id).digest('hex'),
          storageKey: `documents/${u.id}/${d.id}/${id}/original.png`,
        },
      });
      return { u, d, v };
    }
    async function start(
      kind: 'BACKFILL' | 'REBUILD' | 'RECONCILE' | 'CLEANUP',
      generationId: string,
      userId?: string,
    ) {
      const id = randomUUID();
      operations.push(id);
      return service.start({
        id,
        kind,
        generationId,
        userId,
        initiator: 'ops:test',
      });
    }
    async function run(
      documentId: string,
      type: ProcessingMessage['jobType'] = 'INDEX_SEARCH',
    ) {
      const job = await db.processingJob.findFirstOrThrow({
        where: { documentId, jobType: type, status: 'PENDING' },
        orderBy: { generation: 'desc' },
      });
      const outbox = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: job.id },
        orderBy: { dispatchSequence: 'desc' },
      });
      expect(
        await worker.handle(
          outbox.payload as unknown as ProcessingMessage,
          false,
        ),
      ).toBe('ack');
      return db.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    }
    it('dry-run is read-only; bounded keysets resume and duplicate commands/enrollment do not duplicate work', async () => {
      const g = await generation(true),
        a = await document(),
        b = await document(a.u.id),
        foreign = await document();
      const before = await db.processingJob.count();
      expect(await service.preview(g.id, a.u.id, 1)).toHaveLength(1);
      expect(await db.processingJob.count()).toBe(before);
      const op = await start('BACKFILL', g.id, a.u.id);
      expect((await service.runBatch(op.id, 'ops:test', 1)).examined).toBe(1);
      expect((await service.runBatch(op.id, 'ops:test', 1)).examined).toBe(2);
      expect((await service.runBatch(op.id, 'ops:test', 1)).status).toBe(
        'COMPLETED',
      );
      expect(
        await db.processingJob.count({ where: { documentId: foreign.d.id } }),
      ).toBe(0);
      const again = await start('BACKFILL', g.id, a.u.id);
      await service.runBatch(again.id, 'ops:test', 25);
      expect(
        await db.processingJob.count({
          where: {
            documentId: { in: [a.d.id, b.d.id] },
            jobType: 'INDEX_SEARCH',
          },
        }),
      ).toBe(2);
      expect(await db.processingOutbox.count()).toBe(2);
    });
    it('checkpoints, jobs and outbox roll back together when a transaction fails', async () => {
      const g = await generation(true),
        f = await document(),
        op = await start('BACKFILL', g.id, f.u.id);
      const spy = jest
        .spyOn(SearchEnrollmentRepository.prototype, 'enrollInTransaction')
        .mockImplementationOnce(async (tx, user, doc) => {
          await new SearchMaintenanceScheduler(db).prepare(
            tx,
            user,
            doc,
            g.id,
            op.id,
          );
          throw Error('injected rollback');
        });
      try {
        await expect(service.runBatch(op.id, 'ops:test', 1)).rejects.toThrow(
          'injected rollback',
        );
      } finally {
        spy.mockRestore();
      }
      const saved = await service.inspect(op.id, 'ops:test');
      expect(saved.afterDocumentId).toBeNull();
      expect(saved.examined).toBe(0);
      expect(saved.failures).toBe(1);
      expect(await db.processingJob.count()).toBe(0);
      expect(await db.processingOutbox.count()).toBe(0);
      await service.runBatch(op.id, 'ops:test', 25);
      expect(await db.processingJob.count()).toBe(1);
    });
    it('concurrent operation/batch claims have one winner and active leases prevent cancellation', async () => {
      const g = await generation(true),
        f = await document(),
        op = await start('BACKFILL', g.id, f.u.id);
      await expect(start('BACKFILL', g.id, f.u.id)).rejects.toThrow();
      await db.searchMaintenanceOperation.update({
        where: { id: op.id },
        data: {
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60000),
        },
      });
      await expect(service.runBatch(op.id, 'ops:test', 1)).rejects.toThrow();
      expect((await service.cancel(op.id, 'ops:test')).count).toBe(0);
      await db.searchMaintenanceOperation.update({
        where: { id: op.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });
      await service.runBatch(op.id, 'ops:test', 25);
      expect(await db.processingJob.count()).toBe(1);
    });
    it('same-profile shadow rebuild preserves serving publication; verified SQL cutover changes all pointers atomically', async () => {
      const old = await generation(true),
        f = await document();
      let op = await start('BACKFILL', old.id, f.u.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id);
      const pointer = (
        await db.documentSearchState.findUniqueOrThrow({
          where: { documentId: f.d.id },
        })
      ).readyProjectionId;
      const target = await generation();
      op = await start('REBUILD', target.id);
      await service.runBatch(op.id, 'ops:test', 25);
      expect(
        (
          await db.documentSearchState.findUniqueOrThrow({
            where: { documentId: f.d.id },
          })
        ).readyProjectionId,
      ).toBe(pointer);
      await expect(service.verifyCutover(target.id)).rejects.toThrow();
      await run(f.d.id);
      expect((await service.verifyCutover(target.id)).proofs).toHaveLength(1);
      const id = randomUUID();
      operations.push(id);
      await service.cutover(id, 'ops:test', target.id, target.id);
      expect(
        (
          await db.searchIndexGeneration.findUniqueOrThrow({
            where: { id: old.id },
          })
        ).status,
      ).toBe('RETIRED');
      expect(
        (
          await db.documentSearchState.findUniqueOrThrow({
            where: { documentId: f.d.id },
          })
        ).readyProjectionId,
      ).not.toBe(pointer);
      expect(
        await service.cutover(id, 'ops:test', target.id, target.id),
      ).toMatchObject({ status: 'COMPLETED' });
      expect(
        await db.documentVersion.findUniqueOrThrow({ where: { id: f.v.id } }),
      ).toMatchObject({
        checksumSha256: f.v.checksumSha256,
        storageKey: f.v.storageKey,
      });
      expect(await db.aiProcessingRun.count()).toBe(0);
      expect(await db.chunkEmbedding.count()).toBe(0);
    });
    it('outages do not invalidate healthy SQL publication; definite missing records schedule fenced repair', async () => {
      const g = await generation(true),
        f = await document();
      let op = await start('BACKFILL', g.id, f.u.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id);
      const p = (
        await db.documentSearchState.findUniqueOrThrow({
          where: { documentId: f.d.id },
        })
      ).readyProjectionId;
      offline = true;
      op = await start('RECONCILE', g.id, f.u.id);
      await expect(service.runBatch(op.id, 'ops:test', 25)).rejects.toThrow();
      expect(
        (
          await db.documentSearchState.findUniqueOrThrow({
            where: { documentId: f.d.id },
          })
        ).readyProjectionId,
      ).toBe(p);
      offline = false;
      remote.clear();
      await service.runBatch(op.id, 'ops:test', 25);
      expect((await service.inspect(op.id, 'ops:test')).discrepancies).toBe(1);
      expect(
        (
          await db.documentSearchState.findUniqueOrThrow({
            where: { documentId: f.d.id },
          })
        ).readyProjectionId,
      ).toBeNull();
      await run(f.d.id);
      expect(
        (
          await db.documentSearchState.findUniqueOrThrow({
            where: { documentId: f.d.id },
          })
        ).readyProjectionId,
      ).not.toBe(p);
    });
    it('archive invalidates before exact cleanup, duplicates remain idempotent and never remove another owner', async () => {
      const g = await generation(true),
        f = await document(),
        foreign = await document();
      const op = await start('BACKFILL', g.id, f.u.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id);
      await db.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: f.d.id },
          data: { isArchived: true, status: 'ARCHIVED' },
        });
        await new SearchEnrollmentRepository(db).invalidateInTransaction(
          tx,
          f.u.id,
          f.d.id,
        );
      });
      const job = await run(f.d.id, 'REMOVE_SEARCH_INDEX');
      expect(job.status).toBe('COMPLETED');
      expect(remote.size).toBe(0);
      const cleanup = await start('CLEANUP', g.id, f.u.id);
      await service.runBatch(cleanup.id, 'ops:test', 25);
      expect(
        await db.processingJob.count({ where: { documentId: foreign.d.id } }),
      ).toBe(0);
      expect(
        await db.processingJob.count({
          where: { documentId: f.d.id, jobType: 'REMOVE_SEARCH_INDEX' },
        }),
      ).toBe(1);
    });
    it('real PDF shadow extraction and cached rebuild do not advance the serving revision or create embeddings', async () => {
      const g = await generation(),
        f = await document();
      const bytes = await readFile(join(__dirname, 'fixtures/pdf/multi.pdf'));
      const id = randomUUID();
      await db.documentVersion.create({
        data: {
          id,
          userId: f.u.id,
          documentId: f.d.id,
          versionNumber: 2,
          originalFilename: 'multi.pdf',
          mimeType: 'application/pdf',
          fileSize: bytes.length,
          pageCount: 2,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
          storageKey: `documents/${f.u.id}/${f.d.id}/${id}/original.pdf`,
        },
      });
      const storage = {
        open: jest.fn(async () => Readable.from(bytes)),
      } as unknown as Storage;
      worker = new ProcessingMessageHandler(new ProcessingRepository(db), [
        new SearchIndexHandler(db, store, config),
        new SearchRemovalHandler(db, store, config.indexPrefix),
        new StoredFileIntegrityHandler(db, storage, 10000),
        new SearchTextExtractionHandler(
          db,
          storage,
          new IsolatedPdfParser(settings.extraction),
          settings.extraction,
        ),
      ]);
      const op = await start('REBUILD', g.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id, 'VERIFY_STORED_FILE');
      await new SearchMaintenanceScheduler(db).reconcile(10);
      await run(f.d.id, 'EXTRACT_SEARCH_TEXT');
      await run(f.d.id);
      let state = await db.documentSearchState.findUniqueOrThrow({
        where: { documentId: f.d.id },
      });
      expect(state.desiredRevision).toBe(1);
      expect(state.readyProjectionId).toBeNull();
      expect((await service.verifyCutover(g.id)).proofs).toHaveLength(1);
      const cut = randomUUID();
      operations.push(cut);
      await service.cutover(cut, 'ops:test', g.id, g.id);
      state = await db.documentSearchState.findUniqueOrThrow({
        where: { documentId: f.d.id },
      });
      const target = await generation(),
        rebuild = await start('REBUILD', target.id);
      await service.runBatch(rebuild.id, 'ops:test', 25);
      await run(f.d.id);
      expect(
        (
          await db.documentSearchState.findUniqueOrThrow({
            where: { documentId: f.d.id },
          })
        ).readyProjectionId,
      ).toBe(state.readyProjectionId);
      expect(
        await db.processingJob.count({
          where: { documentId: f.d.id, jobType: 'EXTRACT_SEARCH_TEXT' },
        }),
      ).toBe(1);
      expect((await service.verifyCutover(target.id)).proofs).toHaveLength(1);
      expect(await db.chunkEmbedding.count()).toBe(0);
    });
    it('failed cutover verification is durable and a SQL failure rolls back generation and pointer changes', async () => {
      const old = await generation(true),
        f = await document();
      let op = await start('BACKFILL', old.id, f.u.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id);
      const pointer = (
        await db.documentSearchState.findUniqueOrThrow({
          where: { documentId: f.d.id },
        })
      ).readyProjectionId;
      const target = await generation();
      op = await start('REBUILD', target.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id);
      const id = randomUUID();
      operations.push(id);
      offline = true;
      await expect(
        service.cutover(id, 'ops:test', target.id, target.id),
      ).rejects.toThrow();
      let audit = await service.inspect(id, 'ops:test');
      expect(audit.failures).toBe(1);
      expect(audit.status).toBe('RUNNING');
      offline = false;
      // Force the final audit UPDATE to fail its monotonic-counter SQL trigger.
      await db.searchMaintenanceOperation.update({
        where: { id },
        data: { examined: 100 },
      });
      await expect(
        service.cutover(id, 'ops:test', target.id, target.id),
      ).rejects.toThrow();
      expect(
        (
          await db.searchIndexGeneration.findUniqueOrThrow({
            where: { id: old.id },
          })
        ).status,
      ).toBe('SERVING');
      expect(
        (
          await db.documentSearchState.findUniqueOrThrow({
            where: { documentId: f.d.id },
          })
        ).readyProjectionId,
      ).toBe(pointer);
      audit = await service.inspect(id, 'ops:test');
      expect(audit.failures).toBe(2);
      await service.cancel(id, 'ops:test');
      const fresh = randomUUID();
      operations.push(fresh);
      await service.cutover(fresh, 'ops:test', target.id, target.id);
    });
    it('archive after external verification blocks cutover and stale cleanup is rechecked after retention', async () => {
      const old = await generation(true),
        f = await document();
      let op = await start('BACKFILL', old.id, f.u.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id);
      const original = [...remote.values()][0];
      const target = await generation();
      op = await start('REBUILD', target.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id);
      const verify = store.verifyPublication;
      store.verifyPublication = async (...args) => {
        await verify(...args);
        await db.$transaction(async (tx) => {
          await tx.document.update({
            where: { id: f.d.id },
            data: { isArchived: true, status: 'ARCHIVED' },
          });
          await new SearchEnrollmentRepository(db).invalidateInTransaction(
            tx,
            f.u.id,
            f.d.id,
          );
        });
      };
      const id = randomUUID();
      operations.push(id);
      await expect(
        service.cutover(id, 'ops:test', target.id, target.id),
      ).rejects.toThrow();
      expect(
        (
          await db.searchIndexGeneration.findUniqueOrThrow({
            where: { id: old.id },
          })
        ).status,
      ).toBe('SERVING');
      await service.cancel(id, 'ops:test');
      await run(f.d.id, 'REMOVE_SEARCH_INDEX');
      const removed = await db.versionSearchProjection.findFirstOrThrow({
        where: { id: original.projectionId, status: 'REMOVED' },
      });
      remote.set(recordId(original), original);
      await db.versionSearchProjection.update({
        where: { id: removed.id },
        data: { updatedAt: new Date(Date.now() - 25 * 3600000) },
      });
      await new SearchMaintenanceScheduler(db).reconcile(10);
      await run(f.d.id, 'REMOVE_SEARCH_INDEX');
      expect(remote.has(recordId(original))).toBe(false);
      expect(
        (
          await db.documentSearchState.findUniqueOrThrow({
            where: { documentId: f.d.id },
          })
        ).readyProjectionId,
      ).toBeNull();
    });
    it('physical orphan scans report ambiguous records without scheduling deletion', async () => {
      const g = await generation(true),
        f = await document();
      const unknown = randomUUID();
      store.scan = async () => ({
        records: [
          {
            id: `${unknown}:metadata`,
            userId: f.u.id,
            documentId: f.d.id,
            documentVersionId: f.v.id,
            projectionId: unknown,
            revision: 1,
            sourceHash: 'a'.repeat(64),
          },
        ],
        next: null,
      });
      expect(
        await service.inspectOwner(g.id, f.u.id, 'metadata', undefined, 10),
      ).toMatchObject({
        findings: [
          { classification: 'UNKNOWN_PROJECTION', repair: 'REPORT_ONLY' },
        ],
      });
      expect(await db.processingJob.count()).toBe(0);
    });
    it('cleanup outage preserves durable retry and the immutable manifest until verified absence', async () => {
      const g = await generation(true),
        f = await document();
      const op = await start('BACKFILL', g.id, f.u.id);
      await service.runBatch(op.id, 'ops:test', 25);
      await run(f.d.id);
      await db.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: f.d.id },
          data: { isArchived: true, status: 'ARCHIVED' },
        });
        await new SearchEnrollmentRepository(db).invalidateInTransaction(
          tx,
          f.u.id,
          f.d.id,
        );
      });
      offline = true;
      const failed = await run(f.d.id, 'REMOVE_SEARCH_INDEX');
      expect(failed.status).toBe('RETRYING');
      expect(
        (
          await db.versionSearchProjection.findUniqueOrThrow({
            where: { id: failed.searchProjectionId ?? '' },
          })
        ).status,
      ).toBe('REMOVAL_PENDING');
      offline = false;
      await db.processingJob.update({
        where: { id: failed.id },
        data: { availableAt: new Date(Date.now() - 1000) },
      });
      await new ProcessingRepository(db).scheduleRetryDispatch(
        failed.id,
        new Date(),
      );
      const outbox = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: failed.id },
        orderBy: { dispatchSequence: 'desc' },
      });
      expect(
        await worker.handle(
          outbox.payload as unknown as ProcessingMessage,
          false,
        ),
      ).toBe('ack');
      expect(
        (await db.processingJob.findUniqueOrThrow({ where: { id: failed.id } }))
          .status,
      ).toBe('COMPLETED');
      expect(remote.size).toBe(0);
    });
    it('database role membership rejects an ordinary runtime identity', async () => {
      const existed = await db.$queryRaw<
        { rolname: string }[]
      >`SELECT rolname FROM pg_roles WHERE rolname IN ('qyvra_search_operator','qyvra_search_reader_test')`;
      const operatorExisted = existed.some(
          (r) => r.rolname === 'qyvra_search_operator',
        ),
        readerExisted = existed.some(
          (r) => r.rolname === 'qyvra_search_reader_test',
        );
      try {
        if (!operatorExisted)
          await db.$executeRaw`CREATE ROLE qyvra_search_operator NOLOGIN`;
        if (!readerExisted)
          await db.$executeRaw`CREATE ROLE qyvra_search_reader_test NOLOGIN`;
        await expect(authorizeSearchOperator(db)).resolves.toBeUndefined();
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL ROLE qyvra_search_reader_test`;
          await expect(authorizeSearchOperator(tx)).rejects.toThrow(
            'OPERATOR_AUTHORIZATION_REQUIRED',
          );
        });
      } finally {
        if (!readerExisted)
          await db.$executeRaw`DROP ROLE qyvra_search_reader_test`;
        if (!operatorExisted)
          await db.$executeRaw`DROP ROLE qyvra_search_operator`;
      }
    });
  },
);
