import { ConfigurationService } from '../../configuration/configuration.module';
import { validateEnvironment } from '../../configuration/environment';
import { RequestContext } from '../../common/request-context';
import { StructuredLogger } from '../../common/structured-logger';
import { storageTestRoot } from '../../../test/configuration.fixture';
import { ragSource } from '../../../test/rag-source.fixture';
import {
  SemanticSearchService,
  type SemanticSearchResult,
} from '../search/semantic-search.service';
import { GenerationFailure } from './generation-provider';
import { RagAnswerService } from './rag-answer.service';

describe('owned grounded answer orchestration', () => {
  function fixture() {
    const source = ragSource();
    const search = {
      search: jest.fn(async () => ({ results: [source] })),
      revalidate: jest.fn(
        async (_owner: string, sources: readonly SemanticSearchResult[]) => [
          ...sources,
        ],
      ),
    };
    const generation = {
      generate: jest.fn(async () => ({
        content:
          '{"outcome":"answered","claims":[{"text":"Owned documents are stored.","sourceTokens":["S1"]}]}',
      })),
    };
    const config = validateEnvironment({
      DATABASE_URL: 'postgresql://localhost/rag_test',
      LOCAL_STORAGE_ROOT: storageTestRoot,
      SEMANTIC_SEARCH_MIN_SCORE: '0.8',
    });
    const settings = {
      ...config,
      rag: { ...config.rag, enabled: true },
      generation: { ...config.generation, model: 'test-model' },
    };
    const logs: string[] = [],
      context = new RequestContext();
    const service = new RagAnswerService(
      search as unknown as SemanticSearchService,
      new ConfigurationService(settings),
      generation,
      new StructuredLogger(context, (line) => logs.push(line)),
      context,
    );
    return { service, search, generation, source, settings, logs };
  }
  it('reuses authorized retrieval and revalidates before dispatch and publication', async () => {
    const f = fixture();
    const answer = await f.service.answer('owner', {
      question: '  Where are documents?  ',
      documentIds: [f.source.documentId],
    });
    expect(f.search.search).toHaveBeenCalledWith(
      'owner',
      {
        query: 'Where are documents?',
        documentIds: [f.source.documentId],
        limit: 8,
      },
      expect.any(AbortSignal),
    );
    expect(f.search.revalidate).toHaveBeenCalledTimes(2);
    expect(answer).toMatchObject({
      outcome: 'answered',
      answer: 'Owned documents are stored. [S1]',
      citations: [{ documentId: f.source.documentId }],
    });
    expect(f.logs.join()).not.toContain('Where are documents?');
    expect(f.logs.join()).not.toContain(f.source.excerpt);
    expect(f.logs.join()).not.toContain('Owned documents are stored.');
  });
  it.each(['none', 'weak', 'before', 'during', 'budget'])(
    'returns insufficient evidence for %s without unsupported citations',
    async (mode) => {
      const f = fixture();
      if (mode === 'none') f.search.search.mockResolvedValue({ results: [] });
      if (mode === 'weak') f.source.score = 0.1;
      if (mode === 'before') f.search.revalidate.mockResolvedValue([]);
      if (mode === 'during')
        f.search.revalidate
          .mockResolvedValueOnce([f.source])
          .mockResolvedValueOnce([]);
      if (mode === 'budget') f.settings.rag.contextTokens = 100;
      expect(await f.service.answer('owner', { question: 'q' })).toMatchObject({
        outcome: 'insufficient_evidence',
        answer: null,
        citations: [],
      });
      expect(f.generation.generate).toHaveBeenCalledTimes(
        mode === 'during' ? 1 : 0,
      );
    },
  );
  it('accepts model abstention and rejects invented references without fallback text', async () => {
    const f = fixture();
    f.generation.generate.mockResolvedValueOnce({
      content: '{"outcome":"insufficient_evidence","claims":[]}',
    });
    expect(await f.service.answer('owner', { question: 'q' })).toMatchObject({
      outcome: 'insufficient_evidence',
      reason: 'model_insufficient_evidence',
    });
    f.generation.generate.mockResolvedValueOnce({
      content:
        '{"outcome":"answered","claims":[{"text":"invented","sourceTokens":["S999"]}]}',
    });
    await expect(
      f.service.answer('owner', { question: 'q' }),
    ).rejects.toMatchObject({ status: 502 });
  });
  it.each([
    ['GENERATION_UNAVAILABLE', 503],
    ['GENERATION_TIMEOUT', 504],
    ['GENERATION_RATE_LIMITED', 429],
    ['AI_OUTPUT_INVALID', 502],
  ] as const)('sanitizes %s', async (code, status) => {
    const f = fixture();
    f.generation.generate.mockRejectedValueOnce(new GenerationFailure(code));
    await expect(
      f.service.answer('owner', { question: 'q' }),
    ).rejects.toMatchObject({ status });
    expect(f.generation.generate).toHaveBeenCalledTimes(1);
  });
  it('times out bounded work and retains admission until underlying generation settles', async () => {
    const f = fixture();
    f.settings.rag.timeoutMs = 20;
    f.settings.rag.concurrency = 1;
    let finish: ((value: { content: string }) => void) | undefined;
    f.generation.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await expect(
      f.service.answer('owner', { question: 'q' }),
    ).rejects.toMatchObject({ status: 504 });
    await expect(
      f.service.answer('owner', { question: 'q' }),
    ).rejects.toMatchObject({ status: 429 });
    finish?.({ content: '{"outcome":"insufficient_evidence","claims":[]}' });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  it.each(['', ' ', 'q'.repeat(4001), '\uD800'])(
    'rejects invalid question before provider use',
    async (question) => {
      const f = fixture();
      await expect(
        f.service.answer('owner', { question }),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.search.search).not.toHaveBeenCalled();
      expect(f.generation.generate).not.toHaveBeenCalled();
    },
  );
});
