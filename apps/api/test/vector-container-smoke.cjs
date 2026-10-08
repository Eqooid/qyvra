const assert = require('node:assert/strict');
const { QdrantClient } = require('/app/apps/api/node_modules/@qdrant/js-client-rest');
const { QdrantVectorStore } = require('/app/apps/api/dist/infrastructure/vectors/qdrant-vector-store');
const { VectorIndexHandler } = require('/app/apps/api/dist/infrastructure/worker/vector-index.handler');
const { VectorRemovalHandler } = require('/app/apps/api/dist/infrastructure/worker/vector-removal.handler');
const { WorkerModule } = require('/app/apps/api/dist/infrastructure/worker/worker.module');
const { vectorPointId } = require('/app/apps/api/dist/modules/ai/vector-store');
const fixture = require('/tmp/vector-smoke.json');
const url = process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:6333';
const apiKey = process.env.TEST_QDRANT_KEY;
const store = new QdrantVectorStore({ enabled: true, url, apiKey, timeoutMs: 5000, batchSize: 2 });
const { collectionName: _name, ...payload } = fixture.scope;
const point = { id: vectorPointId(fixture.chunkId, fixture.scope.embeddingProfileId, fixture.scope.indexManifestId), vector: [1e300, 2e300, 3e300], payload: { ...payload, chunkId: fixture.chunkId, ordinal: 0, payloadSchemaVersion: 1, pageNumbers: [1,2] } };
(async () => {
  assert.equal(typeof VectorIndexHandler, 'function');
  assert.equal(typeof VectorRemovalHandler, 'function');
  assert.equal(typeof WorkerModule, 'function');
  if (process.argv[2] === 'write') {
    if (apiKey) await assert.rejects(new QdrantVectorStore({ enabled: true, url, apiKey: 'incorrect-fixture-key', timeoutMs: 5000, batchSize: 2 }).count(fixture.scope), error => error.code === 'VECTOR_AUTH_FAILED' && !error.retryable);
    await store.ensureCollection(fixture.scope, 3);
    await store.upsert(fixture.scope, [point]);
    await store.upsert(fixture.scope, [point]);
    assert.equal(await store.count(fixture.scope), 1);
    assert.equal(await store.verify(fixture.scope, [point]), true);
  } else {
    assert.equal(await store.count(fixture.scope), 1);
    assert.equal(await store.verify(fixture.scope, [point]), true);
    await store.remove(fixture.scope);
    await store.remove(fixture.scope);
    assert.equal(await store.count(fixture.scope), 0);
    await new QdrantClient({ url, apiKey, checkCompatibility: false }).deleteCollection(fixture.scope.collectionName);
    await assert.rejects(store.verify(fixture.scope, [point]), error => error.code === 'VECTOR_COLLECTION_MISSING' && error.retryable);
    await store.remove(fixture.scope); // Already-missing collection is successful cleanup.
  }
  console.log('T07 container smoke passed: compiled worker modules, Qdrant SDK, bounded vectors, deterministic IDs, verified writes and scoped cleanup.');
})().catch(error => { console.error(error.name); process.exitCode = 1; });
