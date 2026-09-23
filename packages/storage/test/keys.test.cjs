const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  validateStorageKey,
  originalDocumentKey,
  StorageError,
  validateLocalStorageRoot,
} = require('../dist');

test('trusted UUIDs create a portable original key without display filenames', () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const key = originalDocumentKey(...ids.map((id) => id.toUpperCase()), 'pdf');
  assert.equal(key, `documents/${ids.join('/')}/original.pdf`);
  for (const extension of ['../pdf', '.pdf', 'PDF', 'pdf\u0000', 'pdf/file'])
    assert.throws(() => originalDocumentKey(...ids, extension), StorageError);
  assert.throws(
    () => originalDocumentKey('foreign', ids[1], ids[2], 'pdf'),
    StorageError,
  );
});
test('rejects absolute, traversal, Windows aliases, encoded and malformed keys', () => {
  for (const key of [
    '',
    '/etc/passwd',
    '../private',
    'a/../b',
    'a/./b',
    'a//b',
    'a/',
    '\\server\\share',
    'C:/windows/file',
    'c:\\file',
    'a\u0000b',
    'a\\b',
    'a/%2e%2e/b',
    'a/b:stream',
    'a/b.',
    'a/b ',
    'a/CON.txt',
    'a/con.txt',
    'a/lpt1',
    '.pending-foo',
    'a'.repeat(129),
    'a/'.repeat(17) + 'b',
    'a/é',
  ])
    assert.throws(() => validateStorageKey(key), { code: 'INVALID_KEY' });
  assert.equal(
    validateStorageKey('safe/nested/object.pdf'),
    'safe/nested/object.pdf',
  );
});
test('root validation and all neutral error messages omit supplied paths', () => {
  for (const root of ['', '.', '../secret', '/private/../escape', '/'])
    assert.throws(() => validateLocalStorageRoot(root), {
      code: 'UNAVAILABLE',
    });
  for (const code of [
    'NOT_FOUND',
    'INVALID_KEY',
    'ALREADY_EXISTS',
    'UNAVAILABLE',
    'READ_FAILED',
    'WRITE_FAILED',
    'DELETE_FAILED',
  ]) {
    const error = new StorageError(code);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('/'));
  }
});
