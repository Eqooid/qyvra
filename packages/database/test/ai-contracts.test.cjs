const test = require('node:test');
const assert = require('node:assert/strict');
const {
  embeddingProfileFingerprint,
  aiStagePrerequisites,
  processingJobTypes,
  createProcessingOutboxIntent,
} = require('../dist');

test('embedding identity is stable and distinguishes every semantic configuration field', () => {
  const profile = {
    profileVersion: 1,
    provider: 'test',
    model: 'test-model',
    modelRevision: 'revision-1',
    dimensions: 3,
    distance: 'Cosine',
    normalizationVersion: 'nfc-lf-v1',
    tokenizer: 'test-tokenizer',
    tokenizerVersion: 'v1',
    documentInstruction: '',
    queryInstruction: '',
  };
  const hash = embeddingProfileFingerprint(profile);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(
    hash,
    embeddingProfileFingerprint(
      Object.fromEntries(Object.entries(profile).reverse()),
    ),
  );
  for (const key of Object.keys(profile).filter((key) => key !== 'distance')) {
    const value =
      typeof profile[key] === 'number'
        ? profile[key] + 1
        : `${profile[key]}-changed`;
    assert.notEqual(
      hash,
      embeddingProfileFingerprint({ ...profile, [key]: value }),
      key,
    );
  }
  assert.equal(
    hash,
    embeddingProfileFingerprint({ ...profile, timeout: 2000, batchSize: 8 }),
  );
  for (const value of [0, -1, 1.5, NaN, Infinity, 65537]) {
    assert.throws(() =>
      embeddingProfileFingerprint({ ...profile, dimensions: value }),
    );
  }
  assert.throws(() =>
    embeddingProfileFingerprint({ ...profile, provider: ' ' }),
  );
  assert.throws(() =>
    embeddingProfileFingerprint({ ...profile, distance: 'Dot' }),
  );
});

test('AI vocabulary declares existing-job dependencies without enabling v1 AI delivery', async () => {
  assert.deepEqual(processingJobTypes, [
    'VERIFY_STORED_FILE',
    'EXTRACT_TEXT',
    'GENERATE_CHUNKS',
    'GENERATE_EMBEDDINGS',
    'INDEX_VECTORS',
    'REMOVE_VECTOR_INDEX',
  ]);
  assert.equal(aiStagePrerequisites.EXTRACT_TEXT, 'VERIFY_STORED_FILE');
  assert.equal(aiStagePrerequisites.INDEX_VECTORS, 'GENERATE_EMBEDDINGS');
  await assert.rejects(
    createProcessingOutboxIntent(
      {},
      { jobType: 'EXTRACT_TEXT' },
      1,
      new Date(),
      1,
    ),
    /Unsupported v1/,
  );
});
