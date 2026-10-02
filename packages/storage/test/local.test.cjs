const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, relative, sep } = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { LocalFileStorage, StorageError } = require('../dist');
let sandbox, root, storage;
test('late read failures expose only the provider-neutral error', async (context) => {
  await storage.save('object', Readable.from(['private']));
  const original = fs.open;
  context.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args);
    const create = handle.createReadStream.bind(handle);
    handle.createReadStream = () => {
      const source = create();
      queueMicrotask(() => source.destroy(new Error(`private ${sandbox}`)));
      return source;
    };
    return handle;
  });
  const input = await storage.open('object');
  await assert.rejects(
    pipeline(
      input,
      new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      }),
    ),
    (error) =>
      error.code === 'READ_FAILED' &&
      !error.message.includes(sandbox) &&
      !error.cause,
  );
});
test('delete failures are sanitized and preserve the object', async (context) => {
  await storage.save('object', Readable.from(['private']));
  context.mock.method(fs, 'unlink', async () => {
    throw new Error(`private ${sandbox}`);
  });
  await assert.rejects(storage.delete('object'), { code: 'DELETE_FAILED' });
  assert.equal(await contents('object'), 'private');
});
test('an input error during preparation is sanitized and cannot publish an object', async () => {
  const source = new Readable({ read() {} });
  const saving = storage.save('early/failure', source);
  source.destroy(new Error('private early source failure'));
  await assert.rejects(saving, { code: 'WRITE_FAILED' });
  assert.equal(await storage.exists('early/failure'), false);
});

test('caller interruption removes the temporary file and closes the source', async () => {
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(1024));
      this.destroy();
    },
  });
  await assert.rejects(storage.save('interrupted', source), {
    code: 'WRITE_FAILED',
  });
  assert.equal(source.destroyed, true);
  assert.deepEqual(await fs.readdir(root), []);
});

test('a final file symlink is never followed', async (context) => {
  await fs.mkdir(root);
  const outside = join(sandbox, 'private-file');
  await fs.writeFile(outside, 'private');
  try {
    await fs.symlink(outside, join(root, 'link'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      context.skip(
        'Windows file symlink privilege unavailable; junction test still runs.',
      );
      return;
    }
    throw error;
  }
  for (const operation of ['open', 'metadata', 'delete', 'exists'])
    await assert.rejects(storage[operation]('link'), { code: 'UNAVAILABLE' });
  await assert.rejects(storage.save('link', Readable.from(['replace'])), {
    code: 'ALREADY_EXISTS',
  });
  assert.equal(await fs.readFile(outside, 'utf8'), 'private');
});
beforeEach(async () => {
  sandbox = await fs.mkdtemp(join(tmpdir(), 'qyvra-storage-test-'));
  root = join(sandbox, 'objects');
  storage = new LocalFileStorage(root);
});
afterEach(async () => {
  // Delete only the exact mkdtemp result. Never derive cleanup from storage input.
  const child = relative(resolve(tmpdir()), resolve(sandbox));
  assert.ok(child.startsWith('qyvra-storage-test-') && !child.includes(sep));
  await fs.rm(sandbox, { recursive: true, force: true });
});
async function contents(key) {
  const chunks = [];
  for await (const chunk of await storage.open(key)) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('streams nested write/read, safe metadata, existence and idempotent deletion', async () => {
  assert.equal(await storage.exists('nested/object.pdf'), false);
  const data = await storage.save(
    'nested/object.pdf',
    Readable.from([Buffer.from('hello'), Buffer.from(' world')]),
  );
  assert.equal(data.size, 11);
  assert.deepEqual(Object.keys(data).sort(), ['key', 'lastModified', 'size']);
  assert.ok(!JSON.stringify(data).includes(root));
  assert.equal(await contents(data.key), 'hello world');
  assert.equal(await storage.exists(data.key), true);
  assert.deepEqual(await storage.metadata(data.key), data);
  assert.equal(await storage.delete(data.key), true);
  assert.equal(await storage.delete(data.key), false);
  for (const operation of ['open', 'metadata'])
    await assert.rejects(storage[operation](data.key), { code: 'NOT_FOUND' });
});
test('concurrent writes publish one complete winner and never overwrite', async () => {
  const results = await Promise.allSettled(
    ['first', 'second'].map((value) =>
      storage.save('same', Readable.from([value])),
    ),
  );
  assert.equal(
    results.filter((value) => value.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.find((value) => value.status === 'rejected').reason.code,
    'ALREADY_EXISTS',
  );
  const before = await contents('same');
  await assert.rejects(storage.save('same', Readable.from(['replace'])), {
    code: 'ALREADY_EXISTS',
  });
  assert.equal(await contents('same'), before);
  assert.deepEqual(await fs.readdir(root), ['same']);
});
test('failed input leaves neither published object nor incomplete temporary file', async () => {
  const source = Readable.from(
    (async function* () {
      yield Buffer.alloc(4096);
      throw new Error(`private ${root}`);
    })(),
  );
  await assert.rejects(
    storage.save('nested/failure', source),
    (error) =>
      error.code === 'WRITE_FAILED' &&
      !error.message.includes(root) &&
      !error.cause,
  );
  assert.equal(await storage.exists('nested/failure'), false);
  assert.deepEqual(await fs.readdir(join(root, 'nested')), []);
});
test('large streams stay bounded and unpublished until input completes', async () => {
  let produced = 0;
  let consumed = 0;
  const count = 512;
  const chunk = Buffer.alloc(64 * 1024, 7);
  const source = Readable.from(
    (async function* () {
      for (let i = 0; i < count; i++) {
        produced++;
        if (i === 1) assert.equal(await storage.exists('large'), false);
        yield chunk;
      }
    })(),
    { objectMode: false, highWaterMark: 64 * 1024 },
  );
  assert.equal(
    (await storage.save('large', source)).size,
    count * chunk.length,
  );
  assert.equal(produced, count);
  const input = await storage.open('large');
  let maxBuffered = 0;
  await pipeline(
    input,
    new Writable({
      highWaterMark: 64 * 1024,
      write(data, encoding, callback) {
        consumed += data.length;
        maxBuffered = Math.max(maxBuffered, input.readableLength);
        setImmediate(callback);
      },
    }),
  );
  assert.equal(consumed, count * chunk.length);
  assert.ok(maxBuffered <= 128 * 1024);
});
test('invalid keys cannot escape root through any operation', async () => {
  for (const key of [
    '../outside',
    '/absolute',
    'a/../../outside',
    'a\\..\\b',
    'a//b',
    'a\u0000b',
    'C:/outside',
  ]) {
    for (const operation of ['open', 'metadata', 'exists', 'delete'])
      await assert.rejects(storage[operation](key), { code: 'INVALID_KEY' });
    await assert.rejects(storage.save(key, Readable.from(['unsafe'])), {
      code: 'INVALID_KEY',
    });
  }
  assert.deepEqual(await fs.readdir(sandbox), []);
});
test('root and intermediate symbolic links or Windows junctions are rejected', async () => {
  const outside = join(sandbox, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'secret'), 'untouched');
  await fs.mkdir(root);
  await fs.symlink(outside, join(root, 'escape'), 'junction');
  for (const operation of ['open', 'metadata', 'exists', 'delete'])
    await assert.rejects(storage[operation]('escape/secret'), {
      code: 'UNAVAILABLE',
    });
  await assert.rejects(storage.save('escape/new', Readable.from(['unsafe'])), {
    code: 'UNAVAILABLE',
  });
  const linked = new LocalFileStorage(join(root, 'escape'));
  await assert.rejects(linked.open('secret'), { code: 'UNAVAILABLE' });
  assert.equal(await fs.readFile(join(outside, 'secret'), 'utf8'), 'untouched');
  assert.deepEqual(await fs.readdir(outside), ['secret']);
});
test('directory objects and inaccessible roots fail safely without leaking paths', async () => {
  await fs.mkdir(root);
  await fs.mkdir(join(root, 'directory'));
  for (const operation of ['open', 'metadata', 'delete'])
    await assert.rejects(storage[operation]('directory'), StorageError);
  const badRoot = join(sandbox, 'not-directory');
  await fs.writeFile(badRoot, 'data');
  await assert.rejects(
    new LocalFileStorage(badRoot).save('object', Readable.from(['x'])),
    (error) => error.code === 'UNAVAILABLE' && !error.message.includes(sandbox),
  );
});
