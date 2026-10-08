import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@qyvra/database';
import { Storage, StorageError, validateStorageKey } from '@qyvra/storage';
import type { ApiConfiguration } from '../../configuration/settings';
import {
  PDF_EXTRACTOR,
  PdfParser,
  CanonicalContent,
} from '../extraction/pdf-parser';
import type {
  HandlerResult,
  ProcessingJobHandler,
} from './processing-message-handler';
import type { ProcessingProgressStore } from '../progress/processing-progress';

@Injectable()
export class PdfTextExtractionHandler implements ProcessingJobHandler {
  readonly jobType = 'EXTRACT_TEXT' as const;
  private readonly logger = new Logger(PdfTextExtractionHandler.name);
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: Storage,
    private readonly parser: PdfParser,
    private readonly limits: ApiConfiguration['extraction'],
    private readonly progress?: ProcessingProgressStore,
  ) {}

  async execute(
    input: Parameters<ProcessingJobHandler['execute']>[0],
  ): Promise<HandlerResult> {
    const began = performance.now();
    const remaining = () =>
      this.limits.timeoutMs - Math.floor(performance.now() - began);
    const terminal = (failureCode: string): HandlerResult => {
      this.logger.warn(
        `PDF extraction stopped: job=${input.jobId} code=${failureCode}.`,
      );
      return { kind: 'terminal', failureCode };
    };
    const job = await this.db.processingJob.findUnique({
      where: { id: input.jobId },
      include: {
        document: true,
        version: { include: { aiState: true } },
        aiRun: true,
        predecessor: true,
      },
    });
    if (
      !job ||
      job.jobType !== this.jobType ||
      job.status !== 'PROCESSING' ||
      job.leaseToken !== input.leaseToken ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= new Date() ||
      job.attempts !== input.attempt ||
      job.documentId !== input.documentId ||
      job.documentVersionId !== input.documentVersionId ||
      job.document.userId !== job.userId ||
      job.version.userId !== job.userId ||
      job.version.documentId !== job.documentId
    )
      return terminal('EXTRACTION_SOURCE_INVALID');
    const run = job.aiRun;
    const latest = await this.db.documentVersion.findFirst({
      where: { documentId: job.documentId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
    if (
      job.document.deletedAt ||
      job.document.isArchived ||
      ['ARCHIVED', 'DELETING'].includes(job.document.status) ||
      latest?.id !== job.documentVersionId ||
      !run ||
      run.status !== 'BUILDING' ||
      job.version.aiState?.desiredRunId !== run.id
    )
      return terminal('DOCUMENT_INELIGIBLE');
    if (
      !job.predecessor ||
      job.predecessor.jobType !== 'VERIFY_STORED_FILE' ||
      job.predecessor.status !== 'COMPLETED' ||
      job.predecessor.documentVersionId !== job.documentVersionId ||
      job.predecessor.userId !== job.userId
    )
      return terminal('EXTRACTION_PREREQUISITE_MISSING');
    if (
      run.extractor !== PDF_EXTRACTOR.extractor ||
      run.extractorVersion !== PDF_EXTRACTOR.extractorVersion ||
      run.normalizationVersion !== PDF_EXTRACTOR.normalizationVersion
    )
      return terminal('EXTRACTOR_CONFIGURATION_UNSUPPORTED');
    const version = job.version;
    if (version.mimeType !== 'application/pdf')
      return terminal('UNSUPPORTED_FORMAT');
    if (
      !Number.isSafeInteger(version.fileSize) ||
      version.fileSize < 1 ||
      !/^[a-f0-9]{64}$/.test(version.checksumSha256)
    )
      return terminal('EXTRACTION_SOURCE_INVALID');
    if (version.fileSize > this.limits.maxBytes)
      return terminal('EXTRACTION_LIMIT_EXCEEDED');
    try {
      validateStorageKey(version.storageKey);
    } catch {
      return terminal('EXTRACTION_SOURCE_INVALID');
    }
    if (
      !version.storageKey.startsWith(
        `documents/${job.userId}/${job.documentId}/${job.documentVersionId}/original.`,
      )
    )
      return terminal('EXTRACTION_SOURCE_INVALID');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          'qyvra.extraction.v1',
          version.checksumSha256,
          PDF_EXTRACTOR.extractor,
          PDF_EXTRACTOR.extractorVersion,
          PDF_EXTRACTOR.normalizationVersion,
        ]),
      )
      .digest('hex');
    const existing = await this.db.extractedText.findUnique({
      where: {
        documentVersionId_extractionFingerprint: {
          documentVersionId: version.id,
          extractionFingerprint: fingerprint,
        },
      },
      select: {
        id: true,
        text: true,
        characterCount: true,
        pageCount: true,
        sourceChecksum: true,
        extractor: true,
        extractorVersion: true,
        normalizationVersion: true,
      },
    });
    if (
      existing &&
      (existing.sourceChecksum !== version.checksumSha256 ||
        existing.extractor !== PDF_EXTRACTOR.extractor ||
        existing.extractorVersion !== PDF_EXTRACTOR.extractorVersion ||
        existing.normalizationVersion !== PDF_EXTRACTOR.normalizationVersion)
    )
      return terminal('EXTRACTION_ARTIFACT_INVALID');
    if (existing && !existing.text.trim()) return terminal('OCR_REQUIRED');
    if (
      existing &&
      (existing.characterCount > this.limits.maxCharacters ||
        existing.pageCount > this.limits.maxPages ||
        Buffer.byteLength(existing.text) > this.limits.maxTextBytes)
    )
      return terminal('EXTRACTION_LIMIT_EXCEEDED');
    let content: CanonicalContent | undefined;
    if (!existing) {
      if (remaining() <= 0)
        return {
          kind: 'retryable',
          failureCode: 'EXTRACTION_PREPARATION_TIMEOUT',
        };
      let source: Awaited<ReturnType<Storage['open']>> | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        // The timeout also covers an adapter whose open promise never settles.
        let abandoned = false;
        const opening = this.storage.open(version.storageKey).then((stream) => {
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
          if (size > version.fileSize || size > this.limits.maxBytes)
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
          return { kind: 'retryable', failureCode: 'STORAGE_READ_FAILED' };
        const result = await this.parser
          .parse(bytes, remaining())
          .catch(() => ({
            kind: 'retryable' as const,
            failureCode: 'PDF_PARSER_UNAVAILABLE',
          }));
        if (result.kind !== 'success') return result;
        content = result.content;
      } catch (error) {
        if (error instanceof StorageError && error.code === 'NOT_FOUND')
          return terminal('FILE_NOT_FOUND');
        return { kind: 'retryable', failureCode: 'STORAGE_READ_FAILED' };
      } finally {
        clearTimeout(timer);
        source?.destroy();
      }
    }
    try {
      await this.progress?.report(input.jobId, input.attempt, 99, 'FINALIZING');
    } catch {
      this.logger.warn(
        `Disposable extraction progress unavailable: job=${input.jobId}.`,
      );
    }
    this.logger.log(
      `PDF extraction prepared: job=${input.jobId} version=${version.id} extractor=${PDF_EXTRACTOR.extractorVersion} pages=${content?.pageCount ?? 'reused'} characters=${content?.characterCount ?? 'reused'} durationMs=${Math.floor(performance.now() - began)} attempt=${input.attempt}.`,
    );
    return {
      kind: 'success',
      commit: async (tx, claimed) => {
        // ProcessingRepository owns the lease/lifecycle fence and transaction.
        const artifact =
          existing ??
          (await tx.extractedText.upsert({
            where: {
              documentVersionId_extractionFingerprint: {
                documentVersionId: version.id,
                extractionFingerprint: fingerprint,
              },
            },
            update: {},
            create: {
              userId: claimed.userId,
              documentId: claimed.documentId,
              documentVersionId: claimed.documentVersionId,
              extractionFingerprint: fingerprint,
              ...PDF_EXTRACTOR,
              sourceChecksum: version.checksumSha256,
              contentHash: createHash('sha256')
                .update(content!.text)
                .digest('hex'),
              ...content!,
              outcome: 'COMPLETED',
            },
            select: { id: true },
          }));
        await tx.documentVersion.update({
          where: { id: version.id },
          data: { extractionStatus: 'COMPLETED' },
        });
        return { extractedTextId: artifact.id };
      },
    };
  }
}
