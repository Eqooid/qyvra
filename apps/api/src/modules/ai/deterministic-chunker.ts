import { createHash } from 'node:crypto';
import { get_encoding } from 'tiktoken';
import type { SourcePageSpan } from '@qyvra/database';

export const CHUNK_STRATEGY = {
  chunkAlgorithm: 'qyvra-structural',
  chunkAlgorithmVersion: 'v1',
  tokenizer: 'cl100k_base',
  tokenizerVersion: 'tiktoken-1.0.22',
} as const;
// UUIDv5(DNS namespace, "qyvra.document-chunk.v1"); fixed permanently for this format.
export const CHUNK_NAMESPACE = '3cca8ba4-a5bd-560d-8e6e-a65cc2ebe1f8';
export const hashText = (text: string) =>
  createHash('sha256').update(text).digest('hex');
export class ChunkingError extends Error {
  constructor(readonly failureCode: string) {
    super(failureCode);
  }
}
export interface ChunkConfiguration {
  chunkSize: number;
  chunkOverlap: number;
}
export interface CanonicalChunk {
  id: string;
  ordinal: number;
  text: string;
  textHash: string;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
  pageSpans: SourcePageSpan[];
}
export function chunkFingerprint(
  extractionId: string,
  extractionHash: string,
  config: ChunkConfiguration,
): string {
  return hashText(
    JSON.stringify([
      'qyvra.chunk-set.v1',
      extractionId,
      extractionHash,
      CHUNK_STRATEGY.chunkAlgorithm,
      CHUNK_STRATEGY.chunkAlgorithmVersion,
      CHUNK_STRATEGY.tokenizer,
      CHUNK_STRATEGY.tokenizerVersion,
      config.chunkSize,
      config.chunkOverlap,
    ]),
  );
}
export function chunkId(
  versionId: string,
  fingerprint: string,
  ordinal: number,
  textHash: string,
): string {
  const namespace = Buffer.from(CHUNK_NAMESPACE.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1')
    .update(namespace)
    .update(
      JSON.stringify([
        'qyvra.chunk.v1',
        versionId,
        fingerprint,
        ordinal,
        textHash,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Pure local chunking: no database, broker, Redis, NestJS or provider calls. */
export class DeterministicChunker {
  constructor(
    private readonly maxChunks = 10000,
    private readonly maxOutputBytes = 40000000,
  ) {}
  async chunk(
    input: {
      versionId: string;
      extractionId: string;
      text: string;
      contentHash: string;
      characterCount: number;
      pageSpans: readonly SourcePageSpan[];
    },
    config: ChunkConfiguration,
    checkBudget: () => void = () => {},
  ): Promise<{ fingerprint: string; chunks: CanonicalChunk[] }> {
    if (
      !Number.isInteger(config.chunkSize) ||
      config.chunkSize < 1 ||
      config.chunkSize > 16384 ||
      !Number.isInteger(config.chunkOverlap) ||
      config.chunkOverlap < 0 ||
      config.chunkOverlap >= config.chunkSize
    )
      throw new ChunkingError('CHUNK_CONFIGURATION_INVALID');
    if (!input.text.trim()) throw new ChunkingError('CHUNK_SOURCE_NO_TEXT');
    if (
      !Number.isSafeInteger(input.characterCount) ||
      input.characterCount < 1 ||
      input.characterCount > 5000000 ||
      Buffer.byteLength(input.text) > 20000000 ||
      input.text.includes('\0') ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        input.text,
      ) ||
      hashText(input.text) !== input.contentHash
    )
      throw new ChunkingError('CHUNK_SOURCE_INVALID');
    const offsets = new Uint32Array(input.characterCount + 1);
    let scalar = 0,
      units = 0;
    for (const char of input.text) {
      if (scalar >= input.characterCount)
        throw new ChunkingError('CHUNK_SOURCE_INVALID');
      offsets[scalar++] = units;
      units += char.length;
    }
    if (scalar !== input.characterCount || scalar < 1)
      throw new ChunkingError('CHUNK_SOURCE_INVALID');
    offsets[scalar] = units;
    let previous = 0;
    if (!input.pageSpans.length || input.pageSpans.length > 10000)
      throw new ChunkingError('CHUNK_PROVENANCE_INVALID');
    for (const [index, page] of input.pageSpans.entries()) {
      if (
        page.pageNumber !== index + 1 ||
        !Number.isInteger(page.startOffset) ||
        !Number.isInteger(page.endOffset) ||
        page.startOffset < previous ||
        input.text
          .slice(offsets[previous], offsets[page.startOffset])
          .trim() !== '' ||
        page.endOffset < page.startOffset ||
        page.endOffset > scalar
      )
        throw new ChunkingError('CHUNK_PROVENANCE_INVALID');
      previous = page.endOffset;
    }
    if (input.pageSpans[0].startOffset !== 0 || previous !== scalar)
      throw new ChunkingError('CHUNK_PROVENANCE_INVALID');
    const slice = (start: number, end: number) =>
      input.text.slice(offsets[start], offsets[end]);
    let start = 0,
      documentEnd = scalar;
    while (start < documentEnd && !slice(start, start + 1).trim()) start++;
    while (documentEnd > start && !slice(documentEnd - 1, documentEnd).trim())
      documentEnd--;
    const fingerprint = chunkFingerprint(
      input.extractionId,
      input.contentHash,
      config,
    );
    const chunks: CanonicalChunk[] = [];
    const encoder = get_encoding('cl100k_base');
    const byteCache = new Map<number, number>();
    const encode = (text: string) => encoder.encode(text, [], []); // Special-token spellings are ordinary untrusted text.
    const tokenBytes = (id: number) => {
      let count = byteCache.get(id);
      if (count === undefined) {
        count = encoder.decode(new Uint32Array([id])).length;
        byteCache.set(id, count);
      }
      return count;
    };
    let lastEnd = start,
      outputBytes = 0;
    try {
      while (start < documentEnd) {
        checkBudget();
        // Bounded tokenizer windows avoid pathological full-document BPE work.
        const windowEnd = Math.min(
          documentEnd,
          start + Math.min(64000, config.chunkSize * 8),
        );
        const window = slice(start, windowEnd),
          ids = encode(window);
        const byteToScalar = new Map<number, number>([[0, start]]);
        let byteOffset = 0;
        for (let at = start; at < windowEnd; at++) {
          byteOffset += Buffer.byteLength(slice(at, at + 1));
          byteToScalar.set(byteOffset, at + 1);
        }
        let end = windowEnd;
        if (ids.length > config.chunkSize) {
          end = start;
          byteOffset = 0;
          for (let at = 0; at < config.chunkSize; at++) {
            byteOffset += tokenBytes(ids[at]);
            end = byteToScalar.get(byteOffset) ?? end;
          }
        }
        if (end <= lastEnd && start < lastEnd) {
          start = lastEnd;
          continue;
        }
        if (end <= start)
          throw new ChunkingError('CHUNK_TOKEN_BUDGET_TOO_SMALL');
        // Prefer the latest meaningful boundary within the latter half of the window.
        if (end < documentEnd) {
          const fragment = slice(start, end);
          const floor = Math.max(
            lastEnd + 1,
            start + Math.floor((end - start) / 2),
          );
          for (const expression of [
            /\n\n+/g,
            /\n/g,
            /[.!?。！？](?:\s+|$)/gu,
            /\s+/gu,
          ]) {
            let chosen = 0;
            for (const match of fragment.matchAll(expression)) {
              const utf16End = offsets[start] + match.index! + match[0].length;
              // Offset table binary search, never a full-source re-count per candidate.
              let low = start,
                high = end;
              while (low < high) {
                const mid = (low + high) >>> 1;
                if (offsets[mid] < utf16End) low = mid + 1;
                else high = mid;
              }
              if (low >= floor && offsets[low] === utf16End) chosen = low;
            }
            if (chosen) {
              end = chosen;
              break;
            }
          }
        }
        let text = slice(start, end),
          tokens = encode(text);
        // Standalone prefixes can tokenize differently; verify the actual persisted text.
        while (tokens.length > config.chunkSize && end > start) {
          end--;
          text = slice(start, end);
          tokens = encode(text);
        }
        if (end <= start || end <= lastEnd)
          throw new ChunkingError('CHUNK_TOKEN_BUDGET_TOO_SMALL');
        if (!text.trim()) {
          start = end;
          lastEnd = end;
          continue;
        }
        let low = 0,
          high = input.pageSpans.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (input.pageSpans[mid].endOffset <= start) low = mid + 1;
          else high = mid;
        }
        const pageSpans: SourcePageSpan[] = [];
        for (
          let index = low;
          index < input.pageSpans.length &&
          input.pageSpans[index].startOffset < end;
          index++
        ) {
          const p = input.pageSpans[index];
          pageSpans.push({
            pageNumber: p.pageNumber,
            startOffset: Math.max(start, p.startOffset),
            endOffset: Math.min(end, p.endOffset),
          });
        }
        if (!pageSpans.length)
          throw new ChunkingError('CHUNK_PROVENANCE_INVALID');
        if (chunks.length >= this.maxChunks)
          throw new ChunkingError('CHUNK_LIMIT_EXCEEDED');
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > this.maxOutputBytes)
          throw new ChunkingError('CHUNK_LIMIT_EXCEEDED');
        const textHash = hashText(text),
          ordinal = chunks.length;
        chunks.push({
          id: chunkId(input.versionId, fingerprint, ordinal, textHash),
          ordinal,
          text,
          textHash,
          startOffset: start,
          endOffset: end,
          tokenCount: tokens.length,
          pageSpans,
        });
        lastEnd = end;
        if (end === documentEnd) break;
        let next = end;
        if (config.chunkOverlap) {
          const localBytes = new Map<number, number>([[0, start]]);
          let bytes = 0;
          for (let at = start; at < end; at++) {
            bytes += Buffer.byteLength(slice(at, at + 1));
            localBytes.set(bytes, at + 1);
          }
          let prefixBytes = 0;
          for (let index = 0; index < tokens.length; index++) {
            const candidate = localBytes.get(prefixBytes);
            if (
              tokens.length - index <= config.chunkOverlap &&
              candidate !== undefined &&
              candidate > start &&
              encode(slice(candidate, end)).length <= config.chunkOverlap
            ) {
              next = candidate;
              break;
            }
            prefixBytes += tokenBytes(tokens[index]);
          }
          // Shorten overlap to a word boundary; never expand its token budget.
          while (
            next < end &&
            next > start &&
            !/\s/u.test(slice(next - 1, next)) &&
            !/\s/u.test(slice(next, next + 1))
          )
            next++;
          while (
            next < end &&
            encode(slice(next, end)).length > config.chunkOverlap
          )
            next++;
        }
        start = next;
        // Cooperatively release the worker event loop for leases, shutdown and progress.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      checkBudget();
      if (!chunks.length) throw new ChunkingError('CHUNK_SOURCE_NO_TEXT');
      return { fingerprint, chunks };
    } finally {
      encoder.free();
    }
  }
}
