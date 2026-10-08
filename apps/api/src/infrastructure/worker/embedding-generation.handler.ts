import { Logger } from '@nestjs/common';
import {
  ProcessingError,
  ProcessingRepository,
  Prisma,
  embeddingProfileFingerprint,
  type PrismaClient,
  type EmbeddingProfileIdentity,
} from '@qyvra/database';
import type { ApiConfiguration } from '../../configuration/settings';
import {
  EmbeddingFailure,
  embeddingText,
  embeddingInputHash,
  validVector,
  validateEmbeddingResults,
  type EmbeddingProvider,
  type EmbeddingInput,
  type EmbeddingResult,
} from '../../modules/ai/embedding-provider';
import type { ProcessingProgressStore } from '../progress/processing-progress';
import type {
  HandlerResult,
  ProcessingJobHandler,
} from './processing-message-handler';

/** Checkpoint batches independently; final completion/outbox remain owned by the router. */
export class EmbeddingGenerationHandler implements ProcessingJobHandler {
  readonly jobType = 'GENERATE_EMBEDDINGS' as const;
  private readonly logger = new Logger(EmbeddingGenerationHandler.name);
  private readonly repository: ProcessingRepository;
  constructor(
    private readonly db: PrismaClient,
    private readonly provider: EmbeddingProvider,
    private readonly config: ApiConfiguration['embedding'],
    private readonly leaseMs = 120000,
    private readonly progress?: ProcessingProgressStore,
  ) {
    this.repository = new ProcessingRepository(db);
  }

  async execute(
    input: Parameters<ProcessingJobHandler['execute']>[0],
  ): Promise<HandlerResult> {
    try {
      const job = await this.db.processingJob.findUnique({
        where: { id: input.jobId },
        include: {
          aiRun: { include: { profile: true } },
          chunkSet: true,
          predecessor: true,
        },
      });
      if (
        !job ||
        job.jobType !== this.jobType ||
        job.status !== 'PROCESSING' ||
        job.leaseToken !== input.leaseToken ||
        job.attempts !== input.attempt ||
        job.documentId !== input.documentId ||
        job.documentVersionId !== input.documentVersionId
      )
        throw new EmbeddingFailure('EMBEDDING_JOB_INVALID');
      const set = job.chunkSet,
        run = job.aiRun;
      if (
        !set?.complete ||
        !run ||
        set.chunkCount < 1 ||
        job.predecessor?.jobType !== 'GENERATE_CHUNKS' ||
        job.predecessor.status !== 'COMPLETED' ||
        job.predecessor.chunkSetId !== set.id
      )
        throw new EmbeddingFailure('EMBEDDING_PREREQUISITE_MISSING');
      const stored = run.profile;
      if (!this.config.enabled)
        throw new EmbeddingFailure('EMBEDDING_NOT_CONFIGURED');
      if (stored.distance !== 'Cosine')
        throw new EmbeddingFailure('EMBEDDING_PROFILE_UNSUPPORTED');
      const profile: EmbeddingProfileIdentity = {
        ...stored,
        distance: 'Cosine',
      };
      if (
        stored.fingerprint !== embeddingProfileFingerprint(profile) ||
        stored.fingerprint !== this.config.profileFingerprint
      )
        throw new EmbeddingFailure('EMBEDDING_PROFILE_MISMATCH');
      // A conservative token budget bounds every request, including instructions.
      // A separate vector-value cap bounds memory and PostgreSQL transaction size.
      const size = Math.max(
        1,
        Math.min(
          this.config.batchSize,
          Math.floor(this.config.maxBatchTokens / this.config.maxInputTokens),
          Math.floor(500000 / profile.dimensions),
        ),
      );
      for (let ordinal = 0; ordinal < set.chunkCount; ordinal += size) {
        await this.repository.heartbeat(
          job.id,
          input.leaseToken,
          new Date(),
          this.leaseMs,
        );
        const chunks = await this.db.documentChunk.findMany({
          where: {
            chunkSetId: set.id,
            userId: job.userId,
            documentVersionId: job.documentVersionId,
            ordinal: {
              gte: ordinal,
              lt: Math.min(ordinal + size, set.chunkCount),
            },
          },
          orderBy: { ordinal: 'asc' },
          include: { embeddings: { where: { embeddingProfileId: stored.id } } },
        });
        if (
          chunks.length !== Math.min(size, set.chunkCount - ordinal) ||
          chunks.some((chunk, index) => chunk.ordinal !== ordinal + index)
        )
          throw new EmbeddingFailure('EMBEDDING_CHUNK_SET_INVALID');
        const hashes = new Map(
          chunks.map((chunk) => [
            chunk.id,
            embeddingInputHash(embeddingText(chunk.text, profile, 'document')),
          ]),
        );
        const missing: EmbeddingInput[] = [];
        for (const chunk of chunks) {
          const checkpoint = chunk.embeddings[0];
          if (checkpoint) {
            if (
              checkpoint.inputHash !== hashes.get(chunk.id) ||
              checkpoint.dimensions !== profile.dimensions ||
              !validVector(checkpoint.vector, profile.dimensions)
            )
              throw new EmbeddingFailure('EMBEDDING_CHECKPOINT_INVALID');
          } else missing.push({ id: chunk.id, text: chunk.text });
        }
        if (missing.length) {
          // Recheck immediately before disclosure, then commit only under fresh SQL fences.
          await this.repository.heartbeat(
            job.id,
            input.leaseToken,
            new Date(),
            this.leaseMs,
          );
          const began = performance.now();
          const results = validateEmbeddingResults(
            missing,
            await this.embed(missing, profile),
            profile.dimensions,
          );
          await this.repository.checkpoint(
            job.id,
            input.leaseToken,
            new Date(),
            async (tx, current) => {
              if (current.chunkSetId !== set.id || current.aiRunId !== run.id)
                throw new EmbeddingFailure('EMBEDDING_JOB_INVALID');
              const existing = await tx.chunkEmbedding.findMany({
                where: {
                  embeddingProfileId: stored.id,
                  chunkId: { in: results.map((result) => result.id) },
                },
              });
              for (const checkpoint of existing) {
                if (
                  checkpoint.inputHash !== hashes.get(checkpoint.chunkId) ||
                  !validVector(checkpoint.vector, profile.dimensions)
                )
                  throw new EmbeddingFailure('EMBEDDING_CHECKPOINT_INVALID');
              }
              const present = new Set(
                existing.map((checkpoint) => checkpoint.chunkId),
              );
              await tx.chunkEmbedding.createMany({
                data: results
                  .filter((result) => !present.has(result.id))
                  .map((result) => ({
                    userId: job.userId,
                    documentId: job.documentId,
                    documentVersionId: job.documentVersionId,
                    chunkId: result.id,
                    embeddingProfileId: stored.id,
                    dimensions: profile.dimensions,
                    inputHash: hashes.get(result.id)!,
                    vector: [...result.vector],
                  })),
              });
              return {};
            },
          );
          this.logger.log({
            event: 'embedding.batch.completed',
            jobId: job.id,
            documentVersionId: job.documentVersionId,
            profileId: stored.id,
            provider: profile.provider,
            model: profile.model,
            profileVersion: profile.profileVersion,
            attempt: input.attempt,
            batchSize: missing.length,
            durationMs: Math.round(performance.now() - began),
            completedChunks: ordinal + chunks.length,
          });
        }
        try {
          await this.progress?.report(
            job.id,
            input.attempt,
            Math.floor((100 * (ordinal + chunks.length)) / set.chunkCount),
            'EMBEDDING',
          );
        } catch {
          this.logger.warn({
            event: 'embedding.progress.unavailable',
            jobId: job.id,
          });
        }
      }
      return {
        kind: 'success',
        commit: async (tx) => {
          const count = await tx.chunkEmbedding.count({
            where: {
              embeddingProfileId: stored.id,
              chunk: { chunkSetId: set.id },
            },
          });
          if (count !== set.chunkCount)
            throw new EmbeddingFailure('EMBEDDING_CHECKPOINT_INCOMPLETE');
          return {};
        },
      };
    } catch (error) {
      if (error instanceof ProcessingError) throw error;
      const invalidPersistence =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2003', 'P2004'].includes(error.code);
      const failure =
        error instanceof EmbeddingFailure
          ? error
          : new EmbeddingFailure(
              invalidPersistence
                ? 'EMBEDDING_CHECKPOINT_INVALID'
                : 'EMBEDDING_PERSISTENCE_FAILED',
              !invalidPersistence,
            );
      this.logger.warn({
        event: 'embedding.stage.failed',
        jobId: input.jobId,
        attempt: input.attempt,
        category: failure.code,
      });
      return failure.retryable
        ? {
            kind: 'retryable',
            failureCode: failure.code,
            retryAfterMs: failure.retryAfterMs,
          }
        : { kind: 'terminal', failureCode: failure.code };
    }
  }

  private async embed(
    inputs: readonly EmbeddingInput[],
    profile: EmbeddingProfileIdentity,
  ): Promise<readonly EmbeddingResult[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.provider.embed({
          inputs,
          profile,
          purpose: 'document',
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new EmbeddingFailure('EMBEDDING_TIMEOUT', true));
          }, this.config.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof EmbeddingFailure) throw error;
      throw new EmbeddingFailure('EMBEDDING_PROVIDER_UNAVAILABLE', true);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
