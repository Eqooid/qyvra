import { canonicalJson } from '../extraction/pdf-extraction';
import { Logger } from '@nestjs/common';
import type {
  ProcessingProgressStore,
  ProcessingStage,
} from '../progress/processing-progress';
import {
  PrismaClient,
  ProcessingError,
  ProcessingRepository,
} from '@qyvra/database';
import type { ApiConfiguration } from '../../configuration/settings';
import type { CanonicalContent } from '../extraction/pdf-parser';
import {
  lexicalBatches,
  lexicalManifest,
  lexicalRecords,
} from '../search/lexical-projection';
import { targetFromGeneration, recordValid } from '../search/search-index';
import { SearchStoreFailure, type LexicalStore } from '../search/lexical-store';
import type {
  HandlerResult,
  ProcessingJobHandler,
} from './processing-message-handler';

/** Immutable external writes become visible only through the fenced SQL ready pointer. */
export class SearchIndexHandler implements ProcessingJobHandler {
  readonly jobType = 'INDEX_SEARCH' as const;
  private readonly logger = new Logger(SearchIndexHandler.name);
  constructor(
    private readonly db: PrismaClient,
    private readonly store: LexicalStore,
    private readonly settings: ApiConfiguration['elasticsearch'],
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
    const repository = new ProcessingRepository(this.db);
    const deadline = AbortSignal.timeout(Math.min(this.leaseMs, 600000));
    try {
      const job = await this.db.processingJob.findUnique({
        where: { id: input.jobId },
        include: {
          version: true,
          document: { include: { tags: true } },
          searchProjection: { include: { generation: true, extraction: true } },
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
        job.document.userId !== job.userId ||
        job.version.userId !== job.userId
      )
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      const p = job.searchProjection;
      if (!p || p.status !== 'BUILDING')
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      const target = targetFromGeneration(
        this.settings.indexPrefix,
        p.generation,
      );
      const artifact = p.extraction;
      const records = lexicalRecords(
        p,
        job.document,
        job.version,
        job.document.tags.map((t) => t.tagId),
        artifact
          ? {
              ...artifact,
              pageSpans:
                artifact.pageSpans as unknown as CanonicalContent['pageSpans'],
            }
          : undefined,
      );
      records.forEach((r) => recordValid(r, target));
      const manifest = lexicalManifest(records);
      await this.report(input, 15, 'PREPARING');
      const coverage = artifact
        ? 'READY'
        : p.textCoverage === 'NOT_REQUESTED'
          ? job.version.mimeType === 'application/pdf'
            ? 'PENDING'
            : 'UNSUPPORTED'
          : p.textCoverage;
      // Persist exact cleanup intent BEFORE any external writes. No remote IO in this callback.
      await repository.checkpoint(
        job.id,
        input.leaseToken,
        new Date(),
        async (tx) => {
          await tx.versionSearchProjection.update({
            where: { id: p.id },
            data: { ...manifest, textCoverage: coverage },
          });
          return {};
        },
      );
      const heartbeat = () =>
        repository.heartbeat(
          job.id,
          input.leaseToken,
          new Date(),
          this.leaseMs,
        );
      await heartbeat();
      await this.store.createIndexes(target, deadline);
      await this.report(input, 40, 'INDEXING');
      for (const batch of lexicalBatches(
        records,
        target,
        this.settings.indexPrefix,
        this.settings.bulkSize,
        this.settings.maxRequestBytes,
      )) {
        await heartbeat();
        await this.store.upsert(target, batch, deadline);
      }
      await heartbeat();
      await this.report(input, 85, 'VERIFYING');
      await this.store.verifyPublication(
        target,
        job.userId,
        {
          documentId: p.documentId,
          documentVersionId: p.documentVersionId,
          projectionId: p.id,
          revision: p.revision,
        },
        records,
        deadline,
      );
      await heartbeat();
      await this.report(input, 99, 'FINALIZING');
      return {
        kind: 'success',
        commit: async (tx) => {
          const current = await tx.versionSearchProjection.findUniqueOrThrow({
            where: { id: p.id },
          });
          if (
            current.recordsHash !== manifest.recordsHash ||
            current.expectedRecordCount !== records.length ||
            canonicalJson(current.expectedRecordIds) !==
              canonicalJson(manifest.expectedRecordIds) ||
            current.extractedTextId !== p.extractedTextId ||
            current.textCoverage !== coverage
          )
            throw new ProcessingError('CONCURRENT_CHANGE');
          // Serialize the final generation fence with status changes. Remote IO is already finished.
          await tx.$queryRaw`SELECT id FROM search_index_generations WHERE id=${p.indexGenerationId}::uuid FOR SHARE`;
          const generation = await tx.searchIndexGeneration.findUniqueOrThrow({
            where: { id: p.indexGenerationId },
          });
          if (generation.status === 'RETIRED')
            throw new ProcessingError('INELIGIBLE_DOCUMENT');
          await tx.versionSearchProjection.update({
            where: { id: p.id },
            data: {
              status: 'READY',
              metadataReady: true,
              verifiedAt: new Date(),
            },
          });
          if (generation.status === 'SERVING')
            await tx.documentSearchState.update({
              where: { documentId: job.documentId },
              data: { readyProjectionId: p.id },
            });
          return {};
        },
      };
    } catch (error) {
      if (error instanceof ProcessingError) throw error;
      if (error instanceof SearchStoreFailure)
        return {
          kind: error.retryable ? 'retryable' : 'terminal',
          failureCode: error.code,
        };
      throw error;
    }
  }
}
