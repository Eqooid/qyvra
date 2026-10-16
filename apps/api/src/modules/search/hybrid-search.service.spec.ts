import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  HybridSearchService,
  searchInputDigest,
} from './hybrid-search.service';
import { KeywordSearchService, lexicalResult } from './keyword-search.service';
import {
  KeywordSearchRepository,
  CanonicalKeywordHit,
  LexicalReference,
} from './keyword-search.repository';
import { SemanticSearchRepository } from './semantic-search.repository';
import { SemanticSearchService } from './semantic-search.service';
import {
  SearchWindowStore,
  SearchWindow,
} from '../../infrastructure/search/search-window.store';
import { ConfigurationService } from '../../configuration/configuration.module';
import { StructuredLogger } from '../../common/structured-logger';
import { validateTestEnvironment } from '../../../test/configuration.fixture';
import { EmbeddingFailure } from '../ai/embedding-provider';
import type { ApiConfiguration } from '../../configuration/settings';
import { VectorStoreFailure } from '../ai/vector-store';

function fixture(policy: Partial<ApiConfiguration['keywordSearch']> = {}) {
  const owner = randomUUID(),
    session = randomUUID(),
    generation = randomUUID(),
    version = randomUUID(),
    profile = randomUUID();
  const documents = Array.from({ length: 3 }, () => ({
    documentId: randomUUID(),
    documentVersionId: version,
    versionNumber: 1,
    title: 'Canonical owned title',
    originalFilename: 'owned.pdf',
    mimeType: 'application/pdf',
    documentType: 'OTHER',
    status: 'UPLOADED',
    categoryId: null,
    tagIds: [],
  }));
  const allowed = new Set<string>(documents.map((d) => d.documentId));
  const references = documents.map((d) => ({
    id: `${randomUUID()}:metadata`,
    record: {
      projectionId: randomUUID(),
      documentId: d.documentId,
      documentVersionId: version,
      revision: 1,
      sourceHash: 'a'.repeat(64),
      kind: 'metadata' as const,
    },
  }));
  const canonical = (r: LexicalReference): CanonicalKeywordHit => ({
    ...documents.find((d) => d.documentId === r.record.documentId)!,
    projectionId: r.record.projectionId,
    recordId: r.id,
    kind: 'metadata',
    description: null,
    issuer: null,
    referenceNumber: null,
    excerpt: null,
    pageNumber: null,
    extractedTextId: null,
    startOffset: null,
  });
  const coverage = {
    eligibleDocuments: 3,
    metadataReadyDocuments: 3,
    textReadyDocuments: 0,
  };
  const lexicalRepository = {
    authorizeDocuments: jest.fn().mockResolvedValue(undefined),
    filteredDocuments: jest
      .fn()
      .mockImplementation(async () =>
        documents.filter((d) => allowed.has(d.documentId)),
      ),
    snapshot: jest
      .fn()
      .mockImplementation(async (read: (tx: unknown) => unknown) => read({})),
    finalize: jest
      .fn()
      .mockImplementation(
        async (
          _owner,
          _generation,
          _input,
          _max,
          refs: LexicalReference[],
        ) => ({
          coverage,
          sources: refs
            .filter((r) => allowed.has(r.record.documentId))
            .map(canonical),
        }),
      ),
  };
  const keyword = {
    highlightHints: jest.fn().mockResolvedValue(new Map()),
    candidates: jest.fn().mockResolvedValue({
      generationId: generation,
      response: { coverage, pagination: { truncated: false } },
      candidates: references.map((r, i) => ({
        source: 'lexical',
        userId: owner,
        documentId: r.record.documentId,
        documentVersionId: version,
        sourceRank: i + 1,
        score: 100 - i,
        references: [r],
        result: lexicalResult(canonical(r), [], i + 1),
      })),
    }),
  };
  const source = {
    chunkId: randomUUID(),
    chunkSetId: randomUUID(),
    indexManifestId: randomUUID(),
    documentId: documents[1].documentId,
    documentVersionId: version,
    embeddingProfileId: profile,
    excerpt: 'Canonical semantic chunk',
    startOffset: 20,
    endOffset: 44,
    excerptHash: 'b'.repeat(64),
    title: 'ignored',
    originalFilename: 'ignored',
    versionNumber: 1,
    chunkOrdinal: 0,
    pageSpans: [],
  };
  const semantic = {
    candidates: jest.fn().mockResolvedValue({
      profileId: profile,
      profileFingerprint: 'b'.repeat(64),
      truncated: false,
      results: [{ ...source, score: 0.9 }],
    }),
  };
  const semanticRepository = {
    profile: jest
      .fn()
      .mockResolvedValue({ id: profile, fingerprint: 'b'.repeat(64) }),
    hydrate: jest
      .fn()
      .mockImplementation(async () =>
        allowed.has(source.documentId) ? [source] : [],
      ),
  };
  const cache = new Map<string, SearchWindow>();
  const windows = {
    save: jest.fn().mockImplementation(async (id, w) => {
      cache.set(id, JSON.parse(JSON.stringify(w)) as SearchWindow);
      return true;
    }),
    read: jest.fn().mockImplementation(async (id) => cache.get(id) ?? null),
  };
  const config = validateTestEnvironment({
    DATABASE_URL: 'postgresql://localhost/test',
  });
  const settings = {
    ...config,
    keywordSearch: {
      ...config.keywordSearch,
      enabled: true,
      generationFingerprint: 'a'.repeat(64),
      ...policy,
    },
    hybridSearch: { enabled: true },
    embedding: { ...config.embedding, profileFingerprint: 'b'.repeat(64) },
  };
  const event = jest.fn();
  const service = new HybridSearchService(
    keyword as unknown as KeywordSearchService,
    semantic as unknown as SemanticSearchService,
    lexicalRepository as unknown as KeywordSearchRepository,
    semanticRepository as unknown as SemanticSearchRepository,
    windows as unknown as SearchWindowStore,
    new ConfigurationService(settings),
    { event } as unknown as StructuredLogger,
  );
  return {
    service,
    owner,
    session,
    documents,
    allowed,
    keyword,
    semantic,
    lexicalRepository,
    semanticRepository,
    windows,
    cache,
    event,
  };
}
describe('authorized fixed search windows (SQL/provider/Redis doubles)', () => {
  it('fuses documents, preserves both canonical provenances and never adds scores', async () => {
    const f = fixture();
    const r = await f.service.hybridSearch(f.owner, f.session, {
      query: 'Canonical',
      limit: 2,
    });
    expect(r.results[0].documentId).toBe(f.documents[1].documentId);
    expect(r.results[0].ranking).toBe('document-rrf60-v1');
    expect(r.results[0].matches.map((m) => m.kind)).toEqual([
      'metadata',
      'chunk',
    ]);
    expect(r.results[0]).not.toHaveProperty('score');
    expect(JSON.stringify([...f.cache.values()])).not.toContain('Canonical');
    expect(JSON.stringify([...f.cache.values()])).not.toContain('owned.pdf');
    expect(f.semantic.candidates.mock.calls[0][2]).toEqual(
      f.documents.map((d) => d.documentId),
    );
  });
  it('pages a fixed keyword window without requery/refill and omits revocations', async () => {
    const f = fixture(),
      input = { query: 'Canonical', limit: 1 };
    const first = await f.service.keywordSearch(f.owner, f.session, input);
    expect(first.pagination.nextCursor).toBeTruthy();
    f.allowed.delete(f.documents[1].documentId);
    const second = await f.service.keywordSearch(f.owner, f.session, {
      ...input,
      cursor: first.pagination.nextCursor!,
    });
    expect(second.results).toEqual([]);
    expect(second.pagination.hasMore).toBe(true);
    const last = await f.service.keywordSearch(f.owner, f.session, {
      ...input,
      cursor: second.pagination.nextCursor!,
    });
    expect(last.results.map((r) => r.documentId)).toEqual([
      f.documents[2].documentId,
    ]);
    expect(last.pagination.nextCursor).toBeNull();
    expect(f.keyword.candidates).toHaveBeenCalledTimes(1);
    expect(f.semantic.candidates).not.toHaveBeenCalled();
    expect(JSON.stringify([...f.cache.values()])).not.toContain('Canonical');
    expect(JSON.stringify([...f.cache.values()])).not.toContain('owned.pdf');
  });
  it.each([
    'owner',
    'session',
    'query',
    'filters',
    'limit',
    'mode',
    'tamper',
    'expiry',
    'eviction',
  ] as const)('rejects %s cursor changes', async (change) => {
    const f = fixture(),
      input = { query: 'Canonical', limit: 1 };
    const first = await f.service.keywordSearch(f.owner, f.session, input);
    let cursor = first.pagination.nextCursor!;
    if (change === 'tamper') cursor = cursor.replace('_1_', '_2_');
    if (change === 'expiry')
      for (const w of f.cache.values()) w.expires = Date.now() - 1;
    if (change === 'eviction') f.cache.clear();
    const dto = {
      ...input,
      cursor,
      ...(change === 'query' ? { query: 'changed' } : {}),
      ...(change === 'filters'
        ? { filters: { mimeType: 'image/png' as const } }
        : {}),
      ...(change === 'limit' ? { limit: 2 } : {}),
    };
    await expect(
      change === 'mode'
        ? f.service.hybridSearch(f.owner, f.session, dto)
        : f.service.keywordSearch(
            change === 'owner' ? randomUUID() : f.owner,
            change === 'session' ? randomUUID() : f.session,
            dto,
          ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('distinguishes Redis first-page loss from continuation failure', async () => {
    const f = fixture();
    f.windows.save.mockRejectedValue(Error('offline'));
    const r = await f.service.keywordSearch(f.owner, f.session, {
      query: 'Canonical',
      limit: 1,
    });
    expect(r.pagination).toMatchObject({
      paginationAvailable: false,
      nextCursor: null,
      truncated: true,
    });
    f.windows.save.mockImplementation(async (id, w) => {
      f.cache.set(id, w);
      return true;
    });
    const first = await f.service.keywordSearch(f.owner, f.session, {
      query: 'Canonical',
      limit: 1,
    });
    f.windows.read.mockRejectedValue(Error('offline'));
    await expect(
      f.service.keywordSearch(f.owner, f.session, {
        query: 'Canonical',
        limit: 1,
        cursor: first.pagination.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('fails hybrid explicitly when a retrieval leg is unavailable; keyword remains independent', async () => {
    const f = fixture();
    f.semantic.candidates.mockRejectedValue(
      new VectorStoreFailure('VECTOR_UNAVAILABLE'),
    );
    await expect(
      f.service.hybridSearch(f.owner, f.session, { query: 'Canonical' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(
      (
        await f.service.keywordSearch(f.owner, f.session, {
          query: 'Canonical',
        })
      ).results,
    ).toHaveLength(3);
  });
  it('rejects profile cutover and never bypasses SQL authorization errors', async () => {
    const f = fixture();
    f.semanticRepository.profile.mockResolvedValue({
      id: randomUUID(),
      fingerprint: 'b'.repeat(64),
    });
    await expect(
      f.service.hybridSearch(f.owner, f.session, { query: 'Canonical' }),
    ).rejects.toBeInstanceOf(ConflictException);
    f.lexicalRepository.snapshot.mockRejectedValue(Error('SQL unavailable'));
    await expect(
      f.service.keywordSearch(f.owner, f.session, { query: 'Canonical' }),
    ).rejects.toThrow('SQL unavailable');
  });
  it('validates unsupported modes and malformed cursor syntax at the boundary', async () => {
    const f = fixture();
    await expect(
      f.service.keywordSearch(f.owner, f.session, {
        query: 'Canonical',
        cursor: 'bad',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.keywordSearch(f.owner, f.session, {
        query: 'Canonical',
        mode: 'semantic',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('holds admission until timed-out work actually settles', async () => {
    const f = fixture({ concurrency: 1, timeoutMs: 1 });
    let finish = () => {};
    f.keyword.candidates.mockImplementation(
      () =>
        new Promise<never>((_, reject) => {
          finish = () => reject(Error('late dependency failure'));
        }),
    );
    await expect(
      f.service.keywordSearch(f.owner, f.session, { query: 'Canonical' }),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
    await expect(
      f.service.keywordSearch(f.owner, f.session, { query: 'Canonical' }),
    ).rejects.toHaveProperty('status', 429);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
  });
  it.each([
    ['EMBEDDING_INPUT_LIMIT', 400],
    ['EMBEDDING_RATE_LIMITED', 429],
    ['EMBEDDING_TIMEOUT', 504],
    ['EMBEDDING_UNAVAILABLE', 503],
  ])(
    'maps provider %s without fallback or content exposure',
    async (code, status) => {
      const f = fixture();
      f.semantic.candidates.mockRejectedValue(
        new EmbeddingFailure(String(code)),
      );
      await expect(
        f.service.hybridSearch(f.owner, f.session, { query: 'Canonical' }),
      ).rejects.toHaveProperty('status', status);
    },
  );
  it('retains the keyword READY-scope budget without imposing a hybrid all-document scan', async () => {
    const f = fixture();
    f.lexicalRepository.filteredDocuments.mockRejectedValue(
      new BadRequestException('Narrow the search filters.'),
    );
    expect(
      (
        await f.service.keywordSearch(f.owner, f.session, {
          query: 'Canonical',
        })
      ).results,
    ).toHaveLength(3);
    expect(f.lexicalRepository.filteredDocuments).not.toHaveBeenCalled();
    await expect(
      f.service.hybridSearch(f.owner, f.session, { query: 'Canonical' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('enriches lexical canonical evidence without changing document fusion, and leaves semantic-only matches unmarked', async () => {
    const f = fixture();
    const batch = await f.keyword.candidates();
    const id = batch.candidates[0].references[0].id;
    f.keyword.candidates.mockResolvedValue(
      Object.assign(batch, {
        highlights: new Map([
          [
            id,
            [
              {
                field: 'title',
                text: 'Canonical owned title',
                ranges: [{ start: 0, end: 9 }],
              },
            ],
          ],
        ]),
      }),
    );
    const highlighted = await f.service.hybridSearch(f.owner, f.session, {
      query: 'Canonical',
    });
    expect(highlighted.results.map((r) => r.documentId)).toEqual([
      f.documents[1].documentId,
      f.documents[0].documentId,
      f.documents[2].documentId,
    ]);
    expect(highlighted.results[1].matches[0]).toMatchObject({
      kind: 'metadata',
      ranges: [{ start: 0, end: 9 }],
    });
    f.keyword.candidates.mockResolvedValue({ ...batch, candidates: [] });
    const semantic = await f.service.hybridSearch(f.owner, f.session, {
      query: 'Canonical',
    });
    expect(semantic.results[0].matches.map((m) => m.kind)).toEqual(['chunk']);
    expect(semantic.results[0].matches[0]).not.toHaveProperty('ranges');
  });
  it('canonicalizes filter sets and default values in the query binding', () => {
    expect(
      searchInputDigest(
        { query: 'a', filters: { tagIds: ['b', 'a'] } },
        'keyword',
        'v1',
      ),
    ).toBe(
      searchInputDigest(
        {
          query: 'a',
          limit: 10,
          match: 'terms',
          filters: { tagIds: ['a', 'b'] },
        },
        'keyword',
        'v1',
      ),
    );
  });
});
