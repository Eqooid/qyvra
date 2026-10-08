import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { ApiConfiguration } from '../../configuration/settings';

export const PDF_EXTRACTOR = {
  extractor: 'pdfjs',
  extractorVersion: '6.4.299-qyvra-layout-v1',
  normalizationVersion: 'nfc-lf-v1',
} as const;

export interface CanonicalContent {
  text: string;
  characterCount: number;
  pageCount: number;
  pageSpans: { pageNumber: number; startOffset: number; endOffset: number }[];
}
export type PdfParseResult =
  | { kind: 'success'; content: CanonicalContent }
  | { kind: 'terminal' | 'retryable'; failureCode: string };
export interface PdfParser {
  parse(bytes: Buffer, timeoutMs: number): Promise<PdfParseResult>;
}

/** One disposable process per bounded PDF. No inherited credentials or shell. */
export class IsolatedPdfParser implements PdfParser {
  constructor(
    private readonly limits: ApiConfiguration['extraction'],
    requireKernelIsolation = false,
  ) {
    if (requireKernelIsolation && process.platform !== 'linux')
      throw new Error('Production PDF extraction requires the Linux sandbox.');
  }

  parse(bytes: Buffer, timeoutMs: number): Promise<PdfParseResult> {
    const script = join(__dirname, 'pdf-parser.mjs');
    const packageRoot = dirname(require.resolve('pdfjs-dist/package.json'));
    const args = [
      `--max-old-space-size=${this.limits.heapMb}`,
      '--permission',
      `--allow-fs-read=${__dirname}`,
      `--allow-fs-read=${packageRoot}`,
      script,
      String(this.limits.maxBytes),
      String(this.limits.maxPages),
      String(this.limits.maxCharacters),
      String(this.limits.maxTextBytes),
    ];
    // Linux production fails closed if the kernel network/CPU guard is absent.
    const linux = process.platform === 'linux';
    const command = linux
      ? join(__dirname, 'pdf-parser-guard')
      : process.execPath;
    const childArgs = linux
      ? [String(Math.ceil(timeoutMs / 1000) + 1), process.execPath, ...args]
      : args;
    return new Promise((resolve) => {
      const child = spawn(command, childArgs, {
        env: {},
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const buffers: Buffer[] = [];
      let size = 0,
        finished = false;
      const finish = (result: PdfParseResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ kind: 'terminal', failureCode: 'EXTRACTION_TIMEOUT' }),
        Math.max(1, timeoutMs),
      );
      child.on('error', () =>
        finish({ kind: 'retryable', failureCode: 'PDF_PARSER_UNAVAILABLE' }),
      );
      child.stdin.on('error', () => {
        /* Exit/error decides the sanitized outcome. */
      });
      child.stderr.resume(); // Never log parser diagnostics, which may contain PDF text.
      child.stdout.on('data', (buffer: Buffer) => {
        size += buffer.length;
        if (
          size >
          this.limits.maxTextBytes * 2 + this.limits.maxPages * 120 + 1024
        )
          finish({
            kind: 'terminal',
            failureCode: 'EXTRACTION_LIMIT_EXCEEDED',
          });
        else buffers.push(buffer);
      });
      child.on('close', (code) => {
        if (finished) return;
        if (code !== 0)
          return finish({
            kind: code === 125 ? 'retryable' : 'terminal',
            failureCode:
              code === 125
                ? 'PDF_PARSER_UNAVAILABLE'
                : 'PDF_PARSER_RESOURCE_FAILURE',
          });
        try {
          const value: unknown = JSON.parse(
            Buffer.concat(buffers).toString('utf8'),
          );
          if (!value || typeof value !== 'object') throw Error();
          const result = value as PdfParseResult;
          if (
            result.kind === 'terminal' &&
            [
              'PDF_ENCRYPTED',
              'PDF_MALFORMED',
              'OCR_REQUIRED',
              'EXTRACTION_LIMIT_EXCEEDED',
            ].includes(result.failureCode)
          )
            return finish(result);
          if (result.kind !== 'success') throw Error();
          const c = result.content;
          if (
            typeof c.text !== 'string' ||
            !c.text.trim() ||
            c.text.includes('\0') ||
            scalarCount(c.text) !== c.characterCount ||
            c.characterCount > this.limits.maxCharacters ||
            Buffer.byteLength(c.text) > this.limits.maxTextBytes ||
            !Number.isInteger(c.pageCount) ||
            c.pageCount < 1 ||
            c.pageCount > this.limits.maxPages ||
            !Array.isArray(c.pageSpans) ||
            c.pageSpans.length !== c.pageCount
          )
            throw Error();
          let previousEnd = 0;
          for (const [index, span] of c.pageSpans.entries()) {
            if (
              span.pageNumber !== index + 1 ||
              !Number.isInteger(span.startOffset) ||
              !Number.isInteger(span.endOffset) ||
              span.startOffset !== previousEnd + (index === 0 ? 0 : 2) ||
              span.endOffset < span.startOffset ||
              span.endOffset > c.characterCount
            )
              throw Error();
            previousEnd = span.endOffset;
          }
          if (previousEnd !== c.characterCount) throw Error();
          finish(result);
        } catch {
          finish({
            kind: 'retryable',
            failureCode: 'PDF_PARSER_PROTOCOL_ERROR',
          });
        }
      });
      child.stdin.end(bytes);
    });
  }
}

function scalarCount(value: string): number {
  let count = 0;
  for (const scalar of value) {
    void scalar;
    count++;
  }
  return count;
}
