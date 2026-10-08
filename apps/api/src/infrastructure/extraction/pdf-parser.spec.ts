import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { IsolatedPdfParser } from './pdf-parser';

const limits = {
  maxBytes: 52428800,
  maxPages: 500,
  maxCharacters: 5000000,
  maxTextBytes: 20000000,
  timeoutMs: 30000,
  heapMb: 256,
};
const fixture = (name: string) =>
  readFile(resolve(__dirname, '../../../test/fixtures/pdf', name));
describe('isolated PDF parser', () => {
  it('extracts deterministic text and exact page spans including empty pages', async () => {
    const parser = new IsolatedPdfParser(limits);
    const bytes = await fixture('multi.pdf');
    const first = await parser.parse(bytes, 10000);
    expect(first).toEqual(await parser.parse(bytes, 10000));
    expect(first).toEqual({
      kind: 'success',
      content: {
        text: 'First page\n\n\n\nThird page',
        characterCount: 24,
        pageCount: 3,
        pageSpans: [
          { pageNumber: 1, startOffset: 0, endOffset: 10 },
          { pageNumber: 2, startOffset: 12, endOffset: 12 },
          { pageNumber: 3, startOffset: 14, endOffset: 24 },
        ],
      },
    });
  });
  it('normalizes whitespace and ignores embedded document JavaScript', async () => {
    const parser = new IsolatedPdfParser(limits);
    expect(
      await parser.parse(await fixture('single.pdf'), 10000),
    ).toMatchObject({ kind: 'success', content: { text: 'Hello Qyvra' } });
    expect(
      await parser.parse(await fixture('script.pdf'), 10000),
    ).toMatchObject({ kind: 'success', content: { text: 'Safe document' } });
  });
  it.each([
    ['malformed.pdf', 'PDF_MALFORMED'],
    ['empty.pdf', 'OCR_REQUIRED'],
    ['graphics.pdf', 'OCR_REQUIRED'],
    ['image-only.pdf', 'OCR_REQUIRED'],
    ['encrypted.pdf', 'PDF_ENCRYPTED'],
    ['encrypted-empty-password.pdf', 'PDF_ENCRYPTED'],
  ])(
    'classifies %s without exposing parser diagnostics',
    async (file, code) => {
      expect(
        await new IsolatedPdfParser(limits).parse(await fixture(file), 10000),
      ).toEqual({ kind: 'terminal', failureCode: code });
    },
  );
  it.each([
    { maxPages: 1 },
    { maxCharacters: 2 },
    { maxTextBytes: 2 },
    { maxBytes: 2 },
  ])('enforces configured input/output limits %j', async (override) => {
    expect(
      await new IsolatedPdfParser({ ...limits, ...override }).parse(
        await fixture('multi.pdf'),
        10000,
      ),
    ).toEqual({ kind: 'terminal', failureCode: 'EXTRACTION_LIMIT_EXCEEDED' });
  });
  it('kills a parser at its hard deadline', async () => {
    expect(
      await new IsolatedPdfParser(limits).parse(await fixture('single.pdf'), 1),
    ).toEqual({ kind: 'terminal', failureCode: 'EXTRACTION_TIMEOUT' });
  });
  it('normalizes Unicode scalars, controls, LF and preserves blank page provenance', async () => {
    const moduleUrl = pathToFileURL(
      resolve(__dirname, 'canonical-text.mjs'),
    ).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {canonicalContent} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(canonicalContent(['  e\\u0301\\t  😀\\r\\nNext\\0\\u0001 ', ''])));`,
      ],
      { windowsHide: true },
    );
    expect(JSON.parse(stdout)).toEqual({
      text: 'é 😀\nNext\n\n',
      characterCount: 10,
      pageCount: 2,
      pageSpans: [
        { pageNumber: 1, startOffset: 0, endOffset: 8 },
        { pageNumber: 2, startOffset: 10, endOffset: 10 },
      ],
    });
  });
});
