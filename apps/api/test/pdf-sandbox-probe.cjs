// Linux container test only. No document data, credentials or external requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const net = require('node:net');
assert.throws(() => fs.readFileSync('/etc/passwd'), {
  code: 'ERR_ACCESS_DENIED',
});
assert.throws(() => fs.writeFileSync('/tmp/pdf-probe', 'test'), {
  code: 'ERR_ACCESS_DENIED',
});
assert.throws(() => spawnSync(process.execPath, ['--version']), {
  code: 'ERR_ACCESS_DENIED',
});
const socket = net.createConnection({ host: '127.0.0.1', port: 9 });
socket.on('connect', () => {
  throw Error('Kernel network denial failed');
});
socket.on('error', (error) => {
  assert.equal(error.code, 'EPERM');
  process.stdout.write(
    'PDF sandbox read/write/process/network probes passed\n',
  );
});
