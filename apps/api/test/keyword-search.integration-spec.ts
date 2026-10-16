import { LexicalSourceService } from '../src/modules/documents/lexical-source.service';
import { HybridSearchService } from '../src/modules/search/hybrid-search.service';
import { SemanticSearchService } from '../src/modules/search/semantic-search.service';
import { SemanticSearchRepository } from '../src/modules/search/semantic-search.repository';
import {
  SearchWindowStore,
  type SearchWindow,
} from '../src/infrastructure/search/search-window.store';
import { embeddingProfileFingerprint } from '@qyvra/database';
import { vectorCollectionName } from '../src/modules/ai/vector-store';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { LEXICAL_STORE } from '../src/infrastructure/search/lexical-store';
import { Client } from '@elastic/elasticsearch';
import { readFileSync } from 'node:fs';
import { ElasticsearchStore } from '../src/infrastructure/search/elasticsearch-store';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
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
} from '@qyvra/database';
import type { Storage } from '@qyvra/storage';
import { ConfigurationService } from '../src/configuration/configuration.module';
import { PrismaService } from '../src/database/prisma.service';
import { StructuredLogger } from '../src/common/structured-logger';
import { KeywordSearchRepository } from '../src/modules/search/keyword-search.repository';
import { KeywordSearchService } from '../src/modules/search/keyword-search.service';
import { SearchIndexHandler } from '../src/infrastructure/worker/search-index.handler';
import {
  PDF_EXTRACTOR,
  IsolatedPdfParser,
} from '../src/infrastructure/extraction/pdf-parser';
import {
  preparePdfExtraction,
  commitPdfExtraction,
} from '../src/infrastructure/extraction/pdf-extraction';
import {
  type LexicalQuery,
  LexicalStore,
  SearchRecord,
  SearchStoreFailure,
} from '../src/infrastructure/search/lexical-store';
import {
  indexName,
  recordId,
  SEARCH_MAPPING_VERSION,
  SEARCH_ANALYZER_VERSION,
  SEARCH_SEGMENTATION_VERSION,
} from '../src/infrastructure/search/search-index';
import { validateTestEnvironment } from './configuration.fixture';

const url = process.env.TEST_DATABASE_URL;
const limits = {
  maxBytes: 52428800,
  maxPages: 500,
  maxCharacters: 5000000,
  maxTextBytes: 20000000,
  timeoutMs: 10000,
  heapMb: 256,
};
(url ? describe : describe.skip)(
  'keyword authorization/filters/lifecycle (real PostgreSQL/parser; simulated ES)',
  () => {
    let db: PrismaClient,
      gen: Awaited<ReturnType<SearchPersistenceRepository['createGeneration']>>,
      config: ConfigurationService;
    let processing: ProcessingRepository,
      enrollment: SearchEnrollmentRepository,
      repository: KeywordSearchRepository;
    let store: jest.Mocked<LexicalStore>, service: KeywordSearchService;
    const profiles: string[] = [];
    const owners: string[] = [],
      remote = new Map<string, SearchRecord>();
    beforeAll(async () => {
      if (!url || !/test/i.test(new URL(url).pathname))
        throw Error('Disposable migrated test database required');
      db = createPrismaClient({
        url,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 15000,
        poolSize: 6,
      });
      await db.$connect();
      const identity = {
        schemaVersion: 1,
        mappingVersion: SEARCH_MAPPING_VERSION,
        analyzerVersion: SEARCH_ANALYZER_VERSION,
        segmentationVersion: SEARCH_SEGMENTATION_VERSION,
        ...PDF_EXTRACTOR,
      };
      const target = {
        id: randomUUID(),
        generation: Math.floor(Math.random() * 1000000) + 1,
        fingerprint: searchGenerationFingerprint(identity),
      };
      gen = await new SearchPersistenceRepository(db).createGeneration({
        ...identity,
        generation: target.generation,
        metadataIndexName: indexName('qyvra-search', target, 'metadata'),
        pageIndexName: indexName('qyvra-search', target, 'pages'),
      });
      await db.searchIndexGeneration.update({
        where: { id: gen.id },
        data: { status: 'SERVING' },
      });
      config = new ConfigurationService(
        validateTestEnvironment({
          DATABASE_URL: url,
          ELASTICSEARCH_ENABLED: 'true',
          ELASTICSEARCH_URL: 'http://127.0.0.1:9200',
          ELASTICSEARCH_ALLOW_HTTP: 'true',
          ELASTICSEARCH_USERNAME: 'fixture',
          ELASTICSEARCH_PASSWORD: 'synthetic-fixture-password',
          KEYWORD_SEARCH_ENABLED: 'true',
          KEYWORD_SEARCH_GENERATION_FINGERPRINT: gen.fingerprint,
        }),
      );
      processing = new ProcessingRepository(db);
      enrollment = new SearchEnrollmentRepository(db);
      repository = new KeywordSearchRepository(new PrismaService(db));
    });
    beforeEach(() => {
      remote.clear();
      store = {
        availability: jest
          .fn()
          .mockResolvedValue({ available: true, version: '9.4.6' }),
        inspect: jest
          .fn()
          .mockResolvedValue({ exists: true, compatible: true }),
        createIndexes: jest.fn().mockResolvedValue(undefined),
        upsert: jest.fn(async (_target, records: SearchRecord[]) => {
          for (const record of records)
            remote.set(recordId(record), structuredClone(record));
        }),
        verifyPublication: jest.fn(
          async (_t, _u, _s, records: SearchRecord[]) => {
            for (const r of records) expect(remote.get(recordId(r))).toEqual(r);
          },
        ),
        query: jest.fn(async (_t, kind, input: LexicalQuery) =>
          [...remote.values()]
            .filter(
              (r) =>
                (r.kind === 'metadata') === (kind === 'metadata') &&
                r.userId === input.userId &&
                input.scopes.some((s) => s.projectionId === r.projectionId) &&
                (r.kind === 'page'
                  ? r.text
                  : r.title + ' ' + (r.referenceNumber ?? '')
                )
                  .toLowerCase()
                  .includes(input.text.toLowerCase()),
            )
            .slice(0, input.limit)
            .map((record) => ({ id: recordId(record), score: 1, record })),
        ),
      } as unknown as jest.Mocked<LexicalStore>;
      service = new KeywordSearchService(repository, config, store, {
        event: jest.fn(),
      } as unknown as StructuredLogger);
    });
    afterEach(async () => {
      await db.document.deleteMany({ where: { userId: { in: owners } } });
      await db.aiServingProfile.deleteMany({
        where: { embeddingProfileId: { in: profiles } },
      });
      await db.embeddingProfile.deleteMany({
        where: { id: { in: profiles.splice(0) } },
      });
      await db.category.deleteMany({ where: { userId: { in: owners } } });
      await db.tag.deleteMany({ where: { userId: { in: owners } } });
      await db.authSession.deleteMany({ where: { userId: { in: owners } } });
      await db.user.deleteMany({ where: { id: { in: owners.splice(0) } } });
      if (
        (await db.searchIndexGeneration.findUnique({ where: { id: gen.id } }))
          ?.status === 'RETIRED'
      ) {
        // Retired identities are immutable; create a compatible fresh generation for later tests.
        await db.searchIndexGeneration.delete({ where: { id: gen.id } });
        gen = await new SearchPersistenceRepository(db).createGeneration({
          ...gen,
          generation: gen.generation + 1,
          metadataIndexName: indexName(
            'qyvra-search',
            { ...gen, generation: gen.generation + 1 },
            'metadata',
          ),
          pageIndexName: indexName(
            'qyvra-search',
            { ...gen, generation: gen.generation + 1 },
            'pages',
          ),
        });
        await db.searchIndexGeneration.update({
          where: { id: gen.id },
          data: { status: 'SERVING' },
        });
      }
    });
    afterAll(async () => {
      try {
        await db.searchIndexGeneration.delete({ where: { id: gen.id } });
      } finally {
        await db.$disconnect();
      }
    });
    async function user() {
      const u = await db.user.create({
        data: { email: randomUUID() + '@example.invalid' },
      });
      owners.push(u.id);
      return u;
    }
    async function fixture(ownerId?: string, title = 'Report') {
      const owner = ownerId ?? (await user()).id;
      const document = await db.document.create({
        data: {
          userId: owner,
          title,
          documentDate: new Date('2026-10-14'),
          expirationDate: new Date('2026-12-31'),
        },
      });
      const id = randomUUID(),
        bytes = Buffer.concat([
          await readFile(resolve(__dirname, 'fixtures/pdf/multi.pdf')),
          Buffer.from('\n%' + id),
        ]);
      const version = await db.documentVersion.create({
        data: {
          id,
          userId: owner,
          documentId: document.id,
          versionNumber: 1,
          originalFilename: 'Report%_name.pdf',
          mimeType: 'application/pdf',
          pageCount: 3,
          fileSize: bytes.length,
          storageKey: `documents/${owner}/${document.id}/${id}/original.pdf`,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        },
      });
      const projection = await db.$transaction((tx) =>
        enrollment.enrollInTransaction(tx, owner, document.id, {
          enabled: true,
          generationFingerprint: gen.fingerprint,
        }),
      );
      if (!projection) throw Error('Missing enrollment');
      const storage = {
        open: jest.fn(async () => Readable.from(bytes)),
      } as unknown as Storage;
      const prepared = await preparePdfExtraction(
        db,
        storage,
        new IsolatedPdfParser(limits),
        limits,
        version,
      );
      if (prepared.kind !== 'success') throw Error('Fixture parsing failed');
      const artifact = await db.$transaction((tx) =>
        commitPdfExtraction(tx, version, prepared),
      );
      await db.versionSearchProjection.update({
        where: { id: projection.id },
        data: { extractedTextId: artifact.id },
      });
      async function publish() {
        const job = await db.processingJob.findFirstOrThrow({
          where: { documentId: document.id, jobType: 'INDEX_SEARCH' },
          orderBy: { generation: 'desc' },
        });
        const claimed = await processing.claim(job.id, new Date(), 120000);
        if (!claimed.leaseToken) throw Error('Lease missing');
        const result = await new SearchIndexHandler(
          db,
          store,
          config.elasticsearch,
        ).execute({
          jobId: job.id,
          documentId: document.id,
          documentVersionId: id,
          leaseToken: claimed.leaseToken,
          attempt: claimed.attempts,
        });
        if (result.kind !== 'success') throw Error('Publication failed');
        await processing.complete(
          job.id,
          claimed.leaseToken,
          new Date(),
          result.commit,
        );
      }
      await publish();
      return { owner, document, version, projection, artifact, publish };
    }
    it('returns canonical PDF snippets and owned metadata without AI artifacts', async () => {
      const f = await fixture();
      const result = await service.search(f.owner, { query: 'First page' });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        title: 'Report',
        matches: [
          {
            kind: 'page',
            pageNumber: 1,
            snippet: 'First page',
            startOffset: 0,
            endOffset: 10,
          },
        ],
      });
      expect(result.coverage).toEqual({
        eligibleDocuments: 1,
        metadataReadyDocuments: 1,
        textReadyDocuments: 1,
      });
      expect(
        await db.aiProcessingRun.count({
          where: { documentId: f.document.id },
        }),
      ).toBe(0);
      expect(
        await service.search(f.owner, { query: 'unrelated vocabulary' }),
      ).toMatchObject({ results: [] });
    });
    it('isolates two owners and uses uniform 404 for foreign explicit scope', async () => {
      const a = await fixture(),
        b = await fixture();
      expect(
        (await service.search(a.owner, { query: 'Report' })).results.map(
          (r) => r.documentId,
        ),
      ).toEqual([a.document.id]);
      await expect(
        service.search(a.owner, {
          query: 'Report',
          documentIds: [b.document.id],
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (await service.search(b.owner, { query: 'Report' })).results.map(
          (r) => r.documentId,
        ),
      ).toEqual([b.document.id]);
    });
    it('pre-filters owned categories, all tags, MIME, literal filename and inclusive UTC dates', async () => {
      const f = await fixture();
      const category = await db.category.create({
        data: { userId: f.owner, name: 'Fixture' },
      });
      const tags = await Promise.all(
        ['One', 'Two'].map((name) =>
          db.tag.create({ data: { userId: f.owner, name } }),
        ),
      );
      await db.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: f.document.id },
          data: { categoryId: category.id },
        });
        await tx.documentTag.createMany({
          data: tags.map((t) => ({
            documentId: f.document.id,
            userId: f.owner,
            tagId: t.id,
          })),
        });
        const p = await enrollment.enrollInTransaction(
          tx,
          f.owner,
          f.document.id,
          { enabled: true, generationFingerprint: gen.fingerprint },
        );
        if (!p) throw Error('No revised projection');
        await tx.versionSearchProjection.update({
          where: { id: p.id },
          data: { extractedTextId: f.artifact.id },
        });
      });
      await f.publish();
      const filters = {
        categoryId: category.id,
        tagIds: tags.map((t) => t.id),
        mimeType: 'application/pdf',
        filename: '%_name',
        dateFrom: '2026-10-14',
        dateTo: '2026-10-14',
        expirationFrom: '2026-12-31',
        expirationTo: '2026-12-31',
        createdFrom: f.document.createdAt.toISOString().slice(0, 10),
        createdTo: f.document.createdAt.toISOString().slice(0, 10),
      };
      expect(
        (await service.search(f.owner, { query: 'Report', filters })).results,
      ).toHaveLength(1);
      expect(
        (
          await service.search(f.owner, {
            query: 'Report',
            filters: { ...filters, tagIds: [randomUUID()] },
          })
        ).results,
      ).toHaveLength(0);
      expect(
        (
          await service.search(f.owner, {
            query: 'Report',
            filters: { ...filters, mimeType: 'image/png' },
          })
        ).results,
      ).toHaveLength(0);
      expect(
        (
          await service.search(f.owner, {
            query: 'Report',
            filters: { ...filters, categoryId: randomUUID() },
          })
        ).coverage.eligibleDocuments,
      ).toBe(0);
    });
    it('uses deterministic document ties and labels first-page truncation without exact match totals', async () => {
      const a = await fixture(),
        b = await fixture(a.owner);
      const result = await service.search(a.owner, {
        query: 'Report',
        limit: 1,
      });
      expect(result.results[0].documentId).toBe(
        [a.document.id, b.document.id].sort()[0],
      );
      expect(result.pagination).toEqual({
        hasMore: true,
        nextCursor: null,
        paginationAvailable: false,
        truncated: true,
      });
      expect(result).not.toHaveProperty('total');
    });
    it.each(['archive', 'delete', 'version', 'metadata', 'unverified'])(
      'excludes %s changes during retrieval despite cleanup lag',
      async (event) => {
        const f = await fixture();
        const original = store.query.getMockImplementation();
        if (!original) throw Error('No transport');
        store.query.mockImplementationOnce(async (...args) => {
          const hits = await original(...args);
          if (event === 'archive')
            await db.document.update({
              where: { id: f.document.id },
              data: { status: 'ARCHIVED', isArchived: true },
            });
          if (event === 'delete')
            await db.document.update({
              where: { id: f.document.id },
              data: { deletedAt: new Date() },
            });
          if (event === 'metadata')
            await db.document.update({
              where: { id: f.document.id },
              data: { title: 'New metadata' },
            });
          if (event === 'unverified')
            await db.documentSearchState.update({
              where: { documentId: f.document.id },
              data: { readyProjectionId: null },
            });
          if (event === 'version')
            await db.documentVersion.create({
              data: {
                ...f.version,
                id: randomUUID(),
                versionNumber: 2,
                storageKey: `documents/${f.owner}/${f.document.id}/${randomUUID()}/original.pdf`,
                checksumSha256: 'b'.repeat(64),
              },
            });
          return hits;
        });
        const result = await service.search(f.owner, { query: 'Report' });
        expect(result.results).toEqual([]);
        expect(result.pagination.hasMore).toBe(false);
        expect(remote.size).toBe(3);
      },
    );
    it('rehydrates canonical values instead of forged indexed titles/snippets', async () => {
      const f = await fixture();
      for (const [id, r] of remote) {
        if (r.kind === 'metadata')
          remote.set(id, { ...r, title: 'Report SECRET forged index text' });
      }
      const result = await service.search(f.owner, { query: 'Report' });
      expect(result.results[0].title).toBe('Report');
      expect(JSON.stringify(result)).not.toContain('SECRET');
    });
    it('fails closed when serving generation retires during retrieval', async () => {
      const f = await fixture();
      store.query.mockImplementationOnce(async () => {
        await db.searchIndexGeneration.update({
          where: { id: gen.id },
          data: { status: 'RETIRED' },
        });
        return [];
      });
      await expect(
        service.search(f.owner, { query: 'Report' }),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('bounds scopes rather than silently selecting a vault subset', async () => {
      const a = await fixture();
      await fixture(a.owner);
      await expect(
        repository.scope(a.owner, gen.id, { query: 'Report' }, 1),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('returns controlled failures instead of empty results on search outage', async () => {
      const f = await fixture();
      store.query.mockRejectedValue(new SearchStoreFailure('SEARCH_TIMEOUT'));
      await expect(
        service.search(f.owner, { query: 'Report' }),
      ).rejects.toMatchObject({ status: 504 });
    });

    it('serves the real HTTP endpoint with PostgreSQL-verified session ownership and sanitized failures', async () => {
      const a = await fixture(),
        b = await fixture();
      const token = randomBytes(32).toString('base64url');
      await db.authSession.create({
        data: {
          userId: a.owner,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const environment = validateTestEnvironment({
        DATABASE_URL: url,
        NODE_ENV: 'test',
        ELASTICSEARCH_ENABLED: 'true',
        ELASTICSEARCH_URL: 'http://127.0.0.1:9200',
        ELASTICSEARCH_ALLOW_HTTP: 'true',
        ELASTICSEARCH_USERNAME: 'fixture',
        ELASTICSEARCH_PASSWORD: 'synthetic-fixture-password',
        KEYWORD_SEARCH_ENABLED: 'true',
        KEYWORD_SEARCH_GENERATION_FINGERPRINT: gen.fingerprint,
      });
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(settings.KEY)
        .useValue(environment)
        .overrideProvider(PRISMA_CLIENT)
        .useValue(db)
        .overrideProvider(LEXICAL_STORE)
        .useValue(store)
        .overrideProvider(LOG_SINK)
        .useValue(() => undefined)
        .compile();
      const app = module.createNestApplication();
      configureApplication(app, environment);
      await app.init();
      const begin = () =>
        request(app.getHttpServer())
          .post('/api/v1/search/keyword')
          .set('Cookie', `document_tracker_session=${token}`)
          .set('X-CSRF-Protection', '1');
      try {
        const result = await begin().send({ query: 'First page' }).expect(200);
        expect(
          result.body.data.results.map(
            (r: { documentId: string }) => r.documentId,
          ),
        ).toEqual([a.document.id]);
        const sourceHref = result.body.data.results[0].matches[0].source
          .href as string;
        await request(app.getHttpServer())
          .get(sourceHref)
          .set('Cookie', `document_tracker_session=${token}`)
          .expect(200)
          .expect((r) => {
            expect(r.body.data.excerpt).toBe('First page');
          });
        await request(app.getHttpServer()).get(sourceHref).expect(401);
        await request(app.getHttpServer())
          .get(sourceHref + '?unexpected=1')
          .set('Cookie', `document_tracker_session=${token}`)
          .expect(400);
        await begin()
          .send({ query: 'First page', documentIds: [b.document.id] })
          .expect(404);
        await request(app.getHttpServer())
          .post('/api/v1/search/keyword')
          .send({ query: 'First page' })
          .expect(401);
        await begin()
          .send({
            query: 'First page',
            filters: { createdFrom: '2026-10-14', createdTo: '2026-10-01' },
          })
          .expect(400);
        await begin()
          .send({
            query: 'First page',
            cursor:
              'AAAAAAAAAAAAAAAAAAAAAA_1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          })
          .expect(503); // Continuation cannot load a window while Redis is unconfigured.
        store.query.mockRejectedValue(
          new SearchStoreFailure('SEARCH_UNAVAILABLE'),
        );
        const failure = await begin().send({ query: 'First page' }).expect(503);
        expect(JSON.stringify(failure.body)).not.toContain('ELASTICSEARCH');
      } finally {
        await app.close();
        await db.$connect();
      }
    });
    it('returns SQL-authorized private suggestions and excludes stale hashes, archives and injected foreign records', async () => {
      const a = await fixture(undefined, 'Confidential Contract'),
        b = await fixture(undefined, 'Confidential Foreign');
      expect(
        (
          await service.suggestions(a.owner, { prefix: 'Conf' })
        ).suggestions.map((x) => x.text),
      ).toEqual(['Confidential Contract']);
      const foreign = [...remote.values()].find(
        (r) => r.kind === 'metadata' && r.userId === b.owner,
      )!;
      store.query.mockResolvedValueOnce([
        { id: recordId(foreign), score: 9, record: foreign },
      ]);
      expect(
        (await service.suggestions(a.owner, { prefix: 'Conf' })).suggestions,
      ).toEqual([]);
      await db.document.update({
        where: { id: a.document.id },
        data: { title: 'Confidential Changed' },
      });
      expect(
        (await service.suggestions(a.owner, { prefix: 'Conf' })).suggestions,
      ).toEqual([]);
      await db.document.update({
        where: { id: a.document.id },
        data: { isArchived: true, status: 'ARCHIVED' },
      });
      expect(
        (await service.suggestions(a.owner, { prefix: 'Conf' })).suggestions,
      ).toEqual([]);
    });
    it('aligns native SQL page evidence and resolves retained exact sources while rejecting foreign, unpublished and ineligible reads', async () => {
      const a = await fixture(),
        b = await fixture();
      const original = store.query.getMockImplementation()!;
      store.query.mockImplementation(async (...args) =>
        (await original(...args)).map((h) => ({
          ...h,
          highlights:
            h.record.kind === 'page'
              ? [
                  {
                    field: 'text' as const,
                    text: 'First page',
                    ranges: [{ start: 0, end: 5 }],
                  },
                ]
              : [],
        })),
      );
      const result = await service.search(a.owner, { query: 'First page' }),
        match = result.results[0].matches[0];
      expect(match.ranges).toEqual([{ start: 0, end: 5 }]);
      expect(match.source).toMatchObject({
        documentVersionId: a.version.id,
        pageNumber: 1,
        segment: 0,
      });
      const sources = new LexicalSourceService(new PrismaService(db));
      const resolve = (owner = a.owner, page = 1, segment = 0) =>
        sources.resolve(
          owner,
          a.document.id,
          a.version.id,
          a.artifact.id,
          page,
          segment,
        );
      expect(await resolve()).toMatchObject({
        excerpt: 'First page',
        startOffset: 0,
        endOffset: 10,
        nextSegment: null,
        previousSegment: null,
      });
      await expect(resolve(b.owner)).rejects.toHaveProperty('status', 404);
      await expect(resolve(a.owner, 9999)).rejects.toHaveProperty(
        'status',
        404,
      );
      await expect(resolve(a.owner, 1, 9999)).rejects.toHaveProperty(
        'status',
        404,
      );
      await db.documentVersion.create({
        data: {
          ...a.version,
          id: randomUUID(),
          versionNumber: 2,
          storageKey: 'test/' + randomUUID(),
          checksumSha256: createHash('sha256')
            .update(randomUUID())
            .digest('hex'),
        },
      });
      expect(
        (await service.search(a.owner, { query: 'First page' })).results,
      ).toEqual([]);
      // Already-issued source policy matches citation reads: exact retained historical text remains readable.
      expect((await resolve()).documentVersionId).toBe(a.version.id);
      await db.document.update({
        where: { id: a.document.id },
        data: { isArchived: true, status: 'ARCHIVED' },
      });
      await expect(resolve()).rejects.toHaveProperty('status', 404);
      await db.document.update({
        where: { id: a.document.id },
        data: { isArchived: false, status: 'UPLOADED', deletedAt: new Date() },
      });
      await expect(resolve()).rejects.toHaveProperty('status', 404);
      await db.document.update({
        where: { id: a.document.id },
        data: { deletedAt: null },
      });
      if (!Array.isArray(a.artifact.pageSpans))
        throw new Error('Expected canonical fixture spans');
      const unpublished = await db.extractedText.create({
        data: {
          ...a.artifact,
          id: randomUUID(),
          extractionFingerprint: createHash('sha256')
            .update(randomUUID())
            .digest('hex'),
          extractorVersion: 'unpublished-fixture-v1',
          pageSpans: a.artifact.pageSpans,
        },
      });
      await expect(
        sources.resolve(
          a.owner,
          a.document.id,
          a.version.id,
          unpublished.id,
          1,
          0,
        ),
      ).rejects.toHaveProperty('status', 404);
      await db.searchIndexGeneration.update({
        where: { id: gen.id },
        data: { status: 'RETIRED' },
      });
      expect((await resolve()).excerpt).toBe('First page'); // Retained verified source, not new search discovery.
    });
    it('fuses real SQL-owned lexical and READY semantic sources; fixed pages reauthorize lifecycle and filters', async () => {
      const a = await fixture(),
        a2 = await fixture(a.owner),
        b = await fixture();
      const identity = {
        provider: 'test',
        model: 'hybrid-fixture-' + randomUUID(),
        modelRevision: 'v1',
        dimensions: 3,
        distance: 'Cosine' as const,
        profileVersion: 1,
        normalizationVersion: 'nfc-lf-v1',
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
      await db.aiServingProfile.create({
        data: { id: 1, embeddingProfileId: profile.id },
      });
      async function semanticSource(f: typeof a) {
        const owned = {
          userId: f.owner,
          documentId: f.document.id,
          documentVersionId: f.version.id,
        };
        const run = await db.aiProcessingRun.create({
          data: {
            ...owned,
            generation: 1,
            extractor: f.artifact.extractor,
            extractorVersion: f.artifact.extractorVersion,
            normalizationVersion: f.artifact.normalizationVersion,
            chunkAlgorithm: 'test',
            chunkAlgorithmVersion: 'v1',
            tokenizer: 'test',
            tokenizerVersion: 'v1',
            chunkSize: 512,
            chunkOverlap: 64,
            embeddingProfileId: profile.id,
          },
        });
        const set = await db.chunkSet.create({
          data: {
            ...owned,
            extractedTextId: f.artifact.id,
            extractionHash: f.artifact.contentHash,
            fingerprint: createHash('sha256')
              .update('hybrid-chunks')
              .digest('hex'),
            algorithm: 'test',
            algorithmVersion: 'v1',
            tokenizer: 'test',
            tokenizerVersion: 'v1',
            chunkSize: 512,
            chunkOverlap: 64,
          },
        });
        const text = Array.from(f.artifact.text).slice(0, 10).join('');
        const chunk = await db.documentChunk.create({
          data: {
            ...owned,
            id: randomUUID(),
            chunkSetId: set.id,
            ordinal: 0,
            text,
            textHash: createHash('sha256').update(text).digest('hex'),
            startOffset: 0,
            endOffset: 10,
            tokenCount: 2,
            pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: 10 }],
          },
        });
        await db.chunkSet.update({
          where: { id: set.id },
          data: { complete: true, chunkCount: 1 },
        });
        await db.chunkEmbedding.create({
          data: {
            ...owned,
            chunkId: chunk.id,
            embeddingProfileId: profile.id,
            dimensions: 3,
            inputHash: chunk.textHash,
            vector: [1, 2, 3],
          },
        });
        const index = await db.versionVectorIndex.create({
          data: {
            ...owned,
            aiRunId: run.id,
            chunkSetId: set.id,
            embeddingProfileId: profile.id,
            collectionGeneration: 1,
            collectionName: vectorCollectionName(profile.id),
            expectedPointCount: 1,
          },
        });
        await db.versionAiState.create({
          data: { ...owned, desiredRunId: run.id },
        });
        await db.versionVectorIndex.update({
          where: { id: index.id },
          data: {
            status: 'READY',
            confirmedPointCount: 1,
            checkpointOrdinal: 0,
            indexedAt: new Date(),
          },
        });
        await db.versionReadyIndex.create({
          data: {
            ...owned,
            embeddingProfileId: profile.id,
            vectorIndexId: index.id,
          },
        });
        return {
          chunkId: chunk.id,
          indexManifestId: index.id,
          documentId: f.document.id,
          documentVersionId: f.version.id,
          chunkSetId: set.id,
          score: 0.9,
        };
      }
      const ac = await semanticSource(a),
        bc = await semanticSource(b);
      const c = new ConfigurationService({
        ...validateTestEnvironment({ DATABASE_URL: url }),
        keywordSearch: config.keywordSearch,
        elasticsearch: config.elasticsearch,
        hybridSearch: { enabled: true },
        semanticSearch: { ...config.semanticSearch, enabled: true },
        embedding: {
          ...config.embedding,
          profileFingerprint: profile.fingerprint,
        },
      });
      const semanticRepo = new SemanticSearchRepository(new PrismaService(db));
      const embeddings = {
        embed: jest.fn(async () => [{ id: 'query', vector: [1, 2, 3] }]),
      };
      // Deliberately inject a foreign remote candidate: real SQL hydration must discard it.
      const vectors = {
        check: jest.fn(async () => {}),
        search: jest.fn(async () => [ac, bc]),
      };
      const semanticService = new SemanticSearchService(
        semanticRepo,
        c,
        embeddings,
        vectors,
        { event: jest.fn() } as unknown as StructuredLogger,
      );
      const cache = new Map<string, SearchWindow>();
      const windows = {
        save: jest.fn(async (id: string, w: SearchWindow) => {
          cache.set(id, JSON.parse(JSON.stringify(w)) as SearchWindow);
          return true;
        }),
        read: jest.fn(async (id: string) => cache.get(id) ?? null),
      };
      const hybrid = new HybridSearchService(
        service,
        semanticService,
        repository,
        semanticRepo,
        windows as unknown as SearchWindowStore,
        c,
        { event: jest.fn() } as unknown as StructuredLogger,
      );
      const session = randomUUID(),
        input = { query: 'First page', limit: 1 };
      const first = await hybrid.hybridSearch(a.owner, session, input);
      expect(first.results[0].documentId).toBe(a.document.id);
      expect(first.results[0].matches.map((m) => m.kind)).toContain('chunk');
      expect(first.results.some((r) => r.documentId === b.document.id)).toBe(
        false,
      );
      expect(vectors.search).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: a.owner,
          manifestIds: [ac.indexManifestId],
          limit: 100,
        }),
      );
      expect(first.pagination.nextCursor).toBeTruthy();
      // No new retrieval occurs for continuation, and archived work is excluded despite physical stale records.
      await db.document.update({
        where: { id: a2.document.id },
        data: { status: 'ARCHIVED', isArchived: true },
      });
      const next = await hybrid.hybridSearch(a.owner, session, {
        ...input,
        cursor: first.pagination.nextCursor!,
      });
      expect(next.results).toEqual([]);
      expect(next.pagination.hasMore).toBe(false);
      expect(vectors.search).toHaveBeenCalledTimes(1);
      const filtered = await hybrid.hybridSearch(a.owner, session, {
        query: 'First page',
        filters: { mimeType: 'image/png' },
      });
      expect(filtered.results).toEqual([]);
      expect(embeddings.embed).toHaveBeenCalledTimes(1);
    });
    (process.env.TEST_ELASTICSEARCH_URL ? it : it.skip)(
      'real ES keyword matching, ownership, first-page ordering and restore with cleanup lag',
      async () => {
        const liveConfig = new ConfigurationService(
          validateTestEnvironment({
            DATABASE_URL: url,
            ELASTICSEARCH_ENABLED: 'true',
            ELASTICSEARCH_URL: process.env.TEST_ELASTICSEARCH_URL,
            ELASTICSEARCH_ALLOW_HTTP: 'true',
            ELASTICSEARCH_USERNAME: process.env.TEST_ELASTICSEARCH_USERNAME,
            ELASTICSEARCH_PASSWORD: process.env.TEST_ELASTICSEARCH_PASSWORD,
            ELASTICSEARCH_API_KEY: process.env.TEST_ELASTICSEARCH_API_KEY,
            ELASTICSEARCH_CA_FILE: process.env.TEST_ELASTICSEARCH_CA_FILE,
            KEYWORD_SEARCH_ENABLED: 'true',
            KEYWORD_SEARCH_GENERATION_FINGERPRINT: gen.fingerprint,
          }),
        );
        const c = liveConfig.elasticsearch,
          real = new ElasticsearchStore(c);
        const admin = new Client({
          node: c.url,
          auth: c.apiKey
            ? { apiKey: c.apiKey }
            : { username: c.username!, password: c.password! },
          maxRetries: 0,
          tls: {
            rejectUnauthorized: true,
            ...(c.caFile ? { ca: readFileSync(c.caFile) } : {}),
          },
        });
        store.availability.mockImplementation((...args) =>
          real.availability(...args),
        );
        store.inspect.mockImplementation((...args) => real.inspect(...args));
        store.createIndexes.mockImplementation((...args) =>
          real.createIndexes(...args),
        );
        store.upsert.mockImplementation((...args) => real.upsert(...args));
        store.verifyPublication.mockImplementation((...args) =>
          real.verifyPublication(...args),
        );
        store.query.mockImplementation((...args) => real.query(...args));
        const liveService = new KeywordSearchService(
          repository,
          liveConfig,
          store,
          { event: jest.fn() } as unknown as StructuredLogger,
        );
        try {
          const a = await fixture(),
            b = await fixture(),
            a2 = await fixture(a.owner);
          const pages = await liveService.search(a.owner, {
            query: 'First page',
            match: 'phrase',
            limit: 1,
          });
          expect(pages.results).toHaveLength(1);
          expect(pages.results[0].matches[0].ranges?.length).toBeGreaterThan(0);
          expect(
            (
              await liveService.suggestions(a.owner, { prefix: 'Rep' })
            ).suggestions.every((s) => s.documentId !== b.document.id),
          ).toBe(true);
          expect(pages.results[0].matches[0]).toMatchObject({
            kind: 'page',
            pageNumber: 1,
            snippet: 'First page',
          });
          expect(pages.pagination).toMatchObject({
            hasMore: true,
            paginationAvailable: false,
            nextCursor: null,
          });
          expect(pages.results[0].documentId).toBe(
            [a.document.id, a2.document.id].sort()[0],
          );
          expect(
            (
              await liveService.search(b.owner, { query: 'First page' })
            ).results.map((r) => r.documentId),
          ).toEqual([b.document.id]);
          expect(
            (
              await liveService.search(a.owner, {
                query: 'No matching lexical vocabulary',
              })
            ).results,
          ).toEqual([]);
          await db.$transaction(async (tx) => {
            await tx.document.update({
              where: { id: a.document.id },
              data: { isArchived: true, status: 'ARCHIVED' },
            });
            await enrollment.invalidateInTransaction(
              tx,
              a.owner,
              a.document.id,
            );
          });
          expect(
            (
              await liveService.search(a.owner, { query: 'First page' })
            ).results.map((r) => r.documentId),
          ).toEqual([a2.document.id]);
          await db.$transaction(async (tx) => {
            await tx.document.update({
              where: { id: a.document.id },
              data: { isArchived: false, status: 'UPLOADED' },
            });
            const p = await enrollment.enrollInTransaction(
              tx,
              a.owner,
              a.document.id,
              { enabled: true, generationFingerprint: gen.fingerprint },
            );
            if (!p) throw Error('Restore failed');
            await tx.versionSearchProjection.update({
              where: { id: p.id },
              data: { extractedTextId: a.artifact.id },
            });
          });
          await a.publish();
          expect(
            (await liveService.search(a.owner, { query: 'First page' }))
              .results,
          ).toHaveLength(2);
        } finally {
          for (const kind of ['metadata', 'pages'] as const) {
            const inspected = await real.inspect(gen, kind);
            if (inspected.exists && inspected.compatible)
              await admin.indices.delete({
                index: indexName('qyvra-search', gen, kind),
              });
          }
          await real.close();
          await admin.close();
        }
      },
    );
  },
);
