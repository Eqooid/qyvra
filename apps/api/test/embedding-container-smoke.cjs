const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const {
  OpenAiCompatibleEmbeddingProvider,
} = require('/app/apps/api/dist/infrastructure/embeddings/openai-compatible.provider');
const {
  EmbeddingGenerationHandler,
} = require('/app/apps/api/dist/infrastructure/worker/embedding-generation.handler');
const {
  WorkerModule,
} = require('/app/apps/api/dist/infrastructure/worker/worker.module');
assert.equal(typeof EmbeddingGenerationHandler, 'function');
assert.equal(typeof WorkerModule, 'function');
let received;
const server = createServer((request, response) => {
  const parts = [];
  request.on('data', (part) => parts.push(part));
  request.on('end', () => {
    received = JSON.parse(Buffer.concat(parts).toString('utf8'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        model: 'offline-model',
        data: [
          { index: 1, embedding: [4, 5, 6] },
          { index: 0, embedding: [1, 2, 3] },
        ],
      }),
    );
  });
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = {
      enabled: true,
      endpoint: `http://127.0.0.1:${server.address().port}/v1/embeddings`,
      batchSize: 32,
      maxInputTokens: 8191,
      maxBatchTokens: 100000,
      timeoutMs: 1000,
      sendDimensions: true,
    };
    const profile = {
      profileVersion: 1,
      provider: 'openai-compatible',
      model: 'offline-model',
      modelRevision: 'offline-v1',
      dimensions: 3,
      distance: 'Cosine',
      normalizationVersion: 'qyvra-embedding-input/v1',
      tokenizer: 'cl100k_base',
      tokenizerVersion: 'tiktoken-1.0.22',
      documentInstruction: '',
      queryInstruction: '',
    };
    const vectors = await new OpenAiCompatibleEmbeddingProvider(config).embed({
      profile,
      purpose: 'document',
      inputs: [
        { id: 'owned-a', text: 'é 文 😀' },
        { id: 'owned-b', text: 'Indonesian text' },
      ],
      signal: AbortSignal.timeout(1000),
    });
    assert.deepEqual(vectors, [
      { id: 'owned-a', vector: [1, 2, 3] },
      { id: 'owned-b', vector: [4, 5, 6] },
    ]);
    assert.deepEqual(received.input, ['é 文 😀', 'Indonesian text']);
    assert.equal(JSON.stringify(received).includes('owned-'), false);
    console.log(
      'T06 container smoke passed: compiled worker/provider, local HTTP, WASM token limits, Unicode and explicit vector mapping; no paid API/key/external networking.',
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error.name);
  process.exitCode = 1;
});
