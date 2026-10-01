const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertJobTransition,
  retryDelayMs,
  ProcessingError,
} = require('../dist');

test('canonical lifecycle permits only documented transitions', () => {
  for (const [from, to] of [
    ['PENDING', 'QUEUED'],
    ['PENDING', 'PROCESSING'],
    ['PENDING', 'CANCELLED'],
    ['QUEUED', 'PROCESSING'],
    ['QUEUED', 'CANCELLED'],
    ['PROCESSING', 'COMPLETED'],
    ['PROCESSING', 'RETRYING'],
    ['PROCESSING', 'FAILED'],
    ['PROCESSING', 'CANCELLED'],
    ['RETRYING', 'QUEUED'],
    ['RETRYING', 'PROCESSING'],
    ['RETRYING', 'FAILED'],
    ['RETRYING', 'CANCELLED'],
  ])
    assert.doesNotThrow(() => assertJobTransition(from, to));
  for (const [from, to] of [
    ['COMPLETED', 'PROCESSING'],
    ['FAILED', 'COMPLETED'],
    ['CANCELLED', 'QUEUED'],
    ['PENDING', 'COMPLETED'],
  ])
    assert.throws(
      () => assertJobTransition(from, to),
      (error) =>
        error instanceof ProcessingError && error.code === 'INVALID_TRANSITION',
    );
});

test('retry delay is bounded, increasing, and deterministic for an attempt', () => {
  const id = '12345678-1234-1234-1234-123456789012';
  assert.equal(retryDelayMs(id, 1), retryDelayMs(id, 1));
  assert.ok(retryDelayMs(id, 2) > retryDelayMs(id, 1));
  assert.ok(retryDelayMs(id, 20) <= 300_000);
  assert.throws(() => retryDelayMs(id, 0), ProcessingError);
});
