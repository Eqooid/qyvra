import { Client } from '@elastic/elasticsearch';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { searchProjectionId, searchRecordId } from '@qyvra/database';
import { validateTestEnvironment } from './configuration.fixture';
import { ElasticsearchStore } from '../src/infrastructure/search/elasticsearch-store';
import {
  SearchMetadataRecord,
  SearchPageRecord,
} from '../src/infrastructure/search/lexical-store';
import { indexName } from '../src/infrastructure/search/search-index';

const live = process.env.TEST_ELASTICSEARCH_URL ? describe : describe.skip;
live('private Elasticsearch 9.4.x live contract (isolated indexes)', () => {
  const key = randomUUID();
  const prefix = 'qyvra-search-test-' + key.replace(/-/g, '').slice(0, 12);
  const target = {
    id: randomUUID(),
    generation: 1,
    fingerprint: createHash('sha256').update(key).digest('hex'),
  };
  const version = randomUUID();
  const owner = randomUUID();
  const record: SearchMetadataRecord = {
    kind: 'metadata',
    userId: owner,
    documentId: randomUUID(),
    documentVersionId: version,
    projectionId: searchProjectionId(version, target.id, 1),
    revision: 1,
    indexGenerationId: target.id,
    sourceHash: 'a'.repeat(64),
    title: 'Qyvra private contract report',
    description: 'A bounded phrase fixture',
    filename: 'Report.png',
    referenceNumber: 'REF/AB-1',
    mimeType: 'image/png',
    documentType: 'OTHER',
    status: 'UPLOADED',
    tagIds: [],
    fileSize: 12,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
  };
  const page: SearchPageRecord = {
    kind: 'page',
    userId: owner,
    documentId: record.documentId,
    documentVersionId: version,
    projectionId: record.projectionId,
    revision: 1,
    indexGenerationId: target.id,
    sourceHash: 'b'.repeat(64),
    pageNumber: 1,
    segment: 0,
    startOffset: 0,
    endOffset: 22,
    text: 'A private phrase match',
  };
  let client: Client, store: ElasticsearchStore;
  const created: string[] = [];
  beforeAll(async () => {
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/search_test',
      ELASTICSEARCH_ENABLED: 'true',
      ELASTICSEARCH_URL: process.env.TEST_ELASTICSEARCH_URL,
      ELASTICSEARCH_ALLOW_HTTP: 'true',
      ELASTICSEARCH_USERNAME: process.env.TEST_ELASTICSEARCH_USERNAME,
      ELASTICSEARCH_PASSWORD: process.env.TEST_ELASTICSEARCH_PASSWORD,
      ELASTICSEARCH_API_KEY: process.env.TEST_ELASTICSEARCH_API_KEY,
      ELASTICSEARCH_CA_FILE: process.env.TEST_ELASTICSEARCH_CA_FILE,
      ELASTICSEARCH_INDEX_PREFIX: prefix,
    }).elasticsearch;
    client = new Client({
      node: config.url,
      auth: config.apiKey
        ? { apiKey: config.apiKey }
        : { username: config.username!, password: config.password! },
      maxRetries: 0,
      requestTimeout: 10000,
      tls: {
        rejectUnauthorized: true,
        ...(config.caFile ? { ca: readFileSync(config.caFile) } : {}),
      },
    });
    store = new ElasticsearchStore(config, client);
    for (const kind of ['metadata', 'pages'] as const)
      if (
        await client.indices.exists({ index: indexName(prefix, target, kind) })
      )
        throw new Error(
          'Random test index already exists; refusing cleanup ownership.',
        );
    // Track only the uniquely named resources this suite explicitly creates.
    try {
      await store.createIndexes(target);
    } finally {
      for (const kind of ['metadata', 'pages'] as const) {
        const index = indexName(prefix, target, kind);
        if (await client.indices.exists({ index })) {
          const inspected = await client.indices.get({ index });
          const meta = inspected[index].mappings?._meta;
          if (
            meta?.indexGenerationId === target.id &&
            meta?.generationFingerprint === target.fingerprint
          )
            created.push(index);
        }
      }
    }
  });
  afterAll(async () => {
    try {
      for (const index of created) {
        if (
          !index.startsWith(prefix + '-s1-') ||
          !index.includes(target.fingerprint)
        )
          throw new Error('Refusing unowned test cleanup.');
        await client.indices.delete({ index });
      }
    } finally {
      await store?.close();
    }
  });
  it('authenticates and inspects compatible explicit mappings without startup mutation', async () => {
    expect((await store.availability()).version).toMatch(/^9\.4\./);
    expect(await store.inspect(target, 'metadata')).toEqual({
      exists: true,
      compatible: true,
    });
    expect(await store.inspect(target, 'pages')).toEqual({
      exists: true,
      compatible: true,
    });
    const anonymous = new Client({
      node: process.env.TEST_ELASTICSEARCH_URL,
      maxRetries: 0,
      tls: {
        rejectUnauthorized: true,
        ...(process.env.TEST_ELASTICSEARCH_CA_FILE
          ? { ca: readFileSync(process.env.TEST_ELASTICSEARCH_CA_FILE) }
          : {}),
      },
    });
    try {
      await expect(anonymous.info()).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      await anonymous.close();
    }
  });
  it('writes complete bulk items, verifies deterministic IDs and preserves exact reference punctuation', async () => {
    await store.upsert(target, [record, page]);
    await store.upsert(target, [record, page]);
    const ids = [searchRecordId(record.projectionId, { kind: 'metadata' })];
    expect(await store.verify(target, 'metadata', owner, record, ids)).toEqual([
      record,
    ]);
    const exact = await client.search({
      index: indexName(prefix, target, 'metadata'),
      query: {
        bool: {
          filter: [
            { term: { userId: owner } },
            { term: { indexGenerationId: target.id } },
            { term: { projectionId: record.projectionId } },
            { term: { referenceExact: 'ref/ab-1' } },
          ],
        },
      },
    });
    expect(exact.hits.hits).toHaveLength(1);
  });
  it('queries scoped metadata, phrase text and prefix fields without foreign-owner leakage', async () => {
    const foreignVersion = randomUUID();
    const foreign = {
      ...record,
      userId: randomUUID(),
      documentVersionId: foreignVersion,
      documentId: randomUUID(),
      projectionId: searchProjectionId(foreignVersion, target.id, 1),
    };
    await store.upsert(target, [foreign]);
    for (const mode of ['terms', 'phrase', 'prefix'] as const)
      expect(
        await store.query(target, 'metadata', {
          userId: owner,
          scopes: [record],
          text: mode === 'prefix' ? 'Qyv' : 'private',
          mode,
          limit: 10,
        }),
      ).toHaveLength(1);
    expect(
      await store.query(target, 'pages', {
        userId: owner,
        scopes: [record],
        text: 'private phrase',
        mode: 'phrase',
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(
      await store.query(target, 'metadata', {
        userId: foreign.userId,
        scopes: [record],
        text: 'private',
        mode: 'terms',
        limit: 10,
      }),
    ).toHaveLength(0);
  });
  it('rejects dynamic fields and inspects changed mappings as incompatible', async () => {
    await expect(
      client.index({
        index: indexName(prefix, target, 'metadata'),
        id: 'invalid-fixture',
        document: { unapproved: 'value' },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await client.indices.putMapping({
      index: indexName(prefix, target, 'pages'),
      properties: { unapproved: { type: 'keyword' } },
    });
    expect(await store.inspect(target, 'pages')).toEqual({
      exists: true,
      compatible: false,
    });
  });
  it('removes exact owned IDs idempotently without deleting indexes', async () => {
    const ids = [searchRecordId(record.projectionId, { kind: 'metadata' })];
    await store.remove(target, 'metadata', owner, record, ids);
    await store.remove(target, 'metadata', owner, record, ids);
    expect(await store.verify(target, 'metadata', owner, record, ids)).toEqual(
      [],
    );
    expect(
      await client.indices.exists({
        index: indexName(prefix, target, 'metadata'),
      }),
    ).toBe(true);
  });
});
