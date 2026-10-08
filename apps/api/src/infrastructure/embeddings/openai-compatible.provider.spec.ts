import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleEmbeddingProvider } from './openai-compatible.provider';
import type { ApiConfiguration } from '../../configuration/settings';

const profile = {
  profileVersion: 1,
  provider: 'openai-compatible',
  model: 'test',
  modelRevision: 'test-v1',
  dimensions: 3,
  distance: 'Cosine' as const,
  normalizationVersion: 'qyvra-embedding-input/v1',
  tokenizer: 'cl100k_base',
  tokenizerVersion: 'tiktoken-1.0.22',
  documentInstruction: '',
  queryInstruction: '',
};
const config: ApiConfiguration['embedding'] = {
  enabled: true,
  batchSize: 32,
  timeoutMs: 1000,
  maxInputTokens: 8191,
  maxBatchTokens: 100000,
  sendDimensions: true,
};
describe('real OpenAI-compatible HTTP adapter (offline server)', () => {
  let server: Server, endpoint: string;
  let status: number, body: unknown, retry: string | undefined;
  let request: unknown, authorization: string | undefined;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        request = JSON.parse(Buffer.concat(parts).toString()) as unknown;
        authorization = req.headers.authorization;
        res.writeHead(status, {
          'content-type': 'application/json',
          ...(retry ? { 'retry-after': retry } : {}),
        });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('Missing test listener');
    endpoint = `http://127.0.0.1:${address.port}/v1/embeddings`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
  beforeEach(() => {
    status = 200;
    retry = undefined;
    body = {
      model: 'test',
      data: [
        { index: 1, embedding: [4, 5, 6] },
        { index: 0, embedding: [1, 2, 3] },
      ],
    };
  });
  function embed(settings: Partial<ApiConfiguration['embedding']> = {}) {
    return new OpenAiCompatibleEmbeddingProvider({
      ...config,
      endpoint,
      apiKey: 'public-test-key',
      ...settings,
    }).embed({
      profile,
      inputs: [
        { id: 'first', text: 'Alpha' },
        { id: 'second', text: 'Beta' },
      ],
      purpose: 'document',
      signal: AbortSignal.timeout(1000),
    });
  }
  it('sends exact inputs and validates index mapping without transmitting identifiers', async () => {
    expect(await embed()).toEqual([
      { id: 'first', vector: [1, 2, 3] },
      { id: 'second', vector: [4, 5, 6] },
    ]);
    expect(request).toEqual({
      input: ['Alpha', 'Beta'],
      model: 'test',
      encoding_format: 'float',
      dimensions: 3,
    });
    expect(authorization).toBe('Bearer public-test-key');
  });
  it.each([401, 403, 400, 404])(
    'sanitizes permanent HTTP %s errors',
    async (code) => {
      status = code;
      body = { error: { message: 'secret input public-test-key' } };
      await expect(embed()).rejects.toMatchObject({ retryable: false });
      await expect(embed()).rejects.not.toHaveProperty('cause');
    },
  );
  it.each([429, 408, 500, 503])(
    'classifies transient HTTP %s and bounded retry-after',
    async (code) => {
      status = code;
      retry = '7200';
      await expect(embed()).rejects.toMatchObject({
        retryable: true,
        retryAfterMs: 3600000,
      });
    },
  );
  it.each([
    { model: 'other', data: [] },
    { model: 'test', data: [{ index: 0, embedding: [1, 2, 3] }] },
    {
      model: 'test',
      data: [
        { index: 0, embedding: [1, 2, 3] },
        { index: 0, embedding: [4, 5, 6] },
      ],
    },
    {
      model: 'test',
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [4, 5, 6] },
      ],
    },
  ])('rejects malformed whole batches', async (output) => {
    body = output;
    await expect(embed()).rejects.toMatchObject({
      code: 'EMBEDDING_INVALID_OUTPUT',
      retryable: false,
    });
  });
  it('rejects input token limits before issuing a request', async () => {
    await expect(
      embed({ maxInputTokens: 1, maxBatchTokens: 1 }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_INPUT_LIMIT' });
  });
  it('sanitizes network and timeout errors', async () => {
    const transport: typeof fetch = async () => {
      throw Error('private endpoint and key');
    };
    const provider = new OpenAiCompatibleEmbeddingProvider(
      { ...config, endpoint },
      transport,
    );
    const signal = AbortSignal.abort();
    await expect(
      provider.embed({
        profile,
        inputs: [{ id: 'a', text: 'hello' }],
        purpose: 'document',
        signal,
      }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_TIMEOUT', retryable: true });
  });
});
