import { randomUUID } from 'node:crypto';
import { embeddingProfileFingerprint } from '@qyvra/database';
import { ConfigurationService } from '../../configuration/configuration.module';
import type { ApiConfiguration } from '../../configuration/settings';
import { validateEnvironment } from '../../configuration/environment';
import { StructuredLogger } from '../../common/structured-logger';
import { RequestContext } from '../../common/request-context';
import { EmbeddingFailure } from '../ai/embedding-provider';
import { VectorStoreFailure, type VectorCandidate } from '../ai/vector-store';
import { SemanticSearchRepository } from './semantic-search.repository';
import { SemanticSearchService } from './semantic-search.service';
import { storageTestRoot } from '../../../test/configuration.fixture';

describe('authorized semantic retrieval', () => {
  function fixture(policy: Partial<ApiConfiguration['semanticSearch']> = {}) {
    const identity = {
      provider: 'test',
      model: 'model',
      modelRevision: 'v1',
      dimensions: 3,
      distance: 'Cosine' as const,
      profileVersion: 1,
      normalizationVersion: 'qyvra-embedding-input/v1',
      tokenizer: 'cl100k_base',
      tokenizerVersion: 'tiktoken-1.0.22',
      documentInstruction: 'document:',
      queryInstruction: 'query:',
    };
    const profile = {
      ...identity,
      id: randomUUID(),
      fingerprint: embeddingProfileFingerprint(identity),
    };
    const manifestId: string = randomUUID();
    const owner = randomUUID();
    const candidate: VectorCandidate = {
      chunkId: randomUUID(),
      indexManifestId: manifestId,
      documentId: randomUUID(),
      documentVersionId: randomUUID(),
      chunkSetId: randomUUID(),
      score: 0.8,
    };
    const source = {
      ...candidate,
      embeddingProfileId: profile.id,
      excerpt: 'private source',
      title: 'title',
      chunkOrdinal: 0,
      originalFilename: 'file.pdf',
      versionNumber: 1,
      excerptHash: 'a'.repeat(64),
      startOffset: 0,
      endOffset: 14,
      pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: 14 }],
    };
    const repository = {
      authorizeDocuments: jest.fn(async () => {}),
      profile: jest.fn(async () => profile),
      scope: jest.fn(async () => [manifestId]),
      hydrate: jest.fn(async () => [source]),
    };
    const embeddings = {
      embed: jest.fn(async () => [{ id: 'query', vector: [1, 2, 3] }]),
    };
    const vectors = { search: jest.fn(async () => [candidate]) };
    const lines: string[] = [];
    const config = validateEnvironment({
      DATABASE_URL: 'postgresql://localhost/test',
      LOCAL_STORAGE_ROOT: storageTestRoot,
    });
    const settings = {
      ...config,
      semanticSearch: { ...config.semanticSearch, enabled: true, ...policy },
      embedding: {
        ...config.embedding,
        profileFingerprint: profile.fingerprint,
      },
    };
    const service = new SemanticSearchService(
      repository as unknown as SemanticSearchRepository,
      new ConfigurationService(settings),
      embeddings,
      vectors,
      new StructuredLogger(new RequestContext(), (line) => lines.push(line)),
    );
    return {
      service,
      repository,
      embeddings,
      vectors,
      profile,
      candidate,
      source,
      owner,
      lines,
      settings,
    };
  }
  it('uses query purpose, exact immutable profile, trusted owner, bounded overfetch, canonical provenance and private logs', async () => {
    const f = fixture();
    const result = await f.service.search(f.owner, {
      query: '  private question 😀  ',
      limit: 2,
    });
    expect(f.embeddings.embed).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          fingerprint: f.profile.fingerprint,
        }),
        purpose: 'query',
        inputs: [{ id: 'query', text: 'private question 😀' }],
      }),
    );
    expect(f.vectors.search).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: f.owner,
        manifestIds: [f.candidate.indexManifestId],
        limit: 10,
        dimensions: 3,
      }),
    );
    expect(result.results[0]).toMatchObject({
      excerpt: 'private source',
      score: 0.8,
      chunkId: f.candidate.chunkId,
    });
    expect(f.repository.hydrate).toHaveBeenCalledTimes(1);
    expect(f.lines.join('')).not.toMatch(
      /private question|private source|file.pdf/,
    );
  });
  it.each(['', '  ', 'x'.repeat(4001)])(
    'rejects invalid question before external calls',
    async (query) => {
      const f = fixture();
      await expect(f.service.search(f.owner, { query })).rejects.toMatchObject({
        status: 400,
      });
      expect(f.embeddings.embed).not.toHaveBeenCalled();
    },
  );
  it.each([0, 21, 1.5])('rejects invalid limit %s', async (limit) => {
    const f = fixture();
    await expect(
      f.service.search(f.owner, { query: 'hello', limit }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('returns an empty scope without external calls', async () => {
    const f = fixture();
    f.repository.scope.mockResolvedValue([]);
    expect(await f.service.search(f.owner, { query: 'hello' })).toEqual({
      results: [],
    });
    expect(f.embeddings.embed).not.toHaveBeenCalled();
    expect(f.vectors.search).not.toHaveBeenCalled();
  });
  it('fails closed before embedding for foreign document scope', async () => {
    const f = fixture();
    f.repository.authorizeDocuments.mockRejectedValue(
      new Error('private SQL details'),
    );
    await expect(
      f.service.search(f.owner, {
        query: 'hello',
        documentIds: [randomUUID()],
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.embeddings.embed).not.toHaveBeenCalled();
    expect(f.lines.join('')).not.toContain('private SQL');
  });
  it('refuses a different serving/configured fingerprint', async () => {
    const f = fixture();
    f.profile.fingerprint = 'b'.repeat(64);
    await expect(
      f.service.search(f.owner, { query: 'hello' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.embeddings.embed).not.toHaveBeenCalled();
  });
  it('rechecks eligibility after embedding and avoids revoked remote scope', async () => {
    const f = fixture();
    f.repository.scope
      .mockResolvedValueOnce([f.candidate.indexManifestId])
      .mockResolvedValueOnce([]);
    expect(await f.service.search(f.owner, { query: 'hello' })).toEqual({
      results: [],
    });
    expect(f.vectors.search).not.toHaveBeenCalled();
  });
  it('drops stale references before returning any text', async () => {
    const f = fixture();
    f.repository.hydrate.mockResolvedValue([]);
    expect(await f.service.search(f.owner, { query: 'hello' })).toEqual({
      results: [],
    });
  });
  it('sorts scores, breaks ties by ID, deduplicates and caps results', async () => {
    const f = fixture();
    const lower = {
      ...f.candidate,
      chunkId: '00000000-0000-4000-8000-000000000001',
    };
    f.vectors.search.mockResolvedValue([f.candidate, lower, f.candidate]);
    f.repository.hydrate.mockResolvedValue([
      f.source,
      { ...f.source, chunkId: lower.chunkId },
    ]);
    const result = await f.service.search(f.owner, {
      query: 'hello',
      limit: 2,
    });
    expect(result.results.map((r) => r.chunkId)).toEqual([
      lower.chunkId,
      f.candidate.chunkId,
    ]);
  });
  it('invalid vector dimensions fail without calling Qdrant', async () => {
    const f = fixture();
    f.embeddings.embed.mockResolvedValue([{ id: 'query', vector: [1] }]);
    await expect(
      f.service.search(f.owner, { query: 'hello' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.vectors.search).not.toHaveBeenCalled();
  });
  it.each([
    new EmbeddingFailure('EMBEDDING_NETWORK', true),
    new VectorStoreFailure('VECTOR_UNAVAILABLE', true),
  ])('sanitizes unavailable dependencies', async (error) => {
    const f = fixture();
    if (error instanceof EmbeddingFailure)
      f.embeddings.embed.mockRejectedValue(error);
    else f.vectors.search.mockRejectedValue(error);
    await expect(
      f.service.search(f.owner, { query: 'hello' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.embeddings.embed).toHaveBeenCalledTimes(1);
  });
  it('bounds per-user calls and does not retry interactive work', async () => {
    const f = fixture();
    for (let i = 0; i < 30; i++)
      await f.service.search(f.owner, { query: 'hello' });
    await expect(
      f.service.search(f.owner, { query: 'hello' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(f.embeddings.embed).toHaveBeenCalledTimes(30);
  });
  it('applies only an explicitly configured profile score threshold', async () => {
    const f = fixture({ minScore: 0.85 });
    expect(await f.service.search(f.owner, { query: 'hello' })).toEqual({
      results: [],
    });
    expect(f.vectors.search).toHaveBeenCalledWith(
      expect.objectContaining({ minScore: 0.85 }),
    );
    expect(f.repository.hydrate).toHaveBeenCalledWith(
      f.owner,
      f.profile.id,
      [],
    );
  });
  it('caps overfetch at 100 and hydrates once at maximum top K', async () => {
    const f = fixture();
    await f.service.search(f.owner, { query: 'hello', limit: 20 });
    expect(f.vectors.search).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
    expect(f.repository.hydrate).toHaveBeenCalledTimes(1);
  });
  it('maps provider throttling and timeout without retry', async () => {
    for (const [code, status] of [
      ['EMBEDDING_RATE_LIMITED', 429],
      ['EMBEDDING_TIMEOUT', 504],
    ] as const) {
      const f = fixture();
      f.embeddings.embed.mockRejectedValue(new EmbeddingFailure(code, true));
      await expect(
        f.service.search(f.owner, { query: 'hello' }),
      ).rejects.toMatchObject({ status });
      expect(f.embeddings.embed).toHaveBeenCalledTimes(1);
    }
  });
  it('holds admission until timed-out underlying work settles', async () => {
    const f = fixture({ timeoutMs: 10, concurrency: 1 });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.embeddings.embed.mockImplementation(async () => {
      await wait;
      return [{ id: 'query', vector: [1, 2, 3] }];
    });
    await expect(
      f.service.search(f.owner, { query: 'hello' }),
    ).rejects.toMatchObject({ status: 504 });
    await expect(
      f.service.search(f.owner, { query: 'hello' }),
    ).rejects.toMatchObject({ status: 429 });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.embeddings.embed.mockResolvedValue([{ id: 'query', vector: [1, 2, 3] }]);
    expect(
      (await f.service.search(f.owner, { query: 'hello' })).results,
    ).toHaveLength(1);
  });
  it('enforces global admission across users with bounded accounting', async () => {
    const f = fixture({ globalPerMinute: 2 });
    await f.service.search(f.owner, { query: 'hello' });
    await f.service.search(randomUUID(), { query: 'hello' });
    await expect(
      f.service.search(randomUUID(), { query: 'hello' }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('enforces concurrency while a dependency is pending', async () => {
    const f = fixture();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.embeddings.embed.mockImplementation(async () => {
      await wait;
      return [{ id: 'query', vector: [1, 2, 3] }];
    });
    const pending = Array.from({ length: 4 }, () =>
      f.service.search(f.owner, { query: 'hello' }),
    );
    await expect(
      f.service.search(f.owner, { query: 'hello' }),
    ).rejects.toMatchObject({ status: 429 });
    release();
    await Promise.all(pending);
  });
});
