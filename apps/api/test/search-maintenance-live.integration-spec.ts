import { Client } from '@elastic/elasticsearch';
import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  PrismaClient,
  SearchPersistenceRepository,
  searchGenerationFingerprint,
  ProcessingRepository,
  type ProcessingMessage,
  type SearchIndexGeneration,
} from '@qyvra/database';
import { ElasticsearchStore } from '../src/infrastructure/search/elasticsearch-store';
import { SearchMaintenanceService } from '../src/modules/search/search-maintenance.service';
import { SearchIndexHandler } from '../src/infrastructure/worker/search-index.handler';
import { SearchRemovalHandler } from '../src/infrastructure/worker/search-removal.handler';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import {
  indexName,
  SEARCH_MAPPING_VERSION,
  SEARCH_ANALYZER_VERSION,
  SEARCH_SEGMENTATION_VERSION,
} from '../src/infrastructure/search/search-index';
import { PDF_EXTRACTOR } from '../src/infrastructure/extraction/pdf-parser';
import { validateTestEnvironment } from './configuration.fixture';

const live =
  process.env.TEST_DATABASE_URL && process.env.TEST_ELASTICSEARCH_URL
    ? describe
    : describe.skip;
live(
  'maintenance with real PostgreSQL/Elasticsearch (direct worker delivery, no broker claim)',
  () => {
    let db: PrismaClient, store: ElasticsearchStore, admin: Client;
    const generations: SearchIndexGeneration[] = [],
      operations: string[] = [];
    let owner: string | undefined;
    afterAll(async () => {
      if (!db) return;
      await db.searchMaintenanceOperation.deleteMany({
        where: { id: { in: operations } },
      });
      if (owner) {
        await db.document.deleteMany({ where: { userId: owner } });
        await db.user.delete({ where: { id: owner } });
      }
      for (const g of generations) {
        await admin.indices.delete({
          index: [
            indexName('qyvra-search', g, 'metadata'),
            indexName('qyvra-search', g, 'pages'),
          ],
          ignore_unavailable: true,
        });
      }
      await db.searchIndexGeneration.deleteMany({
        where: { id: { in: generations.map((g) => g.id) } },
      });
      await store?.close();
      await admin?.close();
      await db.$disconnect();
    });
    it('backfills, repairs controlled index loss, rebuilds and cuts over without changing the immutable source', async () => {
      const url = process.env.TEST_DATABASE_URL,
        endpoint = process.env.TEST_ELASTICSEARCH_URL;
      if (
        !url ||
        !/test/i.test(new URL(url).pathname) ||
        !endpoint ||
        !['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname)
      )
        throw Error('Isolated SQL and loopback test Elasticsearch required');
      db = createPrismaClient({
        url,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 15000,
        poolSize: 6,
      });
      await db.$connect();
      if (
        await db.searchIndexGeneration.count({ where: { status: 'SERVING' } })
      )
        throw Error('Use an empty isolated serving-generation test database');
      const settings = validateTestEnvironment({
        DATABASE_URL: url,
        ELASTICSEARCH_ENABLED: 'true',
        ELASTICSEARCH_URL: endpoint,
        ELASTICSEARCH_ALLOW_HTTP: 'true',
        ELASTICSEARCH_USERNAME: process.env.TEST_ELASTICSEARCH_USERNAME,
        ELASTICSEARCH_PASSWORD: process.env.TEST_ELASTICSEARCH_PASSWORD,
        ELASTICSEARCH_API_KEY: process.env.TEST_ELASTICSEARCH_API_KEY,
      });
      store = new ElasticsearchStore(settings.elasticsearch);
      admin = new Client({
        node: endpoint,
        auth: {
          username: process.env.TEST_ELASTICSEARCH_USERNAME ?? '',
          password: process.env.TEST_ELASTICSEARCH_PASSWORD ?? '',
        },
        maxRetries: 0,
        requestTimeout: 10000,
      });
      const service = new SearchMaintenanceService(
        db,
        store,
        settings.elasticsearch.indexPrefix,
      );
      const worker = new ProcessingMessageHandler(
        new ProcessingRepository(db),
        [
          new SearchIndexHandler(db, store, settings.elasticsearch),
          new SearchRemovalHandler(
            db,
            store,
            settings.elasticsearch.indexPrefix,
          ),
        ],
      );
      const u = await db.user.create({
        data: { email: `${randomUUID()}@example.invalid` },
      });
      owner = u.id;
      const d = await db.document.create({
          data: { userId: u.id, title: 'Live maintenance fixture' },
        }),
        id = randomUUID();
      const v = await db.documentVersion.create({
        data: {
          id,
          userId: u.id,
          documentId: d.id,
          versionNumber: 1,
          originalFilename: 'fixture.png',
          storageKey: `documents/${u.id}/${d.id}/${id}/original.png`,
          mimeType: 'image/png',
          fileSize: 12,
          checksumSha256: 'a'.repeat(64),
        },
      });
      let number = Math.floor(Math.random() * 1000000000) + 1;
      async function generation(serving = false) {
        const identity = {
          schemaVersion: 1,
          mappingVersion: SEARCH_MAPPING_VERSION,
          analyzerVersion: SEARCH_ANALYZER_VERSION,
          segmentationVersion: SEARCH_SEGMENTATION_VERSION,
          ...PDF_EXTRACTOR,
        };
        const target = {
          id: randomUUID(),
          generation: number++,
          fingerprint: searchGenerationFingerprint(identity),
        };
        const row = await new SearchPersistenceRepository(db).createGeneration({
          ...identity,
          generation: target.generation,
          metadataIndexName: indexName(
            settings.elasticsearch.indexPrefix,
            target,
            'metadata',
          ),
          pageIndexName: indexName(
            settings.elasticsearch.indexPrefix,
            target,
            'pages',
          ),
        });
        generations.push(row);
        await store.createIndexes(row);
        return serving
          ? db.searchIndexGeneration.update({
              where: { id: row.id },
              data: { status: 'SERVING' },
            })
          : row;
      }
      async function scan(
        kind: 'BACKFILL' | 'RECONCILE' | 'REBUILD',
        g: SearchIndexGeneration,
      ) {
        const op = randomUUID();
        operations.push(op);
        await service.start({
          id: op,
          kind,
          initiator: 'ops:live-test',
          generationId: g.id,
          ...(kind !== 'REBUILD' ? { userId: u.id } : {}),
        });
        await service.runBatch(op, 'ops:live-test', 25);
      }
      async function deliver() {
        const j = await db.processingJob.findFirstOrThrow({
          where: {
            documentId: d.id,
            jobType: 'INDEX_SEARCH',
            status: 'PENDING',
          },
          orderBy: { generation: 'desc' },
        });
        const intent = await db.processingOutbox.findFirstOrThrow({
          where: { processingJobId: j.id },
        });
        expect(
          await worker.handle(
            intent.payload as unknown as ProcessingMessage,
            false,
          ),
        ).toBe('ack');
        expect(
          (await db.processingJob.findUniqueOrThrow({ where: { id: j.id } }))
            .status,
        ).toBe('COMPLETED');
      }
      const old = await generation(true);
      await scan('BACKFILL', old);
      await deliver();
      await admin.indices.delete({
        index: indexName(settings.elasticsearch.indexPrefix, old, 'metadata'),
      });
      await scan('RECONCILE', old);
      await deliver();
      const target = await generation();
      await scan('REBUILD', target);
      await deliver();
      expect((await service.verifyCutover(target.id)).proofs).toHaveLength(1);
      const op = randomUUID();
      operations.push(op);
      await service.cutover(op, 'ops:live-test', target.id, target.id);
      expect(
        (
          await db.searchIndexGeneration.findUniqueOrThrow({
            where: { id: old.id },
          })
        ).status,
      ).toBe('RETIRED');
      expect(
        await db.documentVersion.findUniqueOrThrow({ where: { id: v.id } }),
      ).toMatchObject({
        storageKey: v.storageKey,
        checksumSha256: v.checksumSha256,
      });
      expect(await db.chunkEmbedding.count({ where: { userId: u.id } })).toBe(
        0,
      );
    }, 120000);
  },
);
