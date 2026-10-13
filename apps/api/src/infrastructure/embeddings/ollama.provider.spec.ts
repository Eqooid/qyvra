import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { embeddingProfileFingerprint } from '@qyvra/database';
import { ollamaFixture } from '../../../test/ollama.fixture';
import { vectorCollectionName } from '../../modules/ai/vector-store';
import { OllamaEmbeddingProvider } from './ollama.provider';
import { LocalEmbeddingTokenizer } from './local-tokenizer';
import { createEmbeddingProvider } from './embedding-provider.factory';

describe('native Ollama embeddings (offline HTTP server)', () => {
  let fixture: ReturnType<typeof ollamaFixture>,
    server: Server,
    endpoint: string;
  let status: number,
    digest: string,
    body: unknown,
    received: Record<string, unknown>[];
  let delay: boolean;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (delay) return;
      if (req.method === 'GET') {
        res.end(
          JSON.stringify({ models: [{ name: 'fixture:latest', digest }] }),
        );
        return;
      }
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        const request = JSON.parse(Buffer.concat(parts).toString()) as Record<
          string,
          unknown
        >;
        received.push(request);
        res.writeHead(status, {
          'content-type': 'application/json',
          'retry-after': '7200',
        });
        const inputs = request.input as string[];
        res.end(
          body === 'malformed'
            ? '{'
            : JSON.stringify(
                body ?? {
                  model: 'fixture:latest',
                  embeddings: inputs.map((_, i) => [1, 2, i + 3]),
                  prompt_eval_count: inputs.reduce(
                    (sum, text) => sum + fixture.tokenizer.count(text),
                    0,
                  ),
                },
              ),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('Test listener missing');
    endpoint = `http://127.0.0.1:${address.port}/api/embed`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    fixture = ollamaFixture();
    status = 200;
    digest = 'a'.repeat(64);
    body = undefined;
    received = [];
    delay = false;
  });
  afterEach(() => fixture.dispose());
  function embed(
    inputs = [{ id: 'a', text: 'Hello world' }],
    purpose: 'query' | 'document' = 'document',
  ) {
    return createEmbeddingProvider({ ...fixture.config, endpoint }).embed({
      profile: fixture.profile,
      inputs,
      purpose,
      signal: AbortSignal.timeout(2000),
    });
  }
  it('supports single and ordered batch inputs with exact purpose prefixes and no identifiers', async () => {
    expect(await embed()).toEqual([{ id: 'a', vector: [1, 2, 3] }]);
    expect(
      await embed(
        [
          { id: 'z', text: 'Hello' },
          { id: 'a', text: 'world' },
        ],
        'query',
      ),
    ).toEqual([
      { id: 'z', vector: [1, 2, 3] },
      { id: 'a', vector: [1, 2, 4] },
    ]);
    expect(received).toEqual([
      {
        model: 'fixture:latest',
        input: ['search_document: Hello world'],
        truncate: false,
        dimensions: 3,
      },
      {
        model: 'fixture:latest',
        input: ['search_query: Hello', 'search_query: world'],
        truncate: false,
        dimensions: 3,
      },
    ]);
  });
  it.each(
    [[], [0, 0, 0], [1, 2], [1, '2', 3], [NaN, 1, 2], [Infinity, 1, 2]].map(
      (vector) => [vector],
    ),
  )('rejects invalid vector %j', async (vector) => {
    body = {
      model: fixture.profile.model,
      embeddings: [vector],
      prompt_eval_count: 3,
    };
    await expect(embed()).rejects.toMatchObject({
      code: 'EMBEDDING_INVALID_OUTPUT',
      retryable: false,
    });
  });
  it.each([
    {},
    { model: 'other', embeddings: [[1, 2, 3]], prompt_eval_count: 3 },
    { model: 'fixture:latest', embeddings: [], prompt_eval_count: 3 },
    {
      model: 'fixture:latest',
      embeddings: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      prompt_eval_count: 3,
    },
    { model: 'fixture:latest', embeddings: [[1, 2, 3]], prompt_eval_count: 2 },
    'malformed',
  ])(
    'rejects malformed, missing, extra, model or tokenizer-incompatible output %j',
    async (response) => {
      body = response;
      await expect(embed()).rejects.toMatchObject({
        code: 'EMBEDDING_INVALID_OUTPUT',
        retryable: false,
      });
    },
  );
  it.each([400, 401, 403, 404, 422])(
    'does not retry deterministic HTTP %s',
    async (code) => {
      status = code;
      body = { error: 'private document content' };
      await expect(embed()).rejects.toMatchObject({ retryable: false });
      await expect(embed()).rejects.not.toHaveProperty('cause');
    },
  );
  it.each([408, 429, 500, 503])(
    'reuses durable transient classification HTTP %s',
    async (code) => {
      status = code;
      await expect(embed()).rejects.toMatchObject({
        retryable: true,
        retryAfterMs: 3600000,
      });
    },
  );
  it('rejects installed model drift without inference', async () => {
    digest = 'b'.repeat(64);
    await expect(embed()).rejects.toMatchObject({
      code: 'EMBEDDING_MODEL_REVISION_MISMATCH',
      retryable: false,
    });
    expect(received).toHaveLength(0);
  });
  it('rejects drift between inference and checkpoint return', async () => {
    const transport: typeof fetch = async (url, init) => {
      const result = await fetch(url, init);
      if (init?.method === 'POST') digest = 'b'.repeat(64);
      return result;
    };
    await expect(
      createEmbeddingProvider({ ...fixture.config, endpoint }, transport).embed(
        {
          profile: fixture.profile,
          inputs: [{ id: 'a', text: 'Hello' }],
          purpose: 'query',
          signal: AbortSignal.timeout(1000),
        },
      ),
    ).rejects.toMatchObject({ code: 'EMBEDDING_MODEL_REVISION_MISMATCH' });
  });
  it('bounds timeout even on metadata reads and honors parent cancellation', async () => {
    delay = true;
    const provider = createEmbeddingProvider({
      ...fixture.config,
      endpoint,
      timeoutMs: 20,
    });
    await expect(
      provider.embed({
        profile: fixture.profile,
        inputs: [{ id: 'a', text: 'Hello' }],
        purpose: 'query',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_TIMEOUT', retryable: true });
  });
  it('sanitizes connection failures', async () => {
    const transport: typeof fetch = () =>
      Promise.reject(new Error('secret endpoint'));
    await expect(
      createEmbeddingProvider({ ...fixture.config, endpoint }, transport).embed(
        {
          profile: fixture.profile,
          inputs: [{ id: 'a', text: 'Hello' }],
          purpose: 'query',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_NETWORK',
      retryable: true,
      message: 'EMBEDDING_NETWORK',
    });
  });
  it('rejects bad profiles, missing assets, endpoints, oversized inputs and duplicate IDs before inference', async () => {
    fixture.profile.tokenizerVersion = 'wrong';
    await expect(embed()).rejects.toMatchObject({
      code: 'EMBEDDING_PROFILE_UNSUPPORTED',
    });
    fixture.dispose();
    fixture = ollamaFixture();
    await expect(
      new OllamaEmbeddingProvider(fixture.config, undefined).embed({
        profile: fixture.profile,
        inputs: [],
        purpose: 'query',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_NOT_CONFIGURED' });
    await expect(
      createEmbeddingProvider({
        ...fixture.config,
        endpoint: endpoint + '?secret=x',
      }).embed({
        profile: fixture.profile,
        inputs: [{ id: 'a', text: 'Hello' }],
        purpose: 'query',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_NOT_CONFIGURED' });
    await expect(
      embed([
        { id: 'a', text: 'Hello' },
        { id: 'a', text: 'world' },
      ]),
    ).rejects.toMatchObject({ code: 'EMBEDDING_INVALID_INPUT' });
    await expect(
      createEmbeddingProvider({
        ...fixture.config,
        endpoint,
        maxInputTokens: 1,
      }).embed({
        profile: fixture.profile,
        inputs: [{ id: 'a', text: 'Hello' }],
        purpose: 'query',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_INPUT_LIMIT' });
    expect(received).toHaveLength(0);
  });
  it('loads pinned Unicode parity assets and rejects corrupt or differently identified assets', () => {
    expect(fixture.tokenizer.count('é 文 😀')).toBe(3);
    expect(fixture.tokenizer.version).toBe(fixture.profile.tokenizerVersion);
    fixture.bundle.parity[0].ids = [99];
    writeFileSync(fixture.path, JSON.stringify(fixture.bundle));
    expect(() => new LocalEmbeddingTokenizer(fixture.path)).toThrow(
      'EMBEDDING_TOKENIZER_INVALID',
    );
    expect(
      () => new LocalEmbeddingTokenizer(fixture.path + '.missing'),
    ).toThrow('EMBEDDING_TOKENIZER_INVALID');
  });
  it('isolates providers/models/dimensions/revisions and preprocessing even with equal dimensions', () => {
    const identities = [
      fixture.profile,
      { ...fixture.profile, provider: 'openai-compatible' },
      { ...fixture.profile, model: 'other:latest' },
      { ...fixture.profile, dimensions: 4 },
      { ...fixture.profile, modelRevision: `sha256:${'b'.repeat(64)}` },
      { ...fixture.profile, queryInstruction: 'different: ' },
    ];
    expect(new Set(identities.map(embeddingProfileFingerprint)).size).toBe(
      identities.length,
    );
    expect(
      vectorCollectionName('11111111-1111-1111-1111-111111111111'),
    ).not.toBe(vectorCollectionName('22222222-2222-2222-2222-222222222222'));
  });
  it('preserves compatible provider selection and rejects unknown providers', async () => {
    body = {
      model: 'fixture:latest',
      data: [{ index: 0, embedding: [1, 2, 3] }],
    };
    const provider = createEmbeddingProvider({
      ...fixture.config,
      endpoint: endpoint.replace('/api/embed', '/v1/embeddings'),
    });
    const request = {
      profile: {
        ...fixture.profile,
        provider: 'openai-compatible',
        tokenizer: 'cl100k_base',
        tokenizerVersion: 'tiktoken-1.0.22',
        normalizationVersion: 'qyvra-embedding-input/v1',
      },
      inputs: [{ id: 'a', text: 'Hello' }],
      purpose: 'query' as const,
      signal: new AbortController().signal,
    };
    expect(await provider.embed(request)).toEqual([
      { id: 'a', vector: [1, 2, 3] },
    ]);
    await expect(
      provider.embed({
        ...request,
        profile: { ...request.profile, provider: 'unknown' },
      }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_PROFILE_UNSUPPORTED' });
  });
  it('supports omitted dimensions and cancels before disclosure', async () => {
    const provider = createEmbeddingProvider({
      ...fixture.config,
      endpoint,
      sendDimensions: false,
    });
    const request = {
      profile: fixture.profile,
      inputs: [{ id: 'a', text: 'Hello' }],
      purpose: 'query' as const,
      signal: new AbortController().signal,
    };
    expect(await provider.embed(request)).toHaveLength(1);
    expect(received[0]).not.toHaveProperty('dimensions');
    const aborted = AbortSignal.abort();
    await expect(
      provider.embed({ ...request, signal: aborted }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_TIMEOUT' });
    expect(received).toHaveLength(1);
  });
});
