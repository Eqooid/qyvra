// Explicit Linux development setup; Docker uses its isolated compiler stage.
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
if (process.platform !== 'linux')
  throw Error('The seccomp launcher is Linux only.');
const directory = resolve(__dirname, '../src/infrastructure/extraction');
execFileSync(
  'gcc',
  [
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    resolve(directory, 'pdf-parser-guard.c'),
    '-o',
    resolve(directory, 'pdf-parser-guard'),
  ],
  { stdio: 'inherit', windowsHide: true },
);
