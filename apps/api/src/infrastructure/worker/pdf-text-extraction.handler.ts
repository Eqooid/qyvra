import {
  preparePdfExtraction,
  commitPdfExtraction,
} from '../extraction/pdf-extraction';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@qyvra/database';
import { Storage } from '@qyvra/storage';
import type { ApiConfiguration } from '../../configuration/settings';
import { PDF_EXTRACTOR, PdfParser } from '../extraction/pdf-parser';
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
    const prepared = await preparePdfExtraction(
      this.db,
      this.storage,
      this.parser,
      this.limits,
      version,
    );
    if (prepared.kind !== 'success') return prepared;
    const { content } = prepared;
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
      commit: async (tx) => {
        // ProcessingRepository owns the lease/lifecycle fence and transaction.
        const artifact = await commitPdfExtraction(tx, version, prepared);
        await tx.documentVersion.update({
          where: { id: version.id },
          data: { extractionStatus: 'COMPLETED' },
        });
        return { extractedTextId: artifact.id };
      },
    };
  }
}
