const assert = require('node:assert/strict');
const { DeterministicChunker, hashText } = require('/app/apps/api/dist/modules/ai/deterministic-chunker');
const { ChunkGenerationHandler } = require('/app/apps/api/dist/infrastructure/worker/chunk-generation.handler');
assert.equal(typeof ChunkGenerationHandler, 'function');
const text = 'A source paragraph with café and emoji 😀.\n\nAnother page contains 日本語. '.repeat(20).trim();
const size = [...text].length;
const input = { versionId: '11111111-1111-4111-8111-111111111111', extractionId: '22222222-2222-4222-8222-222222222222', text, contentHash: hashText(text), characterCount: size,
  pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: 45 }, { pageNumber: 2, startOffset: 45, endOffset: size }] };
(async () => {
  const chunker = new DeterministicChunker();
  const config = { chunkSize: 32, chunkOverlap: 8 };
  const output = await chunker.chunk(input, config);
  assert.deepEqual(await chunker.chunk(input, config), output);
  assert(output.chunks.length > 1);
  assert(output.chunks.every(c => c.tokenCount <= 32 && c.text === [...text].slice(c.startOffset, c.endOffset).join('')));
  assert(output.chunks.some(c => c.pageSpans.length > 1));
  console.log(`T05 container smoke passed: ${output.chunks.length} deterministic Unicode/provenance chunks; native worker handler and local WASM load successfully.`);
})().catch(error => { console.error(error.name); process.exitCode = 1; });
