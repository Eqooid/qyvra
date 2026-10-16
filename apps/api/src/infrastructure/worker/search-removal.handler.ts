import {
  PrismaClient,
  ProcessingRepository,
  ProcessingError,
} from '@qyvra/database';
import { SearchStoreFailure, type LexicalStore } from '../search/lexical-store';
import { targetFromGeneration } from '../search/search-index';
import type {
  HandlerResult,
  ProcessingJobHandler,
} from './processing-message-handler';

/** Delete only immutable SQL-manifest identities, never an index/delete-by-query. */
export class SearchRemovalHandler implements ProcessingJobHandler {
  readonly jobType = 'REMOVE_SEARCH_INDEX' as const;
  constructor(
    private readonly db: PrismaClient,
    private readonly store: LexicalStore,
    private readonly prefix: string,
    private readonly leaseMs = 120000,
  ) {}
  async execute(
    input: Parameters<ProcessingJobHandler['execute']>[0],
  ): Promise<HandlerResult> {
    const repository = new ProcessingRepository(this.db);
    try {
      const j = await this.db.processingJob.findUnique({
        where: { id: input.jobId },
        include: { searchProjection: { include: { generation: true } } },
      });
      const p = j?.searchProjection;
      if (
        !j ||
        !p ||
        j.jobType !== this.jobType ||
        j.status !== 'PROCESSING' ||
        j.attempts !== input.attempt ||
        j.leaseToken !== input.leaseToken ||
        j.documentId !== input.documentId ||
        j.documentVersionId !== input.documentVersionId ||
        !['REMOVAL_PENDING', 'REMOVED'].includes(p.status)
      )
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      if (
        await this.db.documentSearchState.findFirst({
          where: { readyProjectionId: p.id },
        })
      )
        throw new SearchStoreFailure('SEARCH_CONFLICT');
      const target = targetFromGeneration(this.prefix, p.generation);
      const scope = {
        documentId: p.documentId,
        documentVersionId: p.documentVersionId,
        projectionId: p.id,
        revision: p.revision,
      };
      const ids = p.expectedRecordIds;
      if (
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== 'string') ||
        ids.length > 10000
      )
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      const deadline = AbortSignal.timeout(Math.min(this.leaseMs, 600000));
      for (const kind of ['metadata', 'pages'] as const) {
        const index = await this.store.inspect(target, kind, deadline);
        if (!index.exists) continue;
        if (!index.compatible)
          throw new SearchStoreFailure('SEARCH_INDEX_INCOMPATIBLE');
        const selected = ids.filter(
          (id): id is string =>
            typeof id === 'string' &&
            (kind === 'metadata'
              ? id.endsWith(':metadata')
              : id.includes(':page:')),
        );
        for (let offset = 0; offset < selected.length; offset += 25) {
          await repository.heartbeat(
            j.id,
            input.leaseToken,
            new Date(),
            this.leaseMs,
          );
          const batch = selected.slice(offset, offset + 25);
          await this.store.remove(
            target,
            kind,
            j.userId,
            scope,
            batch,
            deadline,
          );
          if (
            (
              await this.store.verify(
                target,
                kind,
                j.userId,
                scope,
                batch,
                deadline,
              )
            ).length
          )
            throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
        }
      }
      return {
        kind: 'success',
        commit: async (tx) => {
          if (
            await tx.documentSearchState.findFirst({
              where: { readyProjectionId: p.id },
            })
          )
            throw new ProcessingError('CONCURRENT_CHANGE');
          const result = await tx.versionSearchProjection.updateMany({
            where: { id: p.id, status: { in: ['REMOVAL_PENDING', 'REMOVED'] } },
            data: { status: 'REMOVED' },
          });
          if (result.count !== 1)
            throw new ProcessingError('CONCURRENT_CHANGE');
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
