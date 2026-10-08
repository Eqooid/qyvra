const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  IsolatedPdfParser,
} = require('/app/apps/api/dist/infrastructure/extraction/pdf-parser.js');
const limits = {
  maxBytes: 52428800,
  maxPages: 500,
  maxCharacters: 5000000,
  maxTextBytes: 20000000,
  timeoutMs: 10000,
  heapMb: 256,
};
(async () => {
  assert.equal(process.getuid(), 1000);
  const parser = new IsolatedPdfParser(limits, true);
  for (const [file, expected] of [
    ['single.pdf', 'Hello Qyvra'],
    ['multi.pdf', 'First page\n\n\n\nThird page'],
    ['script.pdf', 'Safe document'],
  ]) {
    const result = await parser.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures/pdf', file)),
      10000,
    );
    assert.equal(result.kind, 'success', JSON.stringify(result));
    assert.equal(result.content.text, expected);
  }
  for (const [file, code] of [
    ['empty.pdf', 'OCR_REQUIRED'],
    ['graphics.pdf', 'OCR_REQUIRED'],
    ['image-only.pdf', 'OCR_REQUIRED'],
    ['encrypted.pdf', 'PDF_ENCRYPTED'],
    ['encrypted-empty-password.pdf', 'PDF_ENCRYPTED'],
    ['malformed.pdf', 'PDF_MALFORMED'],
  ])
    assert.deepEqual(
      await parser.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures/pdf', file)),
        10000,
      ),
      { kind: 'terminal', failureCode: code },
    );
  const guard = '/app/apps/api/dist/infrastructure/extraction/pdf-parser-guard';
  const result = execFileSync(
    guard,
    [
      '5',
      process.execPath,
      '--permission',
      `--allow-fs-read=${__dirname}`,
      path.join(__dirname, 'pdf-sandbox-probe.cjs'),
    ],
    { encoding: 'utf8', env: {} },
  );
  assert.match(result, /probes passed/);
  process.stdout.write(
    '9 real PDF fixtures and unprivileged Linux sandbox probes passed\n',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
