import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from './generated/prisma/client';
import { SearchPersistenceRepository } from './search-repository';
import { SearchEnrollmentRepository } from './search-enrollment';
import { createStoredFileVerificationIntent } from './processing';
import { ProcessingError } from './processing-rules';

const active = ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'];
/** SQL-only orchestration; reused by operator batches and the existing recovery loop. */
export class SearchMaintenanceScheduler {
  constructor(private readonly db: PrismaClient) {}

  async prepare(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    generationId: string,
    correlationId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM documents WHERE id=${documentId}::uuid AND user_id=${userId}::uuid FOR UPDATE`;
    const d = await tx.document.findFirst({
      where: { id: documentId, userId },
      include: {
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
        searchState: true,
      },
    });
    const v = d?.versions[0];
    const g = await tx.searchIndexGeneration.findUnique({
      where: { id: generationId },
    });
    if (
      !d ||
      !v ||
      d.deletedAt ||
      d.isArchived ||
      ['ARCHIVED', 'DELETING'].includes(d.status) ||
      !g ||
      g.status === 'RETIRED'
    )
      return 'INELIGIBLE' as const;
    const persistence = new SearchPersistenceRepository(this.db);
    const enrollment = new SearchEnrollmentRepository(this.db);
    // Only the ordinary lifecycle owns revision changes. A shadow never revokes serving data.
    const s =
      d.searchState ??
      (await persistence.initializeStateInTransaction(tx, {
        userId,
        documentId,
        documentVersionId: v.id,
      }));
    if (s.desiredVersionId !== v.id) return 'STALE' as const;
    const hash = await enrollment.metadataHash(tx, v.id);
    let p = await tx.versionSearchProjection.findUnique({
      where: {
        documentVersionId_indexGenerationId_revision: {
          documentVersionId: v.id,
          indexGenerationId: g.id,
          revision: s.desiredRevision,
        },
      },
    });
    if (p?.status === 'READY' && p.metadataHash === hash)
      return 'ALREADY_READY' as const;
    if (p && (p.status !== 'BUILDING' || p.metadataHash !== hash))
      return 'BLOCKED' as const;
    p ??= await persistence.createProjectionInTransaction(tx, {
      userId,
      documentId,
      documentVersionId: v.id,
      indexGenerationId: g.id,
      revision: s.desiredRevision,
      metadataHash: hash,
    });
    if (
      await tx.processingJob.findFirst({
        where: {
          documentVersionId: v.id,
          jobType: { in: ['INDEX_SEARCH', 'EXTRACT_SEARCH_TEXT'] },
          status: { in: active },
        },
      })
    )
      return 'PENDING' as const;
    const artifact = await tx.extractedText.findFirst({
      where: {
        userId,
        documentId,
        documentVersionId: v.id,
        sourceChecksum: v.checksumSha256,
        extractor: g.extractor,
        extractorVersion: g.extractorVersion,
        normalizationVersion: g.normalizationVersion,
        outcome: 'COMPLETED',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (artifact && !p.extractedTextId)
      p = await tx.versionSearchProjection.update({
        where: { id: p.id },
        data: { extractedTextId: artifact.id, textCoverage: 'READY' },
      });
    let predecessor: string | undefined;
    let jobType: 'INDEX_SEARCH' | 'EXTRACT_SEARCH_TEXT' = 'INDEX_SEARCH';
    if (
      v.mimeType === 'application/pdf' &&
      !p.extractedTextId &&
      !['UNSUPPORTED', 'FAILED'].includes(p.textCoverage)
    ) {
      const integrity = await tx.processingJob.findFirst({
        where: { documentVersionId: v.id, jobType: 'VERIFY_STORED_FILE' },
        orderBy: { generation: 'desc' },
      });
      if (!integrity) {
        await createStoredFileVerificationIntent(tx, {
          userId,
          documentId,
          documentVersionId: v.id,
          maxAttempts: 5,
          correlationId,
        });
        return 'SCHEDULED' as const;
      }
      if (active.includes(integrity.status)) return 'PENDING' as const;
      if (integrity.status !== 'COMPLETED') return 'BLOCKED' as const;
      predecessor = integrity.id;
      jobType = 'EXTRACT_SEARCH_TEXT';
      p = await tx.versionSearchProjection.update({
        where: { id: p.id },
        data: { textCoverage: 'PENDING' },
      });
    } else if (v.mimeType !== 'application/pdf') {
      p = await tx.versionSearchProjection.update({
        where: { id: p.id },
        data: { textCoverage: 'UNSUPPORTED' },
      });
    }
    const last = await tx.processingJob.findFirst({
      where: { documentVersionId: v.id, jobType },
      orderBy: { generation: 'desc' },
    });
    if (last?.searchProjectionId === p.id) return 'BLOCKED' as const;
    const base = {
      userId,
      documentId,
      documentVersionId: v.id,
      searchProjectionId: p.id,
      maxAttempts: 5,
      correlationId,
    };
    if (jobType === 'EXTRACT_SEARCH_TEXT') {
      if (!predecessor) throw new ProcessingError('INVALID_INPUT');
      await persistence.createJobInTransaction(tx, {
        ...base,
        jobType,
        predecessorJobId: predecessor,
      });
    } else await persistence.createJobInTransaction(tx, { ...base, jobType });
    return 'SCHEDULED' as const;
  }

  async reconcile(limit: number) {
    // Completion of integrity/extraction or another generation's job wakes a shadow
    // without a second scheduler/queue. Failed terminal work is not reset here.
    const pending = await this.db.versionSearchProjection.findMany({
      where: { status: 'BUILDING', generation: { status: 'BUILDING' } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: Math.min(limit, 100),
    });
    for (const p of pending)
      await this.db.$transaction(async (tx) => {
        await this.prepare(
          tx,
          p.userId,
          p.documentId,
          p.indexGenerationId,
          randomUUID(),
        );
        await tx.versionSearchProjection.updateMany({
          where: { id: p.id, status: 'BUILDING' },
          data: { updatedAt: new Date() },
        });
      });
    const cutoff = new Date(Date.now() - 86400000);
    const cleanup = await this.db.versionSearchProjection.findMany({
      where: {
        OR: [
          { status: 'REMOVAL_PENDING' },
          { status: 'REMOVED', updatedAt: { lt: cutoff } },
          {
            status: { in: ['BUILDING', 'READY', 'FAILED'] },
            generation: { status: 'RETIRED', updatedAt: { lt: cutoff } },
          },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: Math.min(limit, 10),
    });
    for (const p of cleanup)
      await this.db.$transaction((tx) =>
        this.remove(
          tx,
          p.userId,
          p.documentId,
          p.indexGenerationId,
          randomUUID(),
          false,
        ),
      );
  }

  async remove(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    generationId: string,
    correlationId: string,
    retryFailed: boolean,
  ) {
    await tx.$queryRaw`SELECT id FROM documents WHERE id=${documentId}::uuid AND user_id=${userId}::uuid FOR UPDATE`;
    const cutoff = new Date(Date.now() - 86400000);
    const projections = await tx.versionSearchProjection.findMany({
      where: {
        userId,
        documentId,
        indexGenerationId: generationId,
        OR: [
          { status: 'REMOVAL_PENDING' },
          { status: 'REMOVED', updatedAt: { lt: cutoff } },
          {
            status: { in: ['READY', 'FAILED', 'BUILDING'] },
            generation: { status: 'RETIRED', updatedAt: { lt: cutoff } },
          },
        ],
      },
      orderBy: { id: 'asc' },
      take: retryFailed ? 25 : 1,
    });
    let scheduled = 0;
    for (const p of projections) {
      if (
        await tx.documentSearchState.findFirst({
          where: { readyProjectionId: p.id },
        })
      )
        continue;
      if (!['REMOVAL_PENDING', 'REMOVED'].includes(p.status))
        await tx.versionSearchProjection.update({
          where: { id: p.id },
          data: { status: 'REMOVAL_PENDING' },
        });
      const last = await tx.processingJob.findFirst({
        where: {
          documentVersionId: p.documentVersionId,
          jobType: 'REMOVE_SEARCH_INDEX',
        },
        orderBy: { generation: 'desc' },
      });
      if (
        last &&
        (active.includes(last.status) ||
          (!retryFailed && ['FAILED', 'CANCELLED'].includes(last.status)))
      )
        continue;
      await new SearchPersistenceRepository(this.db).createJobInTransaction(
        tx,
        {
          userId,
          documentId,
          documentVersionId: p.documentVersionId,
          searchProjectionId: p.id,
          jobType: 'REMOVE_SEARCH_INDEX',
          maxAttempts: 5,
          correlationId,
        },
        last?.searchProjectionId === p.id,
      );
      scheduled++;
    }
    return scheduled;
  }
}
