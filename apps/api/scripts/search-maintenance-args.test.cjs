const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSearchMaintenanceArgs: parse,
} = require('./search-maintenance-args.cjs');
const id = '11111111-1111-4111-8111-111111111111';
test('dry-run by default, explicit owner scope and bounded repeatable operations', () => {
  const args = parse([
    'backfill',
    '--operator',
    'ops:alice',
    '--owner',
    id,
    '--generation',
    id,
  ]);
  assert.equal(args.apply, false);
  assert.equal(args.batch, 10);
  assert.equal(args.maxBatches, 1);
  assert.match(args.operation, /^[0-9a-f-]{36}$/);
});
test('reject unknown options, arbitrary indexes, implicit global scope, invalid limits and duplicate flags', () => {
  for (const args of [
    ['backfill', '--index', 'private'],
    ['rebuild', '--generation', id],
    ['backfill', '--generation', id],
    ['backfill', '--owner', id, '--generation', id, '--batch', '26'],
    [
      'backfill',
      '--owner',
      id,
      '--generation',
      id,
      '--batch',
      '1',
      '--batch',
      '2',
    ],
    ['backfill', '--owner', '../private', '--generation', id],
    ['backfill', '--owner', id, '--generation', id, '--max-batches', '1000000'],
  ])
    assert.throws(() => parse([...args, '--operator', 'ops:alice']));
});
test('cutover needs explicit all-owner scope and exact confirmed generation; no destructive index command', () => {
  const args = [
    'cutover',
    '--operator',
    'ops:alice',
    '--generation',
    id,
    '--all-owners',
    '--apply',
  ];
  assert.throws(() => parse(args));
  assert.equal(parse([...args, '--confirm-generation', id]).apply, true);
  assert.throws(() => parse(['delete-index', '--operator', 'ops:alice']));
});
test('validates private physical scan cursors and cannot inject query syntax', () => {
  const args = [
    'scan',
    '--operator',
    'ops:alice',
    '--owner',
    id,
    '--generation',
    id,
  ];
  assert.deepEqual(parse([...args, '--after', JSON.stringify([id])]).after, [
    id,
  ]);
  for (const cursor of [
    '{}',
    '["*"]',
    JSON.stringify([id, 0]),
    JSON.stringify([id, -1, 0]),
  ])
    assert.throws(() => parse([...args, '--after', cursor]));
});
