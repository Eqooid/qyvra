import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigurationService } from '../../configuration/configuration.module';
import { StructuredLogger } from '../../common/structured-logger';
import { validateTestEnvironment } from '../../../test/configuration.fixture';
import {
  searchGenerationFingerprint,
  searchProjectionId,
} from '@qyvra/database';
import { PDF_EXTRACTOR } from '../../infrastructure/extraction/pdf-parser';
import {
  indexName,
  recordId,
  SEARCH_MAPPING_VERSION,
  SEARCH_ANALYZER_VERSION,
  SEARCH_SEGMENTATION_VERSION,
} from '../../infrastructure/search/search-index';
import {
  SearchStoreFailure,
  type LexicalStore,
  type SearchMetadataRecord,
} from '../../infrastructure/search/lexical-store';
import { KeywordSearchDto } from './keyword-search.dto';
import {
  KeywordSearchRepository,
  type CanonicalKeywordHit,
} from './keyword-search.repository';
import {
  keywordSnippet,
  normalizeKeywordInput,
  KeywordSearchService,
} from './keyword-search.service';

const identity = {
  schemaVersion: 1,
  mappingVersion: SEARCH_MAPPING_VERSION,
  analyzerVersion: SEARCH_ANALYZER_VERSION,
  segmentationVersion: SEARCH_SEGMENTATION_VERSION,
  ...PDF_EXTRACTOR,
};
const target = {
  id: randomUUID(),
  generation: 1,
  fingerprint: searchGenerationFingerprint(identity),
};
const owner = randomUUID(),
  version = randomUUID(),
  documentId = randomUUID(),
  projectionId = searchProjectionId(version, target.id, 1);
const record: SearchMetadataRecord = {
  kind: 'metadata',
  userId: owner,
  documentId,
  documentVersionId: version,
  projectionId,
  revision: 1,
  indexGenerationId: target.id,
  sourceHash: 'a'.repeat(64),
  title: 'Untrusted ES title',
  filename: 'fixture.pdf',
  mimeType: 'application/pdf',
  documentType: 'OTHER',
  status: 'UPLOADED',
  tagIds: [],
  fileSize: 20,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
};
const source: CanonicalKeywordHit = {
  recordId: recordId(record),
  kind: 'metadata',
  documentId,
  documentVersionId: version,
  projectionId,
  title: 'Canonical title',
  originalFilename: 'fixture.pdf',
  versionNumber: 1,
  mimeType: 'application/pdf',
  documentType: 'OTHER',
  status: 'UPLOADED',
  categoryId: null,
  tagIds: [],
  description: null,
  issuer: null,
  referenceNumber: null,
  excerpt: null,
  pageNumber: null,
  extractedTextId: null,
  startOffset: null,
};
function fixture(extra: Record<string, string> = {}) {
  const config = validateTestEnvironment({
    DATABASE_URL: 'postgresql://localhost/search_test',
    ELASTICSEARCH_ENABLED: 'true',
    ELASTICSEARCH_URL: 'http://127.0.0.1:9200',
    ELASTICSEARCH_ALLOW_HTTP: 'true',
    ELASTICSEARCH_USERNAME: 'fixture',
    ELASTICSEARCH_PASSWORD: 'synthetic-fixture-password',
    KEYWORD_SEARCH_ENABLED: 'true',
    KEYWORD_SEARCH_GENERATION_FINGERPRINT: target.fingerprint,
    ...extra,
  });
  const scopes = [
    {
      documentId,
      documentVersionId: version,
      projectionId,
      revision: 1,
      metadataHash: record.sourceHash,
      textCoverage: 'PENDING',
    },
  ];
  const coverage = {
    eligibleDocuments: 1,
    metadataReadyDocuments: 1,
    textReadyDocuments: 0,
  };
  const repository = {
    authorizeDocuments: jest.fn().mockResolvedValue(undefined),
    generation: jest.fn().mockResolvedValue({
      ...target,
      ...identity,
      metadataIndexName: indexName('qyvra-search', target, 'metadata'),
      pageIndexName: indexName('qyvra-search', target, 'pages'),
    }),
    scope: jest.fn().mockResolvedValue({ scopes, coverage }),
    finalize: jest
      .fn()
      .mockResolvedValue({ scopes, coverage, sources: [source] }),
  };
  const store = {
    availability: jest
      .fn()
      .mockResolvedValue({ available: true, version: '9.4.6' }),
    inspect: jest.fn().mockResolvedValue({ exists: true, compatible: true }),
    query: jest
      .fn()
      .mockResolvedValue([{ id: recordId(record), score: 2, record }]),
  };
  const event = jest.fn();
  const service = new KeywordSearchService(
    repository as unknown as KeywordSearchRepository,
    new ConfigurationService(config),
    store as unknown as LexicalStore,
    { event } as unknown as StructuredLogger,
  );
  return { service, repository, store, event, config };
}
describe('keyword validation, plain snippets and pagination boundary', () => {
  it.each([
    { query: '' },
    { query: '  ' },
    { query: 'x'.repeat(4001) },
    { query: 'unsafe\nquery' },
    { query: '\ud800' },
    { query: '\udfff' },
    { query: 'hello', userId: owner },
    { query: 'hello', index: 'foreign' },
    { query: 'hello', filters: { archived: true } },
    { query: 'hello', filters: { createdFrom: '2026-02-30' } },
    {
      query: 'hello',
      filters: { createdFrom: '2026-10-14', createdTo: '2026-10-01' },
    },
    { query: 'hello', limit: 0 },
    { query: 'hello', limit: '2' },
    { query: 'hello', limit: 21 },
    { query: 'hello', limit: null },
    { query: 'hello', match: 'wildcard' },
    { query: 'hello', sort: 'title' },
    { query: 'hello', filters: null },
    { query: 'hello', documentIds: [owner, owner] },
    { query: 'hello', filters: { tagIds: [] } },
    { query: 'a '.repeat(65) },
    { query: 'hello', cursor: 'bad!cursor' },
  ])('rejects invalid input %j', (input) => {
    expect(() =>
      normalizeKeywordInput(input as unknown as KeywordSearchDto),
    ).toThrow(BadRequestException);
  });
  it('normalizes NFC, lowercase IDs and preserves literal punctuation', () => {
    expect(
      normalizeKeywordInput({
        query: '  e\u0301 REF/AB-1* ',
        documentIds: [owner.toUpperCase()],
      }),
    ).toMatchObject({ query: '\u00e9 REF/AB-1*', documentIds: [owner] });
  });
  it('rejects continuation explicitly until T07 rather than accepting a forged cursor', () => {
    expect(() =>
      normalizeKeywordInput({ query: 'hello', cursor: 'opaque-token' }),
    ).toThrow(ConflictException);
  });
  it('returns bounded exact Unicode snippets as plain strings with canonical offsets', () => {
    const text = '\u{1f600}'.repeat(600) + ' <script>alert(1)</script> Qyvra';
    const snippet = keywordSnippet(text, 'Qyvra', 100);
    expect(Array.from(snippet.snippet).length).toBeLessThanOrEqual(400);
    expect(
      Array.from(text)
        .slice(snippet.startOffset - 100, snippet.endOffset - 100)
        .join(''),
    ).toBe(snippet.snippet);
    expect(snippet.snippet).toContain('<script>'); // Plain JSON text; never an HTML highlight payload.
  });
});
describe('authorized model-independent keyword service', () => {
  it('bounds page candidates by the configured response-byte ceiling', async () => {
    const f = fixture();
    f.repository.scope.mockResolvedValue({
      scopes: [
        {
          documentId,
          documentVersionId: version,
          projectionId,
          revision: 1,
          metadataHash: record.sourceHash,
          textCoverage: 'READY',
        },
      ],
      coverage: {
        eligibleDocuments: 1,
        metadataReadyDocuments: 1,
        textReadyDocuments: 1,
      },
    });
    f.store.query.mockImplementation(async (_target, kind) =>
      kind === 'pages' ? [] : [{ id: recordId(record), score: 2, record }],
    );
    await f.service.search(owner, { query: 'Canonical' });
    expect(
      f.store.query.mock.calls.find((call) => call[1] === 'pages')?.[2],
    ).toMatchObject({ limit: 104 });
  });

  it('uses only SQL-authorized scopes and canonical metadata; skips PDF work without READY text', async () => {
    const f = fixture();
    const result = await f.service.search(owner, { query: 'Canonical' });
    expect(f.store.query).toHaveBeenCalledTimes(1);
    expect(f.store.query.mock.calls[0][2]).toMatchObject({
      userId: owner,
      text: 'Canonical',
      mode: 'terms',
      limit: 200,
    });
    expect(result.results[0]).toMatchObject({
      title: 'Canonical title',
      matches: [{ kind: 'metadata', snippet: 'Canonical title' }],
    });
    expect(JSON.stringify(result)).not.toContain('Untrusted ES title');
    expect(result.pagination).toEqual({
      nextCursor: null,
      hasMore: false,
      paginationAvailable: false,
      truncated: false,
    });
  });
  it('omits foreign and stale tuples before hydration and leaks none of their metadata or scores', async () => {
    const f = fixture();
    f.store.query.mockResolvedValue([
      {
        id: recordId(record),
        score: 500,
        record: { ...record, userId: randomUUID() },
      },
    ]);
    f.repository.finalize.mockResolvedValue({
      coverage: {
        eligibleDocuments: 0,
        metadataReadyDocuments: 0,
        textReadyDocuments: 0,
      },
      scopes: [],
      sources: [],
    });
    const result = await f.service.search(owner, { query: 'foreign' });
    expect(f.repository.finalize.mock.calls[0][4]).toEqual([]);
    expect(result.results).toEqual([]);
    expect(result.pagination.hasMore).toBe(false);
  });
  it('returns the canonical punctuation-preserving exact reference even with compatibility Unicode', async () => {
    const f = fixture();
    f.repository.finalize.mockResolvedValue({
      scopes: [record],
      coverage: {
        eligibleDocuments: 1,
        metadataReadyDocuments: 1,
        textReadyDocuments: 0,
      },
      sources: [
        {
          ...source,
          referenceNumber: '\uFF32\uFF25\uFF26\uFF0F\uFF21\uFF22\uFF0D1',
        },
      ],
    });
    const result = await f.service.search(owner, { query: 'REF/AB-1' });
    expect(result.results[0].matches[0]).toMatchObject({
      kind: 'metadata',
      snippet: '\uFF32\uFF25\uFF26\uFF0F\uFF21\uFF22\uFF0D1',
      matchedFields: ['referenceNumber'],
    });
  });
  it('does not label word substrings as matched metadata fields', async () => {
    const f = fixture();
    f.repository.finalize.mockResolvedValue({
      scopes: [record],
      coverage: {
        eligibleDocuments: 1,
        metadataReadyDocuments: 1,
        textReadyDocuments: 0,
      },
      sources: [{ ...source, title: 'Report', issuer: 'or' }],
    });
    const result = await f.service.search(owner, { query: 'or' });
    expect(result.results[0].matches[0]).toMatchObject({
      snippet: 'or',
      matchedFields: ['issuer'],
    });
  });
  it('never bypasses SQL on failure', async () => {
    const f = fixture();
    f.repository.finalize.mockRejectedValue(Error('SQL fixture failure'));
    await expect(
      f.service.search(owner, { query: 'Canonical' }),
    ).rejects.toThrow('SQL fixture failure');
    expect(f.event.mock.calls[0][2]).toEqual({ category: 'SEARCH_FAILED' });
  });
  it.each([
    'SEARCH_UNAVAILABLE',
    'SEARCH_AUTH_FAILED',
    'SEARCH_INDEX_INCOMPATIBLE',
  ] as const)('normalizes %s without payload leakage', async (code) => {
    const f = fixture();
    f.store.query.mockRejectedValue(new SearchStoreFailure(code));
    await expect(
      f.service.search(owner, { query: 'private query' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(f.event.mock.calls)).not.toContain('private query');
  });
  it('returns timeout and keeps concurrency occupied until abandoned SQL finishes', async () => {
    const f = fixture({
      KEYWORD_SEARCH_TIMEOUT_MS: '1',
      KEYWORD_SEARCH_CONCURRENCY: '1',
    });
    let release: () => void = () => {};
    f.repository.authorizeDocuments.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(
      f.service.search(owner, { query: 'Canonical' }),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
    await expect(
      f.service.search(owner, { query: 'Canonical' }),
    ).rejects.toMatchObject({ status: 429 });
    release();
  });
  it('requires healthy compatible indexes even for a valid empty scope', async () => {
    const f = fixture();
    f.repository.scope.mockResolvedValue({
      scopes: [],
      coverage: {
        eligibleDocuments: 0,
        metadataReadyDocuments: 0,
        textReadyDocuments: 0,
      },
    });
    f.store.inspect.mockResolvedValue({ exists: false, compatible: false });
    await expect(
      f.service.search(owner, { query: 'Canonical' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.store.query).not.toHaveBeenCalled();
  });
  it('fails closed on malformed or oversized hits', async () => {
    const f = fixture();
    f.store.query.mockResolvedValue([
      { id: recordId(record), score: NaN, record },
    ]);
    await expect(
      f.service.search(owner, { query: 'Canonical' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('private prefix suggestions (SQL/store doubles)', () => {
  it.each([
    { prefix: '' },
    { prefix: 'x' },
    { prefix: 'x'.repeat(201) },
    { prefix: '\ud800x' },
    { prefix: '**' },
    { prefix: 'hello', limit: 11 },
    { prefix: 'hello', limit: null },
    { prefix: 'hello', cursor: 'x' },
    { prefix: 'hello', filters: { archived: true } },
  ])('rejects invalid prefix requests %j', async (input) => {
    const f = fixture();
    await expect(f.service.suggestions(owner, input as never)).rejects.toThrow(
      BadRequestException,
    );
    expect(f.store.query).not.toHaveBeenCalled();
  });
  it('returns canonical authorized title/reference/issuer values only; deduplicates without counts or filenames', async () => {
    const f = fixture();
    f.repository.finalize.mockResolvedValue({
      scopes: [],
      coverage: {
        eligibleDocuments: 1,
        metadataReadyDocuments: 1,
        textReadyDocuments: 0,
      },
      sources: [
        {
          ...source,
          issuer: 'Canonical title',
          referenceNumber: 'Canonical reference',
        },
      ],
    });
    const result = await f.service.suggestions(owner, {
      prefix: 'Can',
      limit: 10,
    });
    expect(result.suggestions.map((s) => [s.type, s.text])).toEqual([
      ['title', 'Canonical title'],
      ['referenceNumber', 'Canonical reference'],
    ]);
    expect(f.store.query.mock.calls[0][2]).toMatchObject({
      userId: owner,
      mode: 'prefix',
      limit: 50,
      text: 'Can',
    });
    expect(JSON.stringify(result)).not.toContain('Untrusted');
    expect(result).not.toHaveProperty('total');
    f.repository.finalize.mockResolvedValue({
      scopes: [],
      coverage: {
        eligibleDocuments: 0,
        metadataReadyDocuments: 0,
        textReadyDocuments: 0,
      },
      sources: [],
    });
    expect(
      (await f.service.suggestions(owner, { prefix: 'Untrusted' })).suggestions,
    ).toEqual([]);
  });
  it('does not use filename or extracted text as suggestion sources and never hides outage as no suggestions', async () => {
    const f = fixture();
    expect(
      (await f.service.suggestions(owner, { prefix: 'fixture' })).suggestions,
    ).toEqual([]);
    f.store.query.mockRejectedValue(new Error('SQL boundary test'));
    await expect(
      f.service.suggestions(owner, { prefix: 'Can' }),
    ).rejects.toThrow('SQL boundary test');
  });
});

describe('optional continuation highlights', () => {
  it('omits failed remote enrichment but propagates SQL authorization failures', async () => {
    const f = fixture(),
      refs = [{ id: recordId(record), record }];
    f.store.query.mockRejectedValue(new SearchStoreFailure('SEARCH_TIMEOUT'));
    expect(
      (
        await f.service.highlightHints(
          owner,
          { query: 'Canonical' },
          target.id,
          refs,
          new AbortController().signal,
        )
      ).size,
    ).toBe(0);
    expect(f.event).toHaveBeenCalledWith(
      'warn',
      'search.highlights.omitted',
      expect.any(Object),
    );
    f.repository.finalize.mockRejectedValue(Error('SQL unavailable'));
    await expect(
      f.service.highlightHints(
        owner,
        { query: 'Canonical' },
        target.id,
        refs,
        new AbortController().signal,
      ),
    ).rejects.toThrow('SQL unavailable');
  });
});

describe('prefix UTF-16 limits', () => {
  it('accepts a two-unit astral letter but rejects prefixes above 200 units', async () => {
    const f = fixture();
    await expect(
      f.service.suggestions(owner, { prefix: '\u{1d400}' }),
    ).resolves.toEqual({ suggestions: [] });
    await expect(
      f.service.suggestions(owner, { prefix: '\u{1d400}'.repeat(101) }),
    ).rejects.toThrow(BadRequestException);
  });
});
