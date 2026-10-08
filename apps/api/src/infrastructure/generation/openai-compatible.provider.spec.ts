import { createServer } from 'node:http';
import { OpenAiCompatibleGenerationProvider } from './openai-compatible.provider';
import { GenerationFailure } from '../../modules/ai/generation-provider';

describe('native bounded generation adapter', () => {
  const config = {
    tokenizer: 'o200k_base' as const,
    provider: 'openai-compatible' as const,
    model: 'test-model',
    endpoint: 'https://provider.example/chat/completions',
    apiKey: 'not-a-real-key',
    timeoutMs: 1000,
    maxOutputTokens: 1024,
    temperature: 0,
    outputTokenField: 'max_completion_tokens' as const,
  };
  const input = () => ({
    messages: [
      { role: 'system' as const, content: 'Rules' },
      { role: 'user' as const, content: 'Evidence' },
    ],
    signal: new AbortController().signal,
  });
  const valid = {
    choices: [
      {
        finish_reason: 'stop',
        message: { content: '{"outcome":"insufficient_evidence","claims":[]}' },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
  it('works over real native HTTP with strict schema, independent model and no tools/history', async () => {
    let received: Record<string, unknown> = {};
    const server = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      received = JSON.parse(Buffer.concat(parts).toString()) as Record<
        string,
        unknown
      >;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(valid));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error();
    try {
      const provider = new OpenAiCompatibleGenerationProvider({
        ...config,
        endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
      });
      expect(await provider.generate(input())).toEqual({
        content: valid.choices[0].message.content,
        usage: { inputTokens: 100, outputTokens: 20 },
      });
      expect(received).toMatchObject({
        model: 'test-model',
        max_completion_tokens: 1024,
        stream: false,
        store: false,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { strict: true } },
      });
      expect(received.tools).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([429, 401, 500])(
    'sanitizes provider %i without body leakage or retries',
    async (status) => {
      const transport = jest.fn(
        async () => new Response('SECRET provider body', { status }),
      ) as unknown as jest.MockedFunction<typeof fetch>;
      const provider = new OpenAiCompatibleGenerationProvider(
        config,
        transport,
      );
      await expect(provider.generate(input())).rejects.toEqual(
        new GenerationFailure(
          status === 429 ? 'GENERATION_RATE_LIMITED' : 'GENERATION_UNAVAILABLE',
        ),
      );
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    'not JSON',
    JSON.stringify({ choices: [] }),
    JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '{}' } }],
    }),
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '{}', refusal: 'refusal' },
        },
      ],
    }),
    'x'.repeat(262145),
  ])(
    'rejects malformed, truncated, refusal or oversized output',
    async (body) => {
      const transport = jest.fn(
        async () => new Response(body),
      ) as unknown as jest.MockedFunction<typeof fetch>;
      await expect(
        new OpenAiCompatibleGenerationProvider(config, transport).generate(
          input(),
        ),
      ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    },
  );
  it('aborts provider timeout and propagates cancellation safely', async () => {
    const transport = jest.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(Error('sensitive transport'));
          else
            signal?.addEventListener(
              'abort',
              () => reject(Error('sensitive transport')),
              { once: true },
            );
        }),
    ) as unknown as jest.MockedFunction<typeof fetch>;
    await expect(
      new OpenAiCompatibleGenerationProvider(
        { ...config, timeoutMs: 10 },
        transport,
      ).generate(input()),
    ).rejects.toMatchObject({ code: 'GENERATION_TIMEOUT' });
    const cancelled = input();
    const abort = new AbortController();
    abort.abort();
    cancelled.signal = abort.signal;
    await expect(
      new OpenAiCompatibleGenerationProvider(config, transport).generate(
        cancelled,
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_TIMEOUT' });
  });
});
