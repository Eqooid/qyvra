import { Logger } from '@nestjs/common';
import {
  ProcessingRepository,
  ProcessingError,
  Prisma,
  embeddingProfileFingerprint,
  type PrismaClient,
} from '@qyvra/database';
import type { ApiConfiguration } from '../../configuration/settings';
import {
  EmbeddingFailure,
  embeddingInputHash,
  embeddingText,
  validVector,
} from '../../modules/ai/embedding-provider';
import {
  VectorStoreFailure,
  vectorPointId,
  validatePoints,
  type VectorStore,
  type VectorScope,
  type VectorPoint,
} from '../../modules/ai/vector-store';
import type { ProcessingProgressStore } from '../progress/processing-progress';
import type {
  HandlerResult,
  ProcessingJobHandler,
} from './processing-message-handler';

/** Remote IO precedes fenced SQL checkpoints. Activation belongs to complete(). */
export class VectorIndexHandler implements ProcessingJobHandler {
  readonly jobType = 'INDEX_VECTORS' as const;
  private readonly repository: ProcessingRepository;
  private readonly logger = new Logger(VectorIndexHandler.name);
  constructor(
    private readonly db: PrismaClient,
    private readonly store: VectorStore,
    private readonly config: ApiConfiguration['vectorIndex'],
    private readonly leaseMs = 120000,
    private readonly progress?: ProcessingProgressStore,
  ) {
    this.repository = new ProcessingRepository(db);
  }
  async execute(
    input: Parameters<ProcessingJobHandler['execute']>[0],
  ): Promise<HandlerResult> {
    const began = performance.now();
    try {
      const job = await this.db.processingJob.findUnique({
        where: { id: input.jobId },
        include: {
          vectorIndex: { include: { profile: true, set: true } },
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
        throw new VectorStoreFailure('VECTOR_JOB_INVALID');
      const index = job.vectorIndex;
      if (
        !index ||
        index.status !== 'BUILDING' ||
        index.aiRunId !== job.aiRunId ||
        index.chunkSetId !== job.chunkSetId ||
        !index.set.complete ||
        index.expectedPointCount !== index.set.chunkCount ||
        job.predecessor?.jobType !== 'GENERATE_EMBEDDINGS' ||
        job.predecessor.status !== 'COMPLETED' ||
        job.predecessor.chunkSetId !== index.chunkSetId
      )
        throw new VectorStoreFailure('VECTOR_PREREQUISITE_MISSING');
      if (!this.config.enabled)
        throw new VectorStoreFailure('VECTOR_NOT_CONFIGURED');
      const profile = index.profile;
      if (
        profile.distance !== 'Cosine' ||
        profile.fingerprint !==
          embeddingProfileFingerprint({ ...profile, distance: 'Cosine' })
      )
        throw new VectorStoreFailure('VECTOR_PROFILE_INVALID');
      const scope: VectorScope = {
        collectionName: index.collectionName,
        userId: job.userId,
        documentId: job.documentId,
        documentVersionId: job.documentVersionId,
        chunkSetId: index.chunkSetId,
        indexManifestId: index.id,
        embeddingProfileId: index.embeddingProfileId,
        embeddingProfileVersion: profile.profileVersion,
      };
      const heartbeat = () =>
        this.repository.heartbeat(
          job.id,
          input.leaseToken,
          new Date(),
          this.leaseMs,
        );
      await heartbeat();
      await this.store.ensureCollection(scope, profile.dimensions);
      const size = Math.max(
        1,
        Math.min(
          this.config.batchSize,
          Math.floor(500000 / profile.dimensions),
        ),
      );
      const batch = async (ordinal: number): Promise<VectorPoint[]> => {
        const chunks = await this.db.documentChunk.findMany({
          where: {
            userId: job.userId,
            documentVersionId: job.documentVersionId,
            chunkSetId: index.chunkSetId,
            ordinal: {
              gte: ordinal,
              lt: Math.min(ordinal + size, index.expectedPointCount),
            },
          },
          orderBy: { ordinal: 'asc' },
          include: {
            embeddings: { where: { embeddingProfileId: profile.id } },
          },
        });
        if (
          chunks.length !==
            Math.min(size, index.expectedPointCount - ordinal) ||
          chunks.some((c, i) => c.ordinal !== ordinal + i)
        )
          throw new VectorStoreFailure('VECTOR_CHUNK_SET_INVALID');
        return chunks.map((chunk) => {
          const embedding = chunk.embeddings[0];
          if (
            !embedding ||
            embedding.dimensions !== profile.dimensions ||
            !validVector(embedding.vector, profile.dimensions) ||
            embedding.inputHash !==
              embeddingInputHash(
                embeddingText(
                  chunk.text,
                  { ...profile, distance: 'Cosine' },
                  'document',
                ),
              )
          )
            throw new VectorStoreFailure('VECTOR_EMBEDDING_INVALID');
          if (!Array.isArray(chunk.pageSpans))
            throw new VectorStoreFailure('VECTOR_PROVENANCE_INVALID');
          const pageNumbers = [
            ...new Set(
              chunk.pageSpans.map((span) => {
                if (
                  !span ||
                  typeof span !== 'object' ||
                  Array.isArray(span) ||
                  typeof span.pageNumber !== 'number'
                )
                  throw new VectorStoreFailure('VECTOR_PROVENANCE_INVALID');
                return span.pageNumber;
              }),
            ),
          ].sort((a, b) => a - b);
          const { collectionName: _collection, ...payload } = scope;
          void _collection;
          return {
            id: vectorPointId(chunk.id, profile.id, index.id),
            vector: embedding.vector,
            payload: {
              ...payload,
              chunkId: chunk.id,
              ordinal: chunk.ordinal,
              payloadSchemaVersion: 1,
              pageNumbers,
            },
          };
        });
      };
      // Revalidate even checkpointed batches: Qdrant may have lost its volume.
      for (
        let ordinal = 0;
        ordinal < index.expectedPointCount;
        ordinal += size
      ) {
        const points = await batch(ordinal);
        validatePoints(scope, points, profile.dimensions);
        await heartbeat();
        if (!(await this.store.verify(scope, points))) {
          await heartbeat();
          await this.store.upsert(scope, points);
          await heartbeat();
          if (!(await this.store.verify(scope, points)))
            throw new VectorStoreFailure('VECTOR_WRITE_UNCONFIRMED', true);
        }
        const count = ordinal + points.length;
        await this.repository.checkpoint(
          job.id,
          input.leaseToken,
          new Date(),
          async (tx) => {
            const current = await tx.versionVectorIndex.findUniqueOrThrow({
              where: { id: index.id },
            });
            if (current.status !== 'BUILDING')
              throw new VectorStoreFailure('VECTOR_JOB_INVALID');
            await tx.versionVectorIndex.update({
              where: { id: index.id },
              data: {
                confirmedPointCount: Math.max(
                  current.confirmedPointCount,
                  count,
                ),
                checkpointOrdinal: Math.max(
                  current.checkpointOrdinal,
                  count - 1,
                ),
                lastFailureCode: null,
              },
            });
            return {};
          },
        );
        try {
          await this.progress?.report(
            job.id,
            input.attempt,
            Math.floor((count * 100) / index.expectedPointCount),
            'INDEXING',
          );
        } catch {
          this.logger.warn({
            event: 'vector.progress.unavailable',
            jobId: job.id,
          });
        }
      }
      // Verify the whole generation immediately before SQL activation.
      for (
        let ordinal = 0;
        ordinal < index.expectedPointCount;
        ordinal += size
      ) {
        await heartbeat();
        if (!(await this.store.verify(scope, await batch(ordinal))))
          throw new VectorStoreFailure('VECTOR_WRITE_UNCONFIRMED', true);
      }
      await heartbeat();
      if ((await this.store.count(scope)) !== index.expectedPointCount)
        throw new VectorStoreFailure('VECTOR_COUNT_MISMATCH', true);
      this.logger.log({
        event: 'vector.index.verified',
        jobId: job.id,
        manifestId: index.id,
        profileId: profile.id,
        chunkCount: index.expectedPointCount,
        attempt: input.attempt,
        durationMs: Math.round(performance.now() - began),
      });
      return {
        kind: 'success',
        commit: async (tx) => {
          const current = await tx.versionVectorIndex.findUniqueOrThrow({
            where: { id: index.id },
          });
          if (
            current.status !== 'BUILDING' ||
            current.confirmedPointCount !== current.expectedPointCount ||
            current.checkpointOrdinal !== current.expectedPointCount - 1
          )
            throw new VectorStoreFailure('VECTOR_CHECKPOINT_INCOMPLETE');
          await tx.versionVectorIndex.update({
            where: { id: index.id },
            data: {
              status: 'READY',
              indexedAt: new Date(),
              lastFailureCode: null,
            },
          });
          return {};
        },
      };
    } catch (error) {
      if (error instanceof ProcessingError) throw error;
      const invalid =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2003', 'P2004'].includes(error.code);
      const failure =
        error instanceof EmbeddingFailure
          ? new VectorStoreFailure('VECTOR_PROFILE_INVALID')
          : error instanceof VectorStoreFailure
            ? error
            : new VectorStoreFailure(
                invalid ? 'VECTOR_STATE_INVALID' : 'VECTOR_PERSISTENCE_FAILED',
                !invalid,
              );
      this.logger.warn({
        event: 'vector.index.failed',
        jobId: input.jobId,
        attempt: input.attempt,
        category: failure.code,
      });
      return {
        kind: failure.retryable ? 'retryable' : 'terminal',
        failureCode: failure.code,
      };
    }
  }
}
