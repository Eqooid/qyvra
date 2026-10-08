import {
  ProcessingRepository,
  ProcessingError,
  type PrismaClient,
} from '@qyvra/database';
import { Logger } from '@nestjs/common';
import {
  VectorStoreFailure,
  type VectorStore,
  type VectorScope,
} from '../../modules/ai/vector-store';
import type {
  ProcessingJobHandler,
  HandlerResult,
} from './processing-message-handler';

export class VectorRemovalHandler implements ProcessingJobHandler {
  readonly jobType = 'REMOVE_VECTOR_INDEX' as const;
  private readonly repository: ProcessingRepository;
  private readonly logger = new Logger(VectorRemovalHandler.name);
  constructor(
    private readonly db: PrismaClient,
    private readonly store: VectorStore,
    private readonly leaseMs = 120000,
  ) {
    this.repository = new ProcessingRepository(db);
  }
  async execute(
    input: Parameters<ProcessingJobHandler['execute']>[0],
  ): Promise<HandlerResult> {
    try {
      const job = await this.db.processingJob.findUnique({
        where: { id: input.jobId },
        include: { vectorIndex: { include: { profile: true } } },
      });
      if (
        !job ||
        job.jobType !== this.jobType ||
        job.status !== 'PROCESSING' ||
        job.leaseToken !== input.leaseToken ||
        job.attempts !== input.attempt ||
        job.documentId !== input.documentId ||
        job.documentVersionId !== input.documentVersionId ||
        !job.vectorIndex
      )
        throw new VectorStoreFailure('VECTOR_JOB_INVALID');
      const index = job.vectorIndex;
      if (
        index.status !== 'REMOVAL_PENDING' ||
        (await this.db.versionReadyIndex.findFirst({
          where: { vectorIndexId: index.id },
        }))
      )
        throw new VectorStoreFailure('VECTOR_REMOVAL_INELIGIBLE');
      const scope: VectorScope = {
        collectionName: index.collectionName,
        userId: index.userId,
        documentId: index.documentId,
        documentVersionId: index.documentVersionId,
        chunkSetId: index.chunkSetId,
        indexManifestId: index.id,
        embeddingProfileId: index.embeddingProfileId,
        embeddingProfileVersion: index.profile.profileVersion,
      };
      await this.repository.heartbeat(
        job.id,
        input.leaseToken,
        new Date(),
        this.leaseMs,
      );
      await this.store.remove(scope);
      await this.repository.heartbeat(
        job.id,
        input.leaseToken,
        new Date(),
        this.leaseMs,
      );
      if ((await this.store.count(scope)) !== 0)
        throw new VectorStoreFailure('VECTOR_REMOVAL_UNCONFIRMED', true);
      return {
        kind: 'success',
        commit: async (tx) => {
          if (
            await tx.versionReadyIndex.findFirst({
              where: { vectorIndexId: index.id },
            })
          )
            throw new VectorStoreFailure('VECTOR_REMOVAL_INELIGIBLE');
          const updated = await tx.versionVectorIndex.updateMany({
            where: { id: index.id, status: 'REMOVAL_PENDING' },
            data: { status: 'REMOVED', lastFailureCode: null },
          });
          if (updated.count !== 1)
            throw new VectorStoreFailure('VECTOR_REMOVAL_INELIGIBLE');
          return {};
        },
      };
    } catch (error) {
      if (error instanceof ProcessingError) throw error;
      const failure =
        error instanceof VectorStoreFailure
          ? error
          : new VectorStoreFailure('VECTOR_PERSISTENCE_FAILED', true);
      this.logger.warn({
        event: 'vector.removal.failed',
        jobId: input.jobId,
        category: failure.code,
        attempt: input.attempt,
      });
      return {
        kind: failure.retryable ? 'retryable' : 'terminal',
        failureCode: failure.code,
      };
    }
  }
}
