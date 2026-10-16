import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { Client } from '@elastic/elasticsearch';
import { randomUUID } from 'node:crypto';
import { searchProjectionId, searchRecordId } from '@qyvra/database';
import { Test } from '@nestjs/testing';
import { validateTestEnvironment } from '../../../test/configuration.fixture';
import { settings } from '../../configuration/configuration.module';
import {
  ElasticsearchStore,
  normalizeSearchError,
} from './elasticsearch-store';
import {
  LEXICAL_STORE,
  LexicalStore,
  SearchMetadataRecord,
} from './lexical-store';
import {
  indexDefinition,
  indexName,
  recordValid,
  targetFromGeneration,
  SEARCH_MAPPING_VERSION,
  SEARCH_ANALYZER_VERSION,
  SEARCH_SEGMENTATION_VERSION,
} from './search-index';
import { LexicalStoreModule } from './lexical-store.module';

const config = validateTestEnvironment({
  DATABASE_URL: 'postgresql://localhost/search_test',
  ELASTICSEARCH_ENABLED: 'true',
  ELASTICSEARCH_URL: 'http://127.0.0.1:9200',
  ELASTICSEARCH_ALLOW_HTTP: 'true',
  ELASTICSEARCH_USERNAME: 'fixture',
  ELASTICSEARCH_PASSWORD: 'synthetic-fixture-password',
}).elasticsearch;
const target = { id: randomUUID(), generation: 1, fingerprint: 'a'.repeat(64) };
const version = randomUUID();
const record: SearchMetadataRecord = {
  kind: 'metadata',
  userId: randomUUID(),
  documentId: randomUUID(),
  documentVersionId: version,
  projectionId: searchProjectionId(version, target.id, 1),
  revision: 1,
  indexGenerationId: target.id,
  sourceHash: 'b'.repeat(64),
  title: 'A private report',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  documentType: 'OTHER',
  status: 'UPLOADED',
  tagIds: [],
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
  fileSize: 12,
};
const id = searchRecordId(record.projectionId, { kind: 'metadata' });
function fixture() {
  const client = {
    info: jest.fn().mockResolvedValue({ version: { number: '9.4.6' } }),
    cluster: {
      health: jest
        .fn()
        .mockResolvedValue({ status: 'yellow', timed_out: false }),
      getSettings: jest.fn().mockResolvedValue({
        persistent: {},
        transient: {},
        defaults: { action: { auto_create_index: 'false' } },
      }),
    },
    indices: {
      exists: jest.fn().mockResolvedValue(true),
      get: jest
        .fn()
        .mockImplementation(async ({ index }: { index: string }) => {
          const kind = index.endsWith('-metadata') ? 'metadata' : 'pages';
          const d = indexDefinition(target, kind);
          return {
            [index]: {
              aliases: {},
              mappings: structuredClone(d.mappings),
              settings: { index: { analysis: d.settings.analysis } },
            },
          };
        }),
      create: jest.fn().mockResolvedValue({ acknowledged: true }),
    },
    bulk: jest.fn().mockResolvedValue({
      errors: false,
      items: [
        {
          index: {
            _id: id,
            _index: indexName(config.indexPrefix, target, 'metadata'),
            status: 201,
          },
        },
      ],
    }),
    mget: jest.fn().mockResolvedValue({
      docs: [
        {
          _id: id,
          _index: indexName(config.indexPrefix, target, 'metadata'),
          found: true,
          _source: record,
        },
      ],
    }),
    search: jest.fn().mockResolvedValue({
      timed_out: false,
      _shards: { failed: 0 },
      hits: {
        hits: [
          {
            _id: id,
            _index: indexName(config.indexPrefix, target, 'metadata'),
            _score: 1,
            sort: [record.projectionId],
            _source: record,
          },
        ],
      },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    client,
    store: new ElasticsearchStore(config, client as unknown as Client),
  };
}
describe('private Elasticsearch boundary', () => {
  it('operator scans are bounded, owner/generation filtered and omit content even if the transport returns extra fields', async () => {
    const { client, store } = fixture();
    const page = await store.scan(
      target,
      'metadata',
      record.userId,
      undefined,
      1,
    );
    expect(page.records).toEqual([
      {
        id,
        userId: record.userId,
        documentId: record.documentId,
        documentVersionId: record.documentVersionId,
        projectionId: record.projectionId,
        revision: record.revision,
        sourceHash: record.sourceHash,
      },
    ]);
    const request = client.search.mock.calls[0][0];
    expect(request.query.bool.filter).toEqual([
      { term: { userId: record.userId } },
      { term: { indexGenerationId: target.id } },
    ]);
    expect(request._source).not.toContain('title');
    expect(request._source).not.toContain('text');
    await expect(
      store.scan(target, 'metadata', record.userId, undefined, 101),
    ).rejects.toMatchObject({ code: 'SEARCH_CONTRACT_INVALID' });
    await expect(
      store.scan(target, 'metadata', record.userId, ['*'], 1),
    ).rejects.toMatchObject({ code: 'SEARCH_CONTRACT_INVALID' });
  });
  it('is available through one DI token with disabled zero-I/O startup', async () => {
    const module = await Test.createTestingModule({
      imports: [LexicalStoreModule],
    })
      .overrideProvider(settings.KEY)
      .useValue(
        validateTestEnvironment({
          DATABASE_URL: 'postgresql://localhost/search_test',
        }),
      )
      .compile();
    const store = module.get<LexicalStore>(LEXICAL_STORE);
    await expect(store.availability()).rejects.toMatchObject({
      code: 'SEARCH_NOT_CONFIGURED',
    });
    await module.close();
  });
  it('rejects missing/oversized secrets and invalid CA files without exposing values or paths', () => {
    const root = resolve(__dirname, '../../../../../.tools');
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, 'search-secret-test-'));
    const secret = join(directory, 'secret'),
      ca = join(directory, 'ca');
    try {
      const { client } = fixture();
      expect(
        () =>
          new ElasticsearchStore(
            { ...config, password: undefined, passwordFile: secret },
            client as unknown as Client,
          ),
      ).toThrow('SEARCH_CONTRACT_INVALID');
      writeFileSync(secret, 'x'.repeat(8193));
      expect(
        () =>
          new ElasticsearchStore(
            { ...config, password: undefined, passwordFile: secret },
            client as unknown as Client,
          ),
      ).toThrow('SEARCH_CONTRACT_INVALID');
      writeFileSync(secret, 'SyntheticPrivateFixture123');
      expect(
        () =>
          new ElasticsearchStore(
            { ...config, password: undefined, passwordFile: secret },
            client as unknown as Client,
          ),
      ).not.toThrow();
      writeFileSync(ca, 'invalid non-certificate fixture');
      expect(
        () =>
          new ElasticsearchStore(
            { ...config, caFile: ca },
            client as unknown as Client,
          ),
      ).toThrow('SEARCH_CONTRACT_INVALID');
    } finally {
      expect(dirname(directory)).toBe(root);
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('validates version, cluster readiness and disabled automatic index creation', async () => {
    const { store, client } = fixture();
    expect(await store.availability()).toEqual({
      available: true,
      version: '9.4.6',
    });
    client.info.mockResolvedValueOnce({ version: { number: '8.19.0' } });
    await expect(store.availability()).rejects.toMatchObject({
      code: 'SEARCH_INDEX_INCOMPATIBLE',
    });
    client.cluster.getSettings.mockResolvedValueOnce({
      persistent: {},
      transient: {},
      defaults: { action: { auto_create_index: 'true' } },
    });
    await expect(store.availability()).rejects.toMatchObject({
      code: 'SEARCH_INDEX_INCOMPATIBLE',
    });
    client.cluster.health.mockResolvedValueOnce({
      status: 'red',
      timed_out: false,
    });
    await expect(store.availability()).rejects.toMatchObject({
      code: 'SEARCH_UNAVAILABLE',
    });
  });
  it('inspects exact mappings/analysis and never recreates incompatible indexes', async () => {
    const { store, client } = fixture();
    expect(await store.inspect(target, 'metadata')).toEqual({
      exists: true,
      compatible: true,
    });
    const d = indexDefinition(target, 'metadata');
    client.indices.get.mockResolvedValue({
      [indexName(config.indexPrefix, target, 'metadata')]: {
        mappings: {
          ...d.mappings,
          properties: { ...d.mappings.properties, userId: { type: 'text' } },
        },
        settings: { index: { analysis: d.settings.analysis } },
      },
    });
    await expect(store.createIndexes(target)).rejects.toMatchObject({
      code: 'SEARCH_INDEX_INCOMPATIBLE',
    });
    expect(client.indices.create).not.toHaveBeenCalled();
    client.indices.exists.mockResolvedValue(false);
    await store.createIndexes(target);
    expect(client.indices.create).toHaveBeenCalledTimes(2);
  });
  it('accepts canonical server defaults but rejects disabled fields and changed copy targets', async () => {
    const { store, client } = fixture();
    const d = indexDefinition(target, 'metadata');
    const mappings = structuredClone(d.mappings) as unknown as {
      _source?: { enabled: boolean };
      properties: Record<string, Record<string, unknown>>;
    };
    delete mappings._source;
    for (const field of Object.values(mappings.properties)) {
      if (field.type === 'keyword') {
        delete field.index;
        delete field.doc_values;
      }
      if (typeof field.copy_to === 'string') field.copy_to = [field.copy_to];
    }
    client.indices.get.mockImplementation(async () => ({
      [indexName(config.indexPrefix, target, 'metadata')]: {
        mappings,
        settings: { index: { analysis: d.settings.analysis } },
      },
    }));
    expect((await store.inspect(target, 'metadata')).compatible).toBe(true);
    for (const option of ['index', 'doc_values']) {
      mappings.properties.userId[option] = false;
      expect((await store.inspect(target, 'metadata')).compatible).toBe(false);
      delete mappings.properties.userId[option];
    }
    mappings._source = { enabled: false };
    expect((await store.inspect(target, 'metadata')).compatible).toBe(false);
    delete mappings._source;
    mappings.properties.title.copy_to = ['suggestText', 'unexpected'];
    expect((await store.inspect(target, 'metadata')).compatible).toBe(false);
  });
  it('rejects index-name injection and schema/lineage mismatch', () => {
    expect(indexName(config.indexPrefix, target, 'metadata')).toMatch(
      /^qyvra-search-s1-g1-[a-f0-9]{64}-metadata$/,
    );
    for (const prefix of [
      '*',
      'other',
      'qyvra-search-*',
      'qyvra-search/foreign',
    ])
      expect(() => indexName(prefix, target, 'pages')).toThrow(
        'SEARCH_CONTRACT_INVALID',
      );
    expect(() =>
      recordValid({ ...record, projectionId: randomUUID() }, target),
    ).toThrow('SEARCH_CONTRACT_INVALID');
    expect(() =>
      recordValid({ ...record, documentDate: '2026-02-30' }, target),
    ).toThrow('SEARCH_CONTRACT_INVALID');
  });
  it('rejects incompatible persisted generation names and versions without renaming', () => {
    const generation = {
      ...target,
      schemaVersion: 1,
      mappingVersion: SEARCH_MAPPING_VERSION,
      analyzerVersion: SEARCH_ANALYZER_VERSION,
      segmentationVersion: SEARCH_SEGMENTATION_VERSION,
      metadataIndexName: indexName(config.indexPrefix, target, 'metadata'),
      pageIndexName: indexName(config.indexPrefix, target, 'pages'),
    };
    expect(targetFromGeneration(config.indexPrefix, generation)).toEqual(
      target,
    );
    expect(() =>
      targetFromGeneration(config.indexPrefix, {
        ...generation,
        metadataIndexName: 'qyvra-search-old-metadata',
      }),
    ).toThrow('SEARCH_CONTRACT_INVALID');
    expect(() =>
      targetFromGeneration(config.indexPrefix, {
        ...generation,
        mappingVersion: 'unknown',
      }),
    ).toThrow('SEARCH_CONTRACT_INVALID');
  });
  it('writes deterministic bounded bulk payloads with normalized punctuation-preserving reference', async () => {
    const { store, client } = fixture();
    await store.upsert(target, [{ ...record, referenceNumber: ' REF/Ab-1 ' }]);
    expect(client.bulk.mock.calls[0][0]).toMatchObject({
      refresh: 'wait_for',
      operations: [{ index: { _id: id } }, { referenceExact: 'ref/ab-1' }],
    });
    expect(client.bulk.mock.calls[0][1]).toMatchObject({
      maxRetries: 0,
      retryOnTimeout: false,
      requestTimeout: 10000,
    });
    await expect(store.upsert(target, [record, record])).rejects.toMatchObject({
      code: 'SEARCH_CONTRACT_INVALID',
    });
    const tiny = new ElasticsearchStore(
      { ...config, maxRequestBytes: 10 },
      client as unknown as Client,
    );
    await expect(tiny.upsert(target, [record])).rejects.toMatchObject({
      code: 'SEARCH_CONTRACT_INVALID',
    });
    const untrusted = {
      ...record,
      storageKey: 'private/path',
    } as SearchMetadataRecord;
    await expect(store.upsert(target, [untrusted])).rejects.toMatchObject({
      code: 'SEARCH_CONTRACT_INVALID',
    });
  });
  it.each([400, 401, 409, 429, 503])(
    'fails per-item bulk errors rather than accepting HTTP 200 (item %s)',
    async (status) => {
      const { store, client } = fixture();
      client.bulk.mockResolvedValue({
        errors: true,
        items: [
          {
            index: {
              _id: id,
              _index: indexName(config.indexPrefix, target, 'metadata'),
              status,
              error: { type: 'fixture' },
            },
          },
        ],
      });
      await expect(store.upsert(target, [record])).rejects.toMatchObject({
        code: normalizeSearchError({ statusCode: status }).code,
      });
    },
  );
  it('rejects truncated, mismatched and falsely clean bulk replies', async () => {
    const { store, client } = fixture();
    client.bulk.mockResolvedValue({ errors: false, items: [] });
    await expect(store.upsert(target, [record])).rejects.toMatchObject({
      code: 'SEARCH_CONTRACT_INVALID',
    });
    client.bulk.mockResolvedValue({
      errors: false,
      items: [{ index: { _id: 'foreign', status: 201 } }],
    });
    await expect(store.upsert(target, [record])).rejects.toMatchObject({
      code: 'SEARCH_CONTRACT_INVALID',
    });
  });
  it('verifies owned exact records and removes only those deterministic IDs, including missing duplicates', async () => {
    const { store, client } = fixture();
    expect(
      await store.verify(target, 'metadata', record.userId, record, [id]),
    ).toEqual([record]);
    client.bulk.mockResolvedValue({
      errors: true,
      items: [
        {
          delete: {
            _id: id,
            _index: indexName(config.indexPrefix, target, 'metadata'),
            status: 404,
          },
        },
      ],
    });
    await store.remove(target, 'metadata', record.userId, record, [id]);
    expect(client.bulk.mock.calls[0][0].operations).toEqual([
      {
        delete: {
          _index: indexName(config.indexPrefix, target, 'metadata'),
          _id: id,
        },
      },
    ]);
    await expect(
      store.remove(target, 'metadata', randomUUID(), record, [id]),
    ).rejects.toMatchObject({ code: 'SEARCH_CONTRACT_INVALID' });
    await expect(
      store.remove(target, 'metadata', record.userId, record, ['*']),
    ).rejects.toMatchObject({ code: 'SEARCH_CONTRACT_INVALID' });
    expect(client.bulk).toHaveBeenCalledTimes(1);
  });
  it.each(['terms', 'phrase', 'prefix'] as const)(
    'constructs bounded %s queries with mandatory owner/generation/exact tuple filters',
    async (mode) => {
      const { store, client } = fixture();
      expect(
        await store.query(target, 'metadata', {
          userId: record.userId,
          scopes: [record],
          text: 'private',
          mode,
          limit: 5,
        }),
      ).toHaveLength(1);
      const request = client.search.mock.calls[0][0];
      expect(request.query.bool.filter).toEqual(
        expect.arrayContaining([
          { term: { userId: record.userId } },
          { term: { indexGenerationId: target.id } },
        ]),
      );
      expect(request.query.bool.filter[2].bool.should[0].bool.filter).toEqual(
        expect.arrayContaining([
          { term: { projectionId: record.projectionId } },
          { term: { revision: 1 } },
          { term: { documentVersionId: version } },
        ]),
      );
      expect(request.allow_partial_search_results).toBe(false);
      expect(request.size).toBe(5);
      expect(request.sort).toEqual([
        { _score: { order: 'desc' } },
        { documentId: 'asc' },
        { projectionId: 'asc' },
      ]);
      if (mode !== 'prefix') {
        expect(request.query.bool.should[0].multi_match.fields).toEqual([
          'title^3',
          'description',
          'issuer^2',
          'referenceNumber^3',
          'filename^2',
        ]);
        expect(request.query.bool.should[1]).toEqual({
          term: { referenceExact: { value: 'private', boost: 8 } },
        });
        expect(JSON.stringify(request)).not.toContain('query_string');
      }
    },
  );
  it('rejects unscoped, partial, timed-out and foreign search results', async () => {
    const { store, client } = fixture();
    const q = {
      userId: record.userId,
      scopes: [record],
      text: 'private',
      mode: 'terms' as const,
      limit: 5,
    };
    await expect(
      store.query(target, 'metadata', { ...q, scopes: [] }),
    ).rejects.toMatchObject({ code: 'SEARCH_CONTRACT_INVALID' });
    client.search.mockResolvedValueOnce({
      timed_out: true,
      _shards: { failed: 0 },
      hits: { hits: [] },
    });
    await expect(store.query(target, 'metadata', q)).rejects.toMatchObject({
      code: 'SEARCH_UNAVAILABLE',
    });
    client.search.mockResolvedValueOnce({
      timed_out: false,
      _shards: { failed: 0 },
      hits: {
        hits: [
          {
            _id: id,
            _index: indexName(config.indexPrefix, target, 'metadata'),
            _score: 1,
            _source: { ...record, userId: randomUUID() },
          },
        ],
      },
    });
    await expect(store.query(target, 'metadata', q)).rejects.toMatchObject({
      code: 'SEARCH_CONTRACT_INVALID',
    });
  });
  it('enforces cancellation, concurrency limits and shutdown without success placeholders', async () => {
    const { store, client } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(store.availability(controller.signal)).rejects.toMatchObject({
      code: 'SEARCH_CANCELLED',
    });
    expect(client.info).not.toHaveBeenCalled();
    let resolve!: (value: { version: { number: string } }) => void;
    client.info.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const bounded = new ElasticsearchStore(
      { ...config, concurrency: 1 },
      client as unknown as Client,
    );
    const pending = bounded.availability();
    await expect(bounded.availability()).rejects.toMatchObject({
      code: 'SEARCH_CAPACITY',
      retryable: true,
    });
    resolve({ version: { number: '9.4.6' } });
    await pending;
    await bounded.close();
    await expect(bounded.availability()).rejects.toMatchObject({
      code: 'SEARCH_CANCELLED',
    });
  });
  it('sanitizes sensitive SDK errors and separates permanent/transient categories', () => {
    for (const status of [400, 401, 403, 404, 409])
      expect(
        normalizeSearchError({
          meta: { statusCode: status },
          message: 'secret request body',
        }).retryable,
      ).toBe(false);
    for (const status of [429, 500, 503])
      expect(normalizeSearchError({ statusCode: status }).retryable).toBe(true);
    expect(
      JSON.stringify(
        normalizeSearchError({
          meta: { statusCode: 401 },
          credentials: 'secret',
        }),
      ),
    ).not.toContain('secret');
    expect(normalizeSearchError({ name: 'TimeoutError' }).code).toBe(
      'SEARCH_TIMEOUT',
    );
  });
});

describe('search-visible publication verification', () => {
  function publicationFixture() {
    const f = fixture();
    f.client.search.mockImplementation(
      async ({ index, size }: { index: string; size: number }) => ({
        timed_out: false,
        _shards: { failed: 0 },
        hits: {
          total: { relation: 'eq', value: index.endsWith('-metadata') ? 1 : 0 },
          hits: size ? [{ _id: id, _index: index, _source: record }] : [],
        },
      }),
    );
    return f;
  }
  it('checks exact scope cardinality and visible contents, including zero pages', async () => {
    const { store, client } = publicationFixture();
    await store.verifyPublication(target, record.userId, record, [record]);
    expect(client.search).toHaveBeenCalledTimes(3);
    for (const [request] of client.search.mock.calls) {
      expect(request.query.bool.filter).toContainEqual({
        term: { userId: record.userId },
      });
      expect(request.query.bool.filter).toContainEqual({
        term: { projectionId: record.projectionId },
      });
      expect(request.track_total_hits).toBe(true);
      expect(request.allow_partial_search_results).toBe(false);
    }
    expect(client.mget).not.toHaveBeenCalled();
    await store.close();
  });
  it.each(['missing', 'extra', 'partial', 'timeout', 'approximate'])(
    'rejects %s search evidence',
    async (mode) => {
      const { store, client } = publicationFixture();
      client.search.mockResolvedValueOnce({
        timed_out: mode === 'timeout',
        _shards: { failed: mode === 'partial' ? 1 : 0 },
        hits: {
          total: {
            relation: mode === 'approximate' ? 'gte' : 'eq',
            value: mode === 'missing' ? 0 : mode === 'extra' ? 2 : 1,
          },
          hits: [],
        },
      });
      await expect(
        store.verifyPublication(target, record.userId, record, [record]),
      ).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
      await store.close();
    },
  );
  it('rejects modified contents even if IDs and cardinality match', async () => {
    const { store, client } = publicationFixture();
    client.search
      .mockResolvedValueOnce({
        timed_out: false,
        _shards: { failed: 0 },
        hits: { total: { relation: 'eq', value: 1 }, hits: [] },
      })
      .mockResolvedValueOnce({
        timed_out: false,
        _shards: { failed: 0 },
        hits: {
          total: { relation: 'eq', value: 1 },
          hits: [
            {
              _id: id,
              _index: indexName(config.indexPrefix, target, 'metadata'),
              _source: { ...record, title: 'Altered' },
            },
          ],
        },
      });
    await expect(
      store.verifyPublication(target, record.userId, record, [record]),
    ).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    await store.close();
  });
});

describe('T08 bounded highlight and suggestion requests', () => {
  it('decodes only server-marked fragments and leaves document HTML as inert text', async () => {
    const { client, store } = fixture();
    client.search.mockImplementation(
      async (req: {
        highlight?: { pre_tags: string[]; post_tags: string[] };
      }) => ({
        timed_out: false,
        _shards: { failed: 0 },
        hits: {
          hits: [
            {
              _id: id,
              _index: indexName(config.indexPrefix, target, 'metadata'),
              _score: 1,
              _source: record,
              highlight: {
                title: [
                  `A ${req.highlight!.pre_tags[0]}private${req.highlight!.post_tags[0]} report`,
                ],
              },
            },
          ],
        },
      }),
    );
    const hits = await store.query(target, 'metadata', {
      userId: record.userId,
      scopes: [record],
      text: 'private',
      mode: 'terms',
      limit: 2,
    });
    expect(hits[0].highlights).toEqual([
      {
        field: 'title',
        text: 'A private report',
        ranges: [{ start: 2, end: 9 }],
      },
    ]);
    const req = client.search.mock.calls[0][0];
    expect(req.highlight).toMatchObject({
      type: 'unified',
      encoder: 'default',
      require_field_match: true,
    });
    expect(JSON.stringify(req.highlight)).not.toContain('<mark>');
  });
  it('restricts prefix sources and exact-record enrichment without changing mandatory owner scope', async () => {
    const { client, store } = fixture();
    await store.query(target, 'metadata', {
      userId: record.userId,
      scopes: [record],
      text: 'priv',
      mode: 'prefix',
      limit: 5,
    });
    expect(
      client.search.mock.calls[0][0].query.bool.must[0].multi_match.fields,
    ).toEqual(['title', 'issuer', 'referenceNumber']);
    expect(client.search.mock.calls[0][0].highlight).toBeUndefined();
    await store.query(target, 'metadata', {
      userId: record.userId,
      scopes: [record],
      text: 'private',
      mode: 'terms',
      limit: 1,
      recordIds: [id],
    });
    expect(client.search.mock.calls[1][0].query.bool.filter).toContainEqual({
      ids: { values: [id] },
    });
  });
  it('retries optional highlight capacity once as plain search, preserving authorization', async () => {
    const { client, store } = fixture();
    client.search.mockRejectedValueOnce({ statusCode: 400 });
    await expect(
      store.query(target, 'metadata', {
        userId: record.userId,
        scopes: [record],
        text: 'private',
        mode: 'terms',
        limit: 1,
      }),
    ).resolves.toHaveLength(1);
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(client.search.mock.calls[1][0].highlight).toBeUndefined();
    expect(client.search.mock.calls[1][0].query).toEqual(
      client.search.mock.calls[0][0].query,
    );
  });
});
