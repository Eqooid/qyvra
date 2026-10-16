import { advanceSearchBranch } from './search-processing';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from './generated/prisma/client';
import { SearchPersistenceRepository } from './search-repository';
import { assertSearchUuid } from './search';
import { createProcessingOutboxIntent } from './processing';
import { ProcessingError } from './processing-rules';

export interface SearchEnrollmentPolicy {
  readonly enabled: boolean;
  readonly generationFingerprint: string;
}
const active = ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'];
/** SQL-only transaction hooks and bounded reconciliation in the existing recovery process. */
export class SearchEnrollmentRepository {
  private readonly persistence: SearchPersistenceRepository;
  constructor(private readonly db: PrismaClient) {
    this.persistence = new SearchPersistenceRepository(db);
  }
  async validatePolicy(policy: SearchEnrollmentPolicy) {
    if (!policy.enabled) return;
    if (
      !/^[0-9a-f]{64}$/.test(policy.generationFingerprint) ||
      !(await this.db.searchIndexGeneration.findFirst({
        where: {
          fingerprint: policy.generationFingerprint,
          status: { not: 'RETIRED' },
        },
        select: { id: true },
      }))
    )
      throw new ProcessingError('INVALID_INPUT');
  }
  async metadataHash(
    tx: Prisma.TransactionClient,
    versionId: string,
  ): Promise<string> {
    assertSearchUuid(versionId);
    const rows = await tx.$queryRaw<{ hash: string | null }[]>`
      SELECT search_metadata_hash(${versionId}::uuid) AS hash`;
    if (!rows[0]?.hash) throw new ProcessingError('INELIGIBLE_DOCUMENT');
    return rows[0].hash;
  }
  private async lockOwned(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
  ) {
    assertSearchUuid(userId);
    assertSearchUuid(documentId);
    await tx.$queryRaw`SELECT id FROM documents WHERE id=${documentId}::uuid AND user_id=${userId}::uuid FOR UPDATE`;
    const document = await tx.document.findFirst({
      where: { id: documentId, userId },
      include: {
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
        searchState: true,
      },
    });
    if (!document) throw new ProcessingError('INELIGIBLE_DOCUMENT');
    return document;
  }
  private async retire(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    now: Date,
  ) {
    await tx.processingJob.updateMany({
      where: {
        userId,
        documentId,
        jobType: { in: ['INDEX_SEARCH', 'EXTRACT_SEARCH_TEXT'] },
        status: { in: active },
      },
      data: {
        status: 'CANCELLED',
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      },
    });
    await tx.versionSearchProjection.updateMany({
      where: {
        userId,
        documentId,
        status: { in: ['BUILDING', 'READY', 'FAILED'] },
      },
      data: { status: 'REMOVAL_PENDING' },
    });
    await this.ensureRemovalInTransaction(tx, userId, documentId);
  }
  async ensureRemovalInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
  ) {
    const rows = await tx.$queryRaw<
      { id: string; documentVersionId: string }[]
    >`
      SELECT p.id,p.document_version_id AS "documentVersionId" FROM version_search_projections p
      WHERE p.user_id=${userId}::uuid AND p.document_id=${documentId}::uuid AND p.status='REMOVAL_PENDING'
        AND NOT EXISTS (SELECT 1 FROM processing_jobs j WHERE j.document_version_id=p.document_version_id
          AND j.job_type='REMOVE_SEARCH_INDEX' AND (j.status IN ('PENDING','QUEUED','PROCESSING','RETRYING')
            OR (j.search_projection_id=p.id AND j.status IN ('FAILED','CANCELLED'))))
      ORDER BY p.created_at,p.id LIMIT 1`;
    const p = rows[0];
    if (!p) return null;
    return this.persistence.createJobInTransaction(tx, {
      userId,
      documentId,
      documentVersionId: p.documentVersionId,
      searchProjectionId: p.id,
      jobType: 'REMOVE_SEARCH_INDEX',
      maxAttempts: 5,
      correlationId: randomUUID(),
    });
  }
  async invalidateInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    now = new Date(),
  ) {
    const document = await this.lockOwned(tx, userId, documentId);
    const state = document.searchState;
    if (!state) return false;
    // A duplicate lifecycle transition has no new work or revision.
    const live = await tx.versionSearchProjection.count({
      where: {
        userId,
        documentId,
        status: { in: ['BUILDING', 'READY', 'FAILED'] },
      },
    });
    if (!live && !state.readyProjectionId) return false;
    await this.advance(
      tx,
      userId,
      documentId,
      state.desiredVersionId,
      state.desiredRevision,
    );
    await this.retire(tx, userId, documentId, now);
    return true;
  }
  private async advance(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    versionId: string,
    revision: number,
  ) {
    if (revision >= 2147483647) throw new ProcessingError('INVALID_INPUT');
    const result = await tx.documentSearchState.updateMany({
      where: { documentId, userId, desiredRevision: revision },
      data: {
        desiredRevision: revision + 1,
        desiredVersionId: versionId,
        readyProjectionId: null,
      },
    });
    if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
  }
  async enrollInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    policy: SearchEnrollmentPolicy,
    now = new Date(),
    correlationId: string = randomUUID(),
  ) {
    if (!policy.enabled) {
      // Disabling enrollment never preserves stale publication after a mutation.
      if (
        await tx.documentSearchState.findFirst({
          where: { documentId, userId },
          select: { documentId: true },
        })
      )
        await this.invalidateInTransaction(tx, userId, documentId, now);
      return null;
    }
    const document = await this.lockOwned(tx, userId, documentId);
    const version = document.versions[0];
    if (
      !version ||
      document.deletedAt ||
      document.isArchived ||
      ['ARCHIVED', 'DELETING'].includes(document.status)
    ) {
      if (document.searchState)
        await this.invalidateInTransaction(tx, userId, documentId, now);
      return null;
    }
    const generation = await tx.searchIndexGeneration.findFirst({
      where: {
        fingerprint: policy.generationFingerprint,
        status: { not: 'RETIRED' },
      },
      orderBy: [{ status: 'desc' }, { generation: 'asc' }],
    });
    if (!generation) throw new ProcessingError('INVALID_INPUT');
    const hash = await this.metadataHash(tx, version.id);
    let state = document.searchState;
    const existing = state
      ? await tx.versionSearchProjection.findUnique({
          where: {
            documentVersionId_indexGenerationId_revision: {
              documentVersionId: version.id,
              indexGenerationId: generation.id,
              revision: state.desiredRevision,
            },
          },
        })
      : null;
    if (
      existing &&
      existing.metadataHash === hash &&
      ['BUILDING', 'READY', 'FAILED'].includes(existing.status)
    ) {
      // Exhausted work remains observable; duplicate events do not reset attempts.
      if (existing.status === 'BUILDING') {
        const job = await tx.processingJob.findFirst({
          where: { searchProjectionId: existing.id, jobType: 'INDEX_SEARCH' },
          orderBy: { generation: 'desc' },
        });
        if (!job)
          await this.persistence.createJobInTransaction(tx, {
            userId,
            documentId,
            documentVersionId: version.id,
            searchProjectionId: existing.id,
            jobType: 'INDEX_SEARCH',
            maxAttempts: 5,
            correlationId,
          });
        else if (['PENDING', 'QUEUED', 'RETRYING'].includes(job.status)) {
          const intent = await tx.processingOutbox.findFirst({
            where: {
              processingJobId: job.id,
              dispatchSequence: job.attempts + 1,
            },
          });
          if (!intent) {
            await createProcessingOutboxIntent(
              tx,
              job,
              job.attempts + 1,
              job.availableAt > now ? job.availableAt : now,
            );
          }
        }
      }
      if (existing.status === 'READY') {
        const completed = await tx.processingJob.findFirst({
          where: {
            searchProjectionId: existing.id,
            jobType: 'INDEX_SEARCH',
            status: 'COMPLETED',
          },
          orderBy: { generation: 'desc' },
        });
        if (completed) await advanceSearchBranch(tx, completed, now);
      }
      return existing;
    }
    if (state) {
      await this.advance(
        tx,
        userId,
        documentId,
        version.id,
        state.desiredRevision,
      );
      await this.retire(tx, userId, documentId, now);
      state = await tx.documentSearchState.findUniqueOrThrow({
        where: { documentId },
      });
    } else
      state = await this.persistence.initializeStateInTransaction(tx, {
        userId,
        documentId,
        documentVersionId: version.id,
      });
    const projection = await this.persistence.createProjectionInTransaction(
      tx,
      {
        userId,
        documentId,
        documentVersionId: version.id,
        indexGenerationId: generation.id,
        revision: state.desiredRevision,
        metadataHash: hash,
      },
    );
    await this.persistence.createJobInTransaction(tx, {
      userId,
      documentId,
      documentVersionId: version.id,
      searchProjectionId: projection.id,
      jobType: 'INDEX_SEARCH',
      maxAttempts: 5,
      correlationId,
    });
    return projection;
  }
  async recordOrganizationChangeInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    resourceId: string,
    reason: 'CATEGORY_DELETED' | 'TAG_DELETED',
    policy: SearchEnrollmentPolicy,
  ) {
    if (
      !policy.enabled &&
      !(await tx.documentSearchState.findFirst({
        where: { userId },
        select: { documentId: true },
      }))
    )
      return null;
    return this.persistence.createChangeInTransaction(tx, {
      id: randomUUID(),
      userId,
      reason,
      resourceId,
    });
  }
  async reconcile(
    policy: SearchEnrollmentPolicy,
    limit: number,
    now = new Date(),
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ProcessingError('INVALID_INPUT');
    // Each checkpoint scan and cursor advance commit together with its document jobs.
    const changes = await this.db.searchProjectionChange.findMany({
      where: { status: 'PENDING' },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 1,
    });
    for (const candidate of changes) {
      try {
        await this.db.$transaction(async (tx) => {
          // Lock order: documents first, then checkpoint CAS. Never wait for documents
          // while holding an organization/user lock used by mutation transactions.
          const docs = await tx.documentSearchState.findMany({
            where: {
              userId: candidate.userId,
              ...(candidate.afterDocumentId
                ? { documentId: { gt: candidate.afterDocumentId } }
                : {}),
            },
            orderBy: { documentId: 'asc' },
            take: limit,
          });
          for (const state of docs)
            await this.enrollInTransaction(
              tx,
              state.userId,
              state.documentId,
              policy,
              now,
            );
          await this.persistence.advanceChangeInTransaction(tx, {
            id: candidate.id,
            userId: candidate.userId,
            expectedAfterDocumentId: candidate.afterDocumentId,
            afterDocumentId:
              docs.at(-1)?.documentId ?? candidate.afterDocumentId,
            complete: docs.length < limit,
          });
        });
      } catch (error) {
        if (!(
          error instanceof ProcessingError && error.code === 'CONCURRENT_CHANGE'
        ))
          throw error;
      }
    }
    // Only already enrolled states are reconciled: this is not vault/historical backfill.
    const states = await this.db.documentSearchState.findMany({
      orderBy: [{ updatedAt: 'asc' }, { documentId: 'asc' }],
      take: limit,
    });
    for (const state of states)
      await this.db.$transaction(async (tx) => {
        await this.enrollInTransaction(
          tx,
          state.userId,
          state.documentId,
          policy,
          now,
        );
        await tx.documentSearchState.updateMany({
          where: { documentId: state.documentId, userId: state.userId },
          data: { updatedAt: now },
        });
      });
    const cleanup = await this.db.$queryRaw<
      { documentId: string; userId: string }[]
    >`
      SELECT DISTINCT p.document_id AS "documentId",p.user_id AS "userId"
      FROM version_search_projections p WHERE p.status='REMOVAL_PENDING'
        AND NOT EXISTS (SELECT 1 FROM processing_jobs j WHERE j.document_version_id=p.document_version_id
          AND j.job_type='REMOVE_SEARCH_INDEX' AND (j.status IN ('PENDING','QUEUED','PROCESSING','RETRYING')
            OR (j.search_projection_id=p.id AND j.status IN ('FAILED','CANCELLED'))))
      ORDER BY p.document_id LIMIT ${limit}`;
    for (const d of cleanup)
      await this.db.$transaction(async (tx) => {
        await this.lockOwned(tx, d.userId, d.documentId);
        await this.ensureRemovalInTransaction(tx, d.userId, d.documentId);
      });
  }
}
