import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@brainless/database';
import { Storage, StorageError, validateStorageKey } from '@brainless/storage';
import type {
  HandlerResult,
  ProcessingJobHandler,
} from './processing-message-handler';
import {
  ProcessingProgressStore,
  ProcessingStage,
} from '../progress/processing-progress';

/** Verifies immutable upload metadata against a fresh, streamed storage read. */
@Injectable()
export class StoredFileIntegrityHandler implements ProcessingJobHandler {
  readonly jobType = 'VERIFY_STORED_FILE' as const;
  private readonly logger = new Logger(StoredFileIntegrityHandler.name);

  constructor(
    private readonly db: PrismaClient,
    private readonly storage: Storage,
    private readonly maxReadMs: number,
    private readonly progress?: ProcessingProgressStore,
  ) {}

  async execute(input: {
    readonly jobId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly leaseToken: string;
    readonly attempt: number;
  }): Promise<HandlerResult> {
    const job = await this.db.processingJob.findUnique({
      where: { id: input.jobId },
      select: {
        documentId: true,
        documentVersionId: true,
        userId: true,
        jobType: true,
        status: true,
        leaseToken: true,
        attempts: true,
        document: {
          select: {
            userId: true,
            deletedAt: true,
            isArchived: true,
            status: true,
          },
        },
        version: {
          select: {
            documentId: true,
            userId: true,
            storageKey: true,
            fileSize: true,
            checksumSha256: true,
          },
        },
      },
    });
    if (!job) return this.terminal(input.jobId, 'INTEGRITY_SOURCE_MISSING');
    if (
      job.documentId !== input.documentId ||
      job.documentVersionId !== input.documentVersionId ||
      job.jobType !== this.jobType ||
      job.status !== 'PROCESSING' ||
      job.leaseToken !== input.leaseToken ||
      job.attempts !== input.attempt ||
      job.document.userId !== job.userId ||
      job.version.userId !== job.userId ||
      job.version.documentId !== job.documentId
    )
      return this.terminal(input.jobId, 'INTEGRITY_SOURCE_INVALID');
    // Never open private bytes after the parent document becomes ineligible.
    if (
      job.document.deletedAt ||
      job.document.isArchived ||
      ['ARCHIVED', 'DELETING'].includes(job.document.status)
    )
      return this.terminal(input.jobId, 'DOCUMENT_INELIGIBLE');

    const { storageKey, fileSize, checksumSha256 } = job.version;
    if (
      !Number.isSafeInteger(fileSize) ||
      fileSize <= 0 ||
      !/^[a-f0-9]{64}$/.test(checksumSha256)
    )
      return this.terminal(input.jobId, 'INTEGRITY_METADATA_INVALID');
    try {
      validateStorageKey(storageKey);
    } catch {
      return this.terminal(input.jobId, 'INTEGRITY_METADATA_INVALID');
    }
    if (
      !storageKey.startsWith(
        `documents/${job.userId}/${job.documentId}/${job.documentVersionId}/original.`,
      )
    )
      return this.terminal(input.jobId, 'INTEGRITY_METADATA_INVALID');

    let progressWarning = false;
    const report = async (percent: number, stage: ProcessingStage) => {
      try {
        await this.progress?.report(input.jobId, input.attempt, percent, stage);
      } catch {
        if (!progressWarning) {
          progressWarning = true;
          this.logger.warn(
            `Disposable progress write failed: job=${input.jobId}.`,
          );
        }
      }
    };
    await report(0, 'PREPARING');

    let source: Awaited<ReturnType<Storage['open']>>;
    try {
      source = await this.storage.open(storageKey);
    } catch (error) {
      return this.storageFailure(input.jobId, error);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      source.destroy(new StorageError('READ_FAILED'));
    }, this.maxReadMs);
    timer.unref();
    try {
      const digest = createHash('sha256');
      let observedSize = 0;
      let lastPercent = 0;
      let lastProgressAt = Date.now();
      for await (const chunk of source) {
        const bytes: Buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array);
        observedSize += bytes.length;
        if (observedSize > fileSize)
          return this.terminal(input.jobId, 'FILE_SIZE_MISMATCH');
        digest.update(bytes);
        const percent = Math.min(
          95,
          Math.floor((observedSize / fileSize) * 95),
        );
        const now = Date.now();
        if (percent >= lastPercent + 5 || now - lastProgressAt >= 1000) {
          await report(percent, 'READING');
          lastPercent = percent;
          lastProgressAt = now;
        }
      }
      if (observedSize !== fileSize)
        return this.terminal(input.jobId, 'FILE_SIZE_MISMATCH');
      await report(98, 'VERIFYING');
      const observedDigest = digest.digest();
      if (!timingSafeEqual(observedDigest, Buffer.from(checksumSha256, 'hex')))
        return this.terminal(input.jobId, 'FILE_CHECKSUM_MISMATCH');
      await report(99, 'FINALIZING');
      this.logger.log(`Stored-file integrity verified: job=${input.jobId}.`);
      return { kind: 'success' };
    } catch (error) {
      return this.storageFailure(input.jobId, error);
    } finally {
      clearTimeout(timer);
      source.destroy();
      if (timedOut)
        this.logger.warn(
          `Stored-file integrity read timed out: job=${input.jobId}.`,
        );
    }
  }

  private terminal(jobId: string, failureCode: string): HandlerResult {
    this.logger.warn(
      `Stored-file integrity failed: job=${jobId} code=${failureCode}.`,
    );
    return { kind: 'terminal', failureCode };
  }

  private storageFailure(jobId: string, error: unknown): HandlerResult {
    if (error instanceof StorageError && error.code === 'NOT_FOUND')
      return this.terminal(jobId, 'FILE_NOT_FOUND');
    if (error instanceof StorageError && error.code === 'INVALID_KEY')
      return this.terminal(jobId, 'INTEGRITY_METADATA_INVALID');
    this.logger.warn(`Stored-file integrity read failed: job=${jobId}.`);
    return { kind: 'retryable', failureCode: 'STORAGE_READ_FAILED' };
  }
}
