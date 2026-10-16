import { Logger } from '@nestjs/common';
import type {
  ProcessingProgressStore,
  ProcessingStage,
} from '../progress/processing-progress';
import { PrismaClient, ProcessingRepository } from '@qyvra/database';
import type { Storage } from '@qyvra/storage';
import type { ApiConfiguration } from '../../configuration/settings';
import {
  commitPdfExtraction,
  preparePdfExtraction,
} from '../extraction/pdf-extraction';
import { PDF_EXTRACTOR, type PdfParser } from '../extraction/pdf-parser';
import type {
  HandlerResult,
  ProcessingJobHandler,
} from './processing-message-handler';

/** Search eligibility is independent of AI runs; parser and artifact commit are shared. */
export class SearchTextExtractionHandler implements ProcessingJobHandler {
  readonly jobType = 'EXTRACT_SEARCH_TEXT' as const;
  private readonly logger = new Logger(SearchTextExtractionHandler.name);
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: Storage,
    private readonly parser: PdfParser,
    private readonly limits: ApiConfiguration['extraction'],
    private readonly leaseMs = 120000,
    private readonly progress?: ProcessingProgressStore,
  ) {}
  private async report(
    input: Parameters<ProcessingJobHandler['execute']>[0],
    percent: number,
    stage: ProcessingStage,
  ) {
    try {
      await this.progress?.report(input.jobId, input.attempt, percent, stage);
    } catch {
      this.logger.warn(
        `Disposable search progress unavailable: job=${input.jobId}.`,
      );
    }
  }
  async execute(
    input: Parameters<ProcessingJobHandler['execute']>[0],
  ): Promise<HandlerResult> {
    const job = await this.db.processingJob.findUnique({
      where: { id: input.jobId },
      include: {
        version: true,
        predecessor: true,
        searchProjection: { include: { generation: true } },
      },
    });
    if (
      !job ||
      job.jobType !== this.jobType ||
      job.status !== 'PROCESSING' ||
      job.attempts !== input.attempt ||
      job.leaseToken !== input.leaseToken ||
      job.documentId !== input.documentId ||
      job.documentVersionId !== input.documentVersionId ||
      job.version.userId !== job.userId ||
      job.version.documentId !== job.documentId
    )
      return { kind: 'terminal', failureCode: 'EXTRACTION_SOURCE_INVALID' };
    const generation = job.searchProjection?.generation;
    if (
      !generation ||
      Object.entries(PDF_EXTRACTOR).some(
        ([k, v]) => generation[k as keyof typeof PDF_EXTRACTOR] !== v,
      )
    )
      return {
        kind: 'terminal',
        failureCode: 'EXTRACTOR_CONFIGURATION_UNSUPPORTED',
      };
    if (
      job.predecessor?.jobType !== 'VERIFY_STORED_FILE' ||
      job.predecessor.status !== 'COMPLETED' ||
      job.predecessor.userId !== job.userId ||
      job.predecessor.documentVersionId !== job.documentVersionId
    )
      return {
        kind: 'terminal',
        failureCode: 'EXTRACTION_PREREQUISITE_MISSING',
      };
    const repository = new ProcessingRepository(this.db);
    await repository.heartbeat(
      job.id,
      input.leaseToken,
      new Date(),
      this.leaseMs,
    );
    await this.report(input, 20, 'EXTRACTING');
    const prepared = await preparePdfExtraction(
      this.db,
      this.storage,
      this.parser,
      this.limits,
      job.version,
    );
    await repository.heartbeat(
      job.id,
      input.leaseToken,
      new Date(),
      this.leaseMs,
    );
    if (prepared.kind !== 'success') return prepared;
    await this.report(input, 99, 'FINALIZING');
    return {
      kind: 'success',
      commit: async (tx) => {
        const artifact = await commitPdfExtraction(tx, job.version, prepared);
        // Existing AI status remains independent; the search job owns this output.
        return { extractedTextId: artifact.id };
      },
    };
  }
}
