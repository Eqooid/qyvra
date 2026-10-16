import { createHash } from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
  type ExtractedText,
  type DocumentVersion,
} from '@qyvra/database';
import { Storage, StorageError, validateStorageKey } from '@qyvra/storage';
import type { ApiConfiguration } from '../../configuration/settings';
import {
  PDF_EXTRACTOR,
  type PdfParser,
  type CanonicalContent,
} from './pdf-parser';

function scalarCount(text: string): number {
  let count = 0;
  for (const scalar of text) {
    void scalar;
    count++;
  }
  return count;
}
export function extractionFingerprint(checksum: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'qyvra.extraction.v1',
        checksum,
        PDF_EXTRACTOR.extractor,
        PDF_EXTRACTOR.extractorVersion,
        PDF_EXTRACTOR.normalizationVersion,
      ]),
    )
    .digest('hex');
}
export type PreparedPdfResult =
  | { kind: 'terminal' | 'retryable'; failureCode: string }
  | {
      kind: 'success';
      fingerprint: string;
      existing: ExtractedText | null;
      content: CanonicalContent | undefined;
    };
export async function preparePdfExtraction(
  db: PrismaClient,
  storage: Storage,
  parser: PdfParser,
  limits: ApiConfiguration['extraction'],
  version: DocumentVersion,
): Promise<PreparedPdfResult> {
  const began = performance.now();
  const remaining = () =>
    limits.timeoutMs - Math.floor(performance.now() - began);
  const terminal = (failureCode: string) => ({
    kind: 'terminal' as const,
    failureCode,
  });
  if (version.mimeType !== 'application/pdf')
    return terminal('UNSUPPORTED_FORMAT');
  if (
    !Number.isSafeInteger(version.fileSize) ||
    version.fileSize < 1 ||
    !/^[a-f0-9]{64}$/.test(version.checksumSha256)
  )
    return terminal('EXTRACTION_SOURCE_INVALID');
  if (version.fileSize > limits.maxBytes)
    return terminal('EXTRACTION_LIMIT_EXCEEDED');
  try {
    validateStorageKey(version.storageKey);
  } catch {
    return terminal('EXTRACTION_SOURCE_INVALID');
  }
  if (
    !version.storageKey.startsWith(
      `documents/${version.userId}/${version.documentId}/${version.id}/original.`,
    )
  )
    return terminal('EXTRACTION_SOURCE_INVALID');
  const fingerprint = extractionFingerprint(version.checksumSha256);
  const existing = await db.extractedText.findUnique({
    where: {
      documentVersionId_extractionFingerprint: {
        documentVersionId: version.id,
        extractionFingerprint: fingerprint,
      },
    },
  });
  if (
    existing &&
    (existing.userId !== version.userId ||
      existing.documentId !== version.documentId ||
      existing.sourceChecksum !== version.checksumSha256 ||
      existing.extractor !== PDF_EXTRACTOR.extractor ||
      existing.extractorVersion !== PDF_EXTRACTOR.extractorVersion ||
      existing.normalizationVersion !== PDF_EXTRACTOR.normalizationVersion)
  )
    return terminal('EXTRACTION_ARTIFACT_INVALID');
  if (existing && !existing.text.trim()) return terminal('OCR_REQUIRED');
  if (
    existing &&
    (existing.characterCount > limits.maxCharacters ||
      existing.pageCount > limits.maxPages ||
      Buffer.byteLength(existing.text) > limits.maxTextBytes)
  )
    return terminal('EXTRACTION_LIMIT_EXCEEDED');
  if (
    existing &&
    (createHash('sha256').update(existing.text).digest('hex') !==
      existing.contentHash ||
      scalarCount(existing.text) !== existing.characterCount)
  )
    return terminal('EXTRACTION_ARTIFACT_INVALID');
  let content: CanonicalContent | undefined;
  if (!existing) {
    if (remaining() <= 0)
      return {
        kind: 'retryable' as const,
        failureCode: 'EXTRACTION_PREPARATION_TIMEOUT',
      };
    let source: Awaited<ReturnType<Storage['open']>> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      // The timeout also covers an adapter whose open promise never settles.
      let abandoned = false;
      const opening = storage.open(version.storageKey).then((stream) => {
        if (abandoned) stream.destroy();
        return stream;
      });
      source = await Promise.race([
        opening,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              abandoned = true;
              reject(new StorageError('READ_FAILED'));
            },
            Math.max(1, remaining()),
          );
        }),
      ]);
      clearTimeout(timer);
      const stream = source;
      timer = setTimeout(
        () => stream.destroy(new StorageError('READ_FAILED')),
        Math.max(1, remaining()),
      );
      const buffers: Buffer[] = [];
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > version.fileSize || size > limits.maxBytes)
          return terminal('FILE_SIZE_MISMATCH');
        hash.update(bytes);
        buffers.push(bytes);
      }
      clearTimeout(timer);
      if (size !== version.fileSize) return terminal('FILE_SIZE_MISMATCH');
      if (hash.digest('hex') !== version.checksumSha256)
        return terminal('FILE_CHECKSUM_MISMATCH');
      const bytes = Buffer.concat(buffers);
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
        return terminal('PDF_MALFORMED');
      if (remaining() <= 0)
        return {
          kind: 'retryable' as const,
          failureCode: 'STORAGE_READ_FAILED',
        };
      const result = await parser.parse(bytes, remaining()).catch(() => ({
        kind: 'retryable' as const,
        failureCode: 'PDF_PARSER_UNAVAILABLE',
      }));
      if (result.kind !== 'success') return result;
      content = result.content;
    } catch (error) {
      if (error instanceof StorageError && error.code === 'NOT_FOUND')
        return terminal('FILE_NOT_FOUND');
      return { kind: 'retryable' as const, failureCode: 'STORAGE_READ_FAILED' };
    } finally {
      clearTimeout(timer);
      source?.destroy();
    }
  }

  return { kind: 'success' as const, fingerprint, existing, content };
}
export async function commitPdfExtraction(
  tx: Prisma.TransactionClient,
  version: DocumentVersion,
  prepared: Extract<PreparedPdfResult, { kind: 'success' }>,
): Promise<ExtractedText> {
  const { existing, content, fingerprint } = prepared;
  if (existing) return existing;
  if (!content) throw new Error('EXTRACTION_ARTIFACT_INVALID');
  const contentHash = createHash('sha256').update(content.text).digest('hex');
  // Native ON CONFLICT semantics converge with concurrent AI/search extraction.
  await tx.extractedText.createMany({
    data: [
      {
        userId: version.userId,
        documentId: version.documentId,
        documentVersionId: version.id,
        extractionFingerprint: fingerprint,
        ...PDF_EXTRACTOR,
        sourceChecksum: version.checksumSha256,
        contentHash,
        ...content,
        outcome: 'COMPLETED',
      },
    ],
    skipDuplicates: true,
  });
  const artifact = await tx.extractedText.findUniqueOrThrow({
    where: {
      documentVersionId_extractionFingerprint: {
        documentVersionId: version.id,
        extractionFingerprint: fingerprint,
      },
    },
  });
  if (
    artifact.contentHash !== contentHash ||
    artifact.text !== content.text ||
    artifact.characterCount !== content.characterCount ||
    artifact.pageCount !== content.pageCount ||
    canonicalJson(artifact.pageSpans) !== canonicalJson(content.pageSpans)
  )
    throw new Error('EXTRACTION_ARTIFACT_INVALID');
  return artifact;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => JSON.stringify(key) + ':' + canonicalJson(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
