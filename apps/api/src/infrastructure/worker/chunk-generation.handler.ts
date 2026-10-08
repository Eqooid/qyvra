import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient, type SourcePageSpan } from '@qyvra/database';
import type { ApiConfiguration } from '../../configuration/settings';
import {
  CHUNK_STRATEGY,
  ChunkingError,
  DeterministicChunker,
} from '../../modules/ai/deterministic-chunker';
import type {
  HandlerResult,
  ProcessingJobHandler,
} from './processing-message-handler';
import type { ProcessingProgressStore } from '../progress/processing-progress';

function sourcePages(value: unknown): SourcePageSpan[] {
  if (!Array.isArray(value))
    throw new ChunkingError('CHUNK_PROVENANCE_INVALID');
  return value.map((page: unknown) => {
    if (
      !page ||
      typeof page !== 'object' ||
      !('pageNumber' in page) ||
      !('startOffset' in page) ||
      !('endOffset' in page) ||
      typeof page.pageNumber !== 'number' ||
      typeof page.startOffset !== 'number' ||
      typeof page.endOffset !== 'number' ||
      Object.keys(page).length !== 3
    )
      throw new ChunkingError('CHUNK_PROVENANCE_INVALID');
    return {
      pageNumber: page.pageNumber,
      startOffset: page.startOffset,
      endOffset: page.endOffset,
    };
  });
}

@Injectable()
export class ChunkGenerationHandler implements ProcessingJobHandler {
  readonly jobType = 'GENERATE_CHUNKS' as const;
  private readonly logger = new Logger(ChunkGenerationHandler.name);
  constructor(
    private readonly db: PrismaClient,
    private readonly chunker: DeterministicChunker,
    private readonly limits: ApiConfiguration['chunking'],
    private readonly progress?: ProcessingProgressStore,
  ) {}

  async execute(
    input: Parameters<ProcessingJobHandler['execute']>[0],
  ): Promise<HandlerResult> {
    const began = performance.now();
    const terminal = (failureCode: string): HandlerResult => {
      this.logger.warn(
        `Chunk generation stopped: job=${input.jobId} code=${failureCode}.`,
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
        extraction: true,
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
      return terminal('CHUNK_SOURCE_INVALID');
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
      job.predecessor.jobType !== 'EXTRACT_TEXT' ||
      job.predecessor.status !== 'COMPLETED' ||
      job.predecessor.aiRunId !== run.id ||
      job.predecessor.userId !== job.userId ||
      job.predecessor.documentVersionId !== job.documentVersionId ||
      !job.extractedTextId ||
      job.predecessor.extractedTextId !== job.extractedTextId
    )
      return terminal('CHUNK_PREREQUISITE_MISSING');
    if (
      Object.entries(CHUNK_STRATEGY).some(
        ([key, value]) => run[key as keyof typeof CHUNK_STRATEGY] !== value,
      )
    )
      return terminal('CHUNK_CONFIGURATION_UNSUPPORTED');
    const extraction = job.extraction;
    if (
      !extraction ||
      extraction.outcome !== 'COMPLETED' ||
      extraction.userId !== job.userId ||
      extraction.documentId !== job.documentId ||
      extraction.documentVersionId !== job.documentVersionId ||
      extraction.sourceChecksum !== job.version.checksumSha256 ||
      extraction.extractor !== run.extractor ||
      extraction.extractorVersion !== run.extractorVersion ||
      extraction.normalizationVersion !== run.normalizationVersion
    )
      return terminal('CHUNK_SOURCE_INVALID');
    let result: Awaited<ReturnType<DeterministicChunker['chunk']>>;
    try {
      const pages = sourcePages(extraction.pageSpans);
      if (pages.length !== extraction.pageCount)
        throw new ChunkingError('CHUNK_PROVENANCE_INVALID');
      result = await this.chunker.chunk(
        {
          versionId: job.documentVersionId,
          extractionId: extraction.id,
          text: extraction.text,
          contentHash: extraction.contentHash,
          characterCount: extraction.characterCount,
          pageSpans: pages,
        },
        run,
        () => {
          if (performance.now() - began >= this.limits.timeoutMs)
            throw new ChunkingError('CHUNK_TIMEOUT');
        },
      );
    } catch (error) {
      if (!(error instanceof ChunkingError)) throw error;
      if (error.failureCode === 'CHUNK_TIMEOUT')
        return { kind: 'retryable', failureCode: error.failureCode };
      return terminal(error.failureCode);
    }
    const identity = {
      documentVersionId: job.documentVersionId,
      fingerprint: result.fingerprint,
    };
    const existing = await this.db.chunkSet.findUnique({
      where: { documentVersionId_fingerprint: identity },
      include: { chunks: { orderBy: { ordinal: 'asc' } } },
    });
    const validExisting = (set: NonNullable<typeof existing>) =>
      set.complete &&
      set.extractedTextId === extraction.id &&
      set.extractionHash === extraction.contentHash &&
      set.userId === job.userId &&
      set.documentId === job.documentId &&
      set.chunkSize === run.chunkSize &&
      set.chunkOverlap === run.chunkOverlap &&
      set.algorithm === CHUNK_STRATEGY.chunkAlgorithm &&
      set.algorithmVersion === CHUNK_STRATEGY.chunkAlgorithmVersion &&
      set.tokenizer === CHUNK_STRATEGY.tokenizer &&
      set.tokenizerVersion === CHUNK_STRATEGY.tokenizerVersion &&
      set.chunkCount === result.chunks.length &&
      set.chunks.length === result.chunks.length &&
      set.chunks.every((chunk, index) => {
        const expected = result.chunks[index];
        return (
          chunk.id === expected.id &&
          chunk.ordinal === expected.ordinal &&
          chunk.text === expected.text &&
          chunk.textHash === expected.textHash &&
          chunk.startOffset === expected.startOffset &&
          chunk.endOffset === expected.endOffset &&
          chunk.tokenCount === expected.tokenCount &&
          JSON.stringify(sourcePages(chunk.pageSpans)) ===
            JSON.stringify(expected.pageSpans)
        );
      });
    if (existing && !validExisting(existing))
      return terminal('CHUNK_ARTIFACT_INVALID');
    if (!existing) {
      // Fail closed on an unexpected UUID collision; never overwrite another set.
      for (let index = 0; index < result.chunks.length; index += 500) {
        if (
          await this.db.documentChunk.count({
            where: {
              id: {
                in: result.chunks
                  .slice(index, index + 500)
                  .map((chunk) => chunk.id),
              },
            },
          })
        )
          return terminal('CHUNK_ID_COLLISION');
      }
    }
    try {
      await this.progress?.report(input.jobId, input.attempt, 99, 'FINALIZING');
    } catch {
      this.logger.warn(
        `Disposable chunk progress unavailable: job=${input.jobId}.`,
      );
    }
    this.logger.log(
      `Chunks prepared: job=${input.jobId} document=${job.documentId} version=${job.documentVersionId} strategy=${run.chunkAlgorithm}/${run.chunkAlgorithmVersion} size=${run.chunkSize} overlap=${run.chunkOverlap} characters=${extraction.characterCount} chunks=${result.chunks.length} durationMs=${Math.floor(performance.now() - began)} attempt=${input.attempt}.`,
    );
    return {
      kind: 'success',
      commit: async (tx, claimed) => {
        // Repository rechecks desired generation, ownership, lifecycle and lease under the document lock.
        const reused = await tx.chunkSet.findUnique({
          where: { documentVersionId_fingerprint: identity },
          include: { chunks: { orderBy: { ordinal: 'asc' } } },
        });
        if (reused) {
          if (!validExisting(reused))
            throw new ChunkingError('CHUNK_ARTIFACT_INVALID');
          return { chunkSetId: reused.id };
        }
        const set = await tx.chunkSet.create({
          data: {
            ...identity,
            userId: claimed.userId,
            documentId: claimed.documentId,
            extractedTextId: extraction.id,
            extractionHash: extraction.contentHash,
            algorithm: CHUNK_STRATEGY.chunkAlgorithm,
            algorithmVersion: CHUNK_STRATEGY.chunkAlgorithmVersion,
            tokenizer: CHUNK_STRATEGY.tokenizer,
            tokenizerVersion: CHUNK_STRATEGY.tokenizerVersion,
            chunkSize: run.chunkSize,
            chunkOverlap: run.chunkOverlap,
          },
        });
        for (let index = 0; index < result.chunks.length; index++) {
          await tx.documentChunk.createMany({
            data: result.chunks.slice(index, index + 1).map((chunk) => ({
              ...chunk,
              pageSpans: chunk.pageSpans.map((page) => ({ ...page })),
              chunkSetId: set.id,
              userId: claimed.userId,
              documentId: claimed.documentId,
              documentVersionId: claimed.documentVersionId,
            })),
          });
        }
        await tx.chunkSet.update({
          where: { id: set.id },
          data: { chunkCount: result.chunks.length, complete: true },
        });
        return { chunkSetId: set.id };
      },
    };
  }
}
