const test = require('node:test');
const assert = require('node:assert/strict');
const {
  searchGenerationFingerprint,
  searchProjectionId,
  searchRecordId,
  searchProcessingJobTypes,
  legacyProcessingJobTypes,
} = require('../dist');
const identity = {
  schemaVersion: 1,
  mappingVersion: 'v1',
  analyzerVersion: 'v1',
  extractor: 'pdf',
  extractorVersion: 'v1',
  normalizationVersion: 'nfc-lf-v1',
  segmentationVersion: 'v1',
};
const version = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
test('search generation identity is deterministic, order independent and configuration bound', () => {
  const fingerprint = searchGenerationFingerprint(identity);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    searchGenerationFingerprint(
      Object.fromEntries(Object.entries(identity).reverse()),
    ),
    fingerprint,
  );
  for (const field of Object.keys(identity)) {
    const changed = {
      ...identity,
      [field]: field === 'schemaVersion' ? 2 : 'v2',
    };
    assert.notEqual(searchGenerationFingerprint(changed), fingerprint);
  }
  for (const invalid of [
    { ...identity, schemaVersion: 0 },
    { ...identity, mappingVersion: '' },
    { ...identity, extractor: 'https://secret.invalid' },
    { ...identity, segmentationVersion: 'x'.repeat(101) },
  ])
    assert.throws(() => searchGenerationFingerprint(invalid));
});
test('projection and remote record identities bind exact version, generation and revision', () => {
  const id = searchProjectionId(version, generation, 1);
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    searchProjectionId(version.toUpperCase(), generation.toUpperCase(), 1),
    id,
  );
  assert.notEqual(searchProjectionId(version, generation, 2), id);
  assert.notEqual(searchProjectionId(generation, version, 1), id);
  assert.equal(searchRecordId(id, { kind: 'metadata' }), id + ':metadata');
  assert.equal(
    searchRecordId(id, { kind: 'page', pageNumber: 3, segment: 0 }),
    id + ':page:3:0',
  );
  for (const revision of [0, -1, 1.1, 2147483648, NaN])
    assert.throws(() => searchProjectionId(version, generation, revision));
  assert.throws(() => searchProjectionId('bad', generation, 1));
  for (const source of [
    { kind: 'page', pageNumber: 0, segment: 0 },
    { kind: 'page', pageNumber: 1, segment: -1 },
    { kind: 'page', pageNumber: 1, segment: 2147483648 },
    { kind: 'unknown' },
  ])
    assert.throws(() => searchRecordId(id, source));
});
test('v3 search vocabulary is disjoint from unchanged v1/v2 vocabulary', () => {
  assert.deepEqual(searchProcessingJobTypes, [
    'INDEX_SEARCH',
    'EXTRACT_SEARCH_TEXT',
    'REMOVE_SEARCH_INDEX',
  ]);
  assert.equal(legacyProcessingJobTypes.length, 6);
  assert.ok(
    searchProcessingJobTypes.every(
      (type) => !legacyProcessingJobTypes.includes(type),
    ),
  );
});
