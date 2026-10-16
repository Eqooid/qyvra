import { randomUUID } from 'node:crypto';
import {
  Prisma,
  PrismaClient,
  ProcessingError,
  SearchEnrollmentRepository,
  SearchMaintenanceScheduler,
  type SearchMaintenanceOperation,
} from '@qyvra/database';
import type { CanonicalContent } from '../../infrastructure/extraction/pdf-parser';
import {
  lexicalManifest,
  lexicalRecords,
} from '../../infrastructure/search/lexical-projection';
import {
  targetFromGeneration,
  recordId,
} from '../../infrastructure/search/search-index';
import {
  SearchStoreFailure,
  type LexicalStore,
} from '../../infrastructure/search/lexical-store';

export type MaintenanceKind = 'BACKFILL' | 'REBUILD' | 'RECONCILE' | 'CLEANUP';
const eligible = {
  deletedAt: null,
  isArchived: false,
  status: { notIn: ['ARCHIVED', 'DELETING'] },
  versions: { some: {} },
};
const leaseMs = 120000;
export function maintenanceUuid(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new ProcessingError('INVALID_INPUT');
  return value;
}
export function maintenanceInitiator(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9@._:-]{0,99}$/.test(value))
    throw new ProcessingError('INVALID_INPUT');
  return value;
}
export function maintenanceBatch(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 25)
    throw new ProcessingError('INVALID_INPUT');
  return value;
}
/** Host/DB role, not an application user's claimed identity, authorizes this CLI. */
export async function authorizeSearchOperator(
  db: Pick<PrismaClient, '$queryRaw'>,
) {
  const result = await db.$queryRaw<{ authorized: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM pg_roles r WHERE r.rolname='qyvra_search_operator'
      AND pg_has_role(current_user,r.oid,'MEMBER')) AS authorized`;
  if (!result[0]?.authorized)
    throw new Error('OPERATOR_AUTHORIZATION_REQUIRED');
}

/** Operator application service. Deliberately NOT registered with any HTTP module. */
export class SearchMaintenanceService {
  private readonly scheduler: SearchMaintenanceScheduler;
  private readonly enrollment: SearchEnrollmentRepository;
  constructor(
    private readonly db: PrismaClient,
    private readonly store: LexicalStore,
    private readonly prefix: string,
  ) {
    this.scheduler = new SearchMaintenanceScheduler(db);
    this.enrollment = new SearchEnrollmentRepository(db);
  }
  async generation(id: string) {
    const generation = await this.db.searchIndexGeneration.findUniqueOrThrow({
      where: { id: maintenanceUuid(id) },
    });
    const target = targetFromGeneration(this.prefix, generation);
    return { generation, target };
  }
  async start(input: {
    id: string;
    kind: MaintenanceKind;
    initiator: string;
    generationId: string;
    userId?: string;
  }): Promise<SearchMaintenanceOperation> {
    maintenanceUuid(input.id);
    maintenanceInitiator(input.initiator);
    if (!['BACKFILL', 'REBUILD', 'RECONCILE', 'CLEANUP'].includes(input.kind))
      throw new ProcessingError('INVALID_INPUT');
    if (input.userId) maintenanceUuid(input.userId);
    if (
      (['BACKFILL', 'RECONCILE'].includes(input.kind) && !input.userId) ||
      (input.kind === 'REBUILD' && input.userId)
    )
      throw new ProcessingError('INVALID_INPUT');
    const { generation } = await this.generation(input.generationId);
    if (
      (input.kind === 'REBUILD' && generation.status !== 'BUILDING') ||
      (input.kind === 'BACKFILL' && generation.status !== 'SERVING')
    )
      throw new ProcessingError('INVALID_TRANSITION');
    const old = await this.db.searchMaintenanceOperation.findUnique({
      where: { id: input.id },
    });
    if (old) {
      if (
        old.kind !== input.kind ||
        old.initiator !== input.initiator ||
        old.generationId !== input.generationId ||
        old.userId !== (input.userId ?? null)
      )
        throw new ProcessingError('CONCURRENT_CHANGE');
      return old;
    }
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(518490510)`;
      return tx.searchMaintenanceOperation.create({
        data: { ...input, userId: input.userId ?? null },
      });
    });
  }
  async inspect(
    id: string,
    initiator: string,
  ): Promise<SearchMaintenanceOperation> {
    const op = await this.db.searchMaintenanceOperation.findUniqueOrThrow({
      where: { id: maintenanceUuid(id) },
    });
    if (op.initiator !== maintenanceInitiator(initiator))
      throw new Error('OPERATOR_IDENTITY_MISMATCH');
    return op;
  }
  async cancel(id: string, initiator: string) {
    await this.inspect(id, initiator);
    return this.db.searchMaintenanceOperation.updateMany({
      where: {
        id,
        status: 'RUNNING',
        OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: new Date() } }],
      },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  }
  async preview(
    generationId: string,
    userId: string | undefined,
    batch: number,
    after?: string,
  ) {
    await this.generation(generationId);
    maintenanceBatch(batch);
    if (userId) maintenanceUuid(userId);
    if (after) maintenanceUuid(after);
    return this.db.document.findMany({
      where: {
        ...eligible,
        ...(userId ? { userId } : {}),
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batch,
      select: { id: true, userId: true },
    });
  }
  async diagnose(
    generationId: string,
    userId: string,
    batch: number,
    after?: string,
  ) {
    const documents = await this.preview(
      generationId,
      maintenanceUuid(userId),
      batch,
      after,
    );
    const findings = [];
    for (const d of documents) {
      const state = await this.db.documentSearchState.findUnique({
        where: { documentId: d.id },
        include: { readyProjection: true },
      });
      const p = state?.readyProjection;
      const issue =
        p?.indexGenerationId === generationId
          ? await this.discrepancy(p.id)
          : null;
      findings.push({
        documentId: d.id,
        classification:
          issue?.code ??
          (p?.indexGenerationId === generationId
            ? 'VERIFIED_MANIFEST'
            : 'ENROLLMENT_OR_PUBLICATION_MISSING'),
        repair: issue ? 'INVALIDATE_AND_REENROLL' : p ? 'NONE' : 'ENROLL',
      });
    }
    return {
      findings,
      afterDocumentId: documents.at(-1)?.id ?? after ?? null,
      hasMore: documents.length === batch,
    };
  }
  private async leaseGuard(
    tx: Prisma.TransactionClient,
    op: SearchMaintenanceOperation,
    token: string,
  ) {
    await tx.$queryRaw`SELECT id FROM search_maintenance_operations WHERE id=${op.id}::uuid FOR UPDATE`;
    const current = await tx.searchMaintenanceOperation.findFirst({
      where: {
        id: op.id,
        status: 'RUNNING',
        leaseToken: token,
        leaseExpiresAt: { gt: new Date() },
      },
    });
    if (!current) throw new ProcessingError('CONCURRENT_CHANGE');
    return current;
  }
  private async snapshot(projectionId: string) {
    const p = await this.db.versionSearchProjection.findUniqueOrThrow({
      where: { id: projectionId },
      include: { generation: true, version: true, extraction: true },
    });
    const d = await this.db.document.findUniqueOrThrow({
      where: { id: p.documentId },
      include: { tags: true },
    });
    const records = lexicalRecords(
      p,
      d,
      p.version,
      d.tags.map((t) => t.tagId),
      p.extraction
        ? {
            ...p.extraction,
            pageSpans: p.extraction
              .pageSpans as unknown as CanonicalContent['pageSpans'],
          }
        : undefined,
    );
    if (lexicalManifest(records).recordsHash !== p.recordsHash)
      throw new SearchStoreFailure('SEARCH_CONFLICT');
    return {
      p,
      records,
      target: targetFromGeneration(this.prefix, p.generation),
    };
  }
  private async discrepancy(projectionId: string) {
    const snapshot = await this.snapshot(projectionId);
    const { p, records, target } = snapshot;
    const scope = {
      documentId: p.documentId,
      documentVersionId: p.documentVersionId,
      projectionId: p.id,
      revision: p.revision,
    };
    const signal = AbortSignal.timeout(60000);
    for (const kind of ['metadata', 'pages'] as const) {
      const index = await this.store.inspect(target, kind, signal);
      if (!index.exists) return { code: 'INDEX_MISSING', projectionId: p.id };
      if (!index.compatible)
        throw new SearchStoreFailure('SEARCH_INDEX_INCOMPATIBLE');
      const expected = records.filter(
        (r) => (r.kind === 'metadata') === (kind === 'metadata'),
      );
      for (let i = 0; i < expected.length; i += 25) {
        const batch = expected.slice(i, i + 25);
        const actual = await this.store.verify(
          target,
          kind,
          p.userId,
          scope,
          batch.map(recordId),
          signal,
        );
        if (actual.length !== batch.length)
          return { code: 'RECORDS_MISSING', projectionId: p.id };
        const byId = new Map(actual.map((r) => [recordId(r), r]));
        if (
          lexicalManifest(batch).recordsHash !==
          lexicalManifest(batch.map((r) => byId.get(recordId(r)) ?? r))
            .recordsHash
        )
          return { code: 'CONTENT_MISMATCH', projectionId: p.id };
      }
    }
    // Realtime mget alone is not publication/visibility proof. Ambiguous search
    // failures (including extra records) stop the scan without destructive repair.
    await this.store.verifyPublication(
      target,
      p.userId,
      scope,
      records,
      signal,
    );
    return null;
  }
  async runBatch(
    id: string,
    initiator: string,
    batch: number,
    signal?: AbortSignal,
  ): Promise<SearchMaintenanceOperation> {
    maintenanceBatch(batch);
    let op = await this.inspect(id, initiator);
    if (op.kind === 'CUTOVER') throw new ProcessingError('INVALID_TRANSITION');
    if (op.status !== 'RUNNING') return op;
    const token = randomUUID();
    const claim = await this.db.searchMaintenanceOperation.updateMany({
      where: {
        id,
        status: 'RUNNING',
        OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: new Date() } }],
      },
      data: {
        leaseToken: token,
        leaseExpiresAt: new Date(Date.now() + leaseMs),
      },
    });
    if (claim.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    try {
      op = await this.inspect(id, initiator);
      const docs = await this.db.document.findMany({
        where: {
          ...(op.userId ? { userId: op.userId } : {}),
          createdAt: { lte: op.createdAt },
          ...(op.afterDocumentId ? { id: { gt: op.afterDocumentId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: batch,
        select: { id: true, userId: true },
      });
      for (const d of docs) {
        if (signal?.aborted) throw new SearchStoreFailure('SEARCH_CANCELLED');
        let issue: { code: string; projectionId: string } | null = null;
        if (op.kind === 'RECONCILE') {
          const state = await this.db.documentSearchState.findUnique({
            where: { documentId: d.id },
            include: { readyProjection: true },
          });
          if (state?.readyProjection?.indexGenerationId === op.generationId)
            issue = await this.discrepancy(state.readyProjection.id);
          else if (state) {
            const failed = await this.db.versionSearchProjection.findFirst({
              where: {
                documentId: d.id,
                userId: d.userId,
                indexGenerationId: op.generationId,
                documentVersionId: state.desiredVersionId,
                revision: state.desiredRevision,
                status: 'FAILED',
              },
            });
            if (failed)
              issue = { code: 'PROCESSING_EXHAUSTED', projectionId: failed.id };
          }
        }
        await this.db.$transaction(
          async (tx) => {
            await this.leaseGuard(tx, op, token);
            let count = 0;
            let blocked = false;
            if (issue) {
              await tx.$queryRaw`SELECT id FROM documents WHERE id=${d.id}::uuid AND user_id=${d.userId}::uuid FOR UPDATE`;
              const failed =
                issue.code === 'PROCESSING_EXHAUSTED'
                  ? await tx.versionSearchProjection.findFirst({
                      where: { id: issue.projectionId, status: 'FAILED' },
                    })
                  : null;
              const state = await tx.documentSearchState.findFirst({
                where: {
                  documentId: d.id,
                  userId: d.userId,
                  ...(failed
                    ? {
                        readyProjectionId: null,
                        desiredVersionId: failed.documentVersionId,
                        desiredRevision: failed.revision,
                      }
                    : { readyProjectionId: issue.projectionId }),
                },
              });
              if (state)
                await this.enrollment.invalidateInTransaction(
                  tx,
                  d.userId,
                  d.id,
                );
            }
            if (op.kind === 'CLEANUP')
              count = await this.scheduler.remove(
                tx,
                d.userId,
                d.id,
                op.generationId,
                op.id,
                true,
              );
            else if (op.kind === 'BACKFILL' || op.kind === 'RECONCILE') {
              const generation =
                await tx.searchIndexGeneration.findUniqueOrThrow({
                  where: { id: op.generationId },
                });
              if (generation.status !== 'SERVING')
                throw new ProcessingError('INVALID_TRANSITION');
              const before = await tx.processingJob.count({
                where: {
                  documentId: d.id,
                  jobType: { in: ['INDEX_SEARCH', 'EXTRACT_SEARCH_TEXT'] },
                },
              });
              await this.enrollment.enrollInTransaction(
                tx,
                d.userId,
                d.id,
                {
                  enabled: true,
                  generationFingerprint: generation.fingerprint,
                },
                new Date(),
                op.id,
              );
              count =
                (await tx.processingJob.count({
                  where: {
                    documentId: d.id,
                    jobType: { in: ['INDEX_SEARCH', 'EXTRACT_SEARCH_TEXT'] },
                  },
                })) - before;
            } else if (op.kind === 'REBUILD') {
              const outcome = await this.scheduler.prepare(
                tx,
                d.userId,
                d.id,
                op.generationId,
                op.id,
              );
              count = outcome === 'SCHEDULED' ? 1 : 0;
              blocked = outcome === 'BLOCKED' || outcome === 'STALE';
            }
            await tx.searchMaintenanceOperation.update({
              where: { id },
              data: {
                afterDocumentId: d.id,
                examined: { increment: 1 },
                scheduled: { increment: count },
                skipped: { increment: count ? 0 : 1 },
                discrepancies: { increment: issue ? 1 : 0 },
                failures: { increment: blocked ? 1 : 0 },
                ...(blocked
                  ? { lastFailureCode: 'SEARCH_PROCESSING_BLOCKED' }
                  : {}),
                leaseExpiresAt: new Date(Date.now() + leaseMs),
              },
            });
          },
          { timeout: 15000 },
        );
      }
      if (docs.length < batch) {
        // SQL scan completion is not publication completion or cutover readiness.
        await this.db.$transaction(async (tx) => {
          await this.leaseGuard(tx, op, token);
          await tx.searchMaintenanceOperation.update({
            where: { id },
            data: {
              status: 'COMPLETED',
              completedAt: new Date(),
              leaseToken: null,
              leaseExpiresAt: null,
              outcome: { scanComplete: true, publicationVerified: false },
            },
          });
        });
      } else
        await this.db.searchMaintenanceOperation.updateMany({
          where: { id, leaseToken: token },
          data: { leaseToken: null, leaseExpiresAt: null },
        });
    } catch (error) {
      const code =
        error instanceof SearchStoreFailure
          ? error.code
          : error instanceof ProcessingError
            ? error.code
            : 'MAINTENANCE_FAILED';
      await this.db.searchMaintenanceOperation.updateMany({
        where: { id, status: 'RUNNING', leaseToken: token },
        data: {
          failures: { increment: 1 },
          lastFailureCode: code,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      throw error;
    }
    return this.inspect(id, initiator);
  }

  /** Bounded exact physical scan: unknown/extra identities are REPORT ONLY. */
  async inspectOwner(
    generationId: string,
    userId: string,
    kind: 'metadata' | 'pages',
    after: readonly (string | number)[] | undefined,
    batch: number,
  ) {
    maintenanceUuid(userId);
    maintenanceBatch(batch);
    const { target, generation } = await this.generation(generationId);
    if (!this.store.scan) throw new SearchStoreFailure('SEARCH_NOT_CONFIGURED');
    const page = await this.store.scan(
      target,
      kind,
      userId,
      after,
      batch,
      AbortSignal.timeout(60000),
    );
    const projections = await this.db.versionSearchProjection.findMany({
      where: {
        id: { in: page.records.map((r) => r.projectionId) },
        userId,
        indexGenerationId: generationId,
      },
      select: {
        id: true,
        status: true,
        expectedRecordIds: true,
        documentId: true,
        documentVersionId: true,
        revision: true,
        metadataHash: true,
        extraction: { select: { contentHash: true } },
      },
    });
    const parents = await this.db.document.findMany({
      where: { id: { in: projections.map((p) => p.documentId) }, userId },
      select: {
        id: true,
        deletedAt: true,
        isArchived: true,
        status: true,
        searchState: { select: { readyProjectionId: true } },
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    return {
      next: page.next,
      findings: page.records.map((r) => {
        const p = projections.find((p) => p.id === r.projectionId);
        const d = parents.find((d) => d.id === p?.documentId);
        return {
          recordId: r.id,
          classification: !p
            ? 'UNKNOWN_PROJECTION'
            : p.documentId !== r.documentId ||
                p.documentVersionId !== r.documentVersionId ||
                p.revision !== r.revision
              ? 'IDENTITY_MISMATCH'
              : !Array.isArray(p.expectedRecordIds) ||
                  !p.expectedRecordIds.includes(r.id)
                ? 'EXTRA_RECORD'
                : generation.status === 'RETIRED'
                  ? 'RETIRED_GENERATION'
                  : !d ||
                      d.deletedAt ||
                      d.isArchived ||
                      ['ARCHIVED', 'DELETING'].includes(d.status) ||
                      d.versions[0]?.id !== p.documentVersionId
                    ? 'STALE_PUBLICATION'
                    : r.sourceHash !==
                        (kind === 'metadata'
                          ? p.metadataHash
                          : p.extraction?.contentHash)
                      ? 'HASH_MISMATCH'
                      : ['REMOVED', 'REMOVAL_PENDING'].includes(p.status)
                        ? 'CLEANUP_PENDING'
                        : p.status === 'BUILDING'
                          ? 'EVENTUAL_PUBLICATION'
                          : generation.status === 'BUILDING'
                            ? 'SHADOW_READY'
                            : d.searchState?.readyProjectionId === p.id
                              ? 'KNOWN_MANIFEST'
                              : 'STALE_PUBLICATION',
          repair: 'REPORT_ONLY' as const,
        };
      }),
    };
  }

  async verifyCutover(generationId: string, progress?: () => Promise<void>) {
    const { generation, target } = await this.generation(generationId);
    if (generation.status !== 'BUILDING')
      throw new ProcessingError('INVALID_TRANSITION');
    const count = await this.db.document.count({ where: eligible });
    if (count > 1000) throw new SearchStoreFailure('SEARCH_CAPACITY');
    const docs = await this.db.document.findMany({
      where: eligible,
      orderBy: { id: 'asc' },
      take: 1000,
      include: {
        searchState: true,
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
      },
    });
    const proofs: {
      documentId: string;
      projectionId: string;
      revision: number;
      recordsHash: string;
    }[] = [];
    for (const kind of ['metadata', 'pages'] as const) {
      await progress?.();
      const index = await this.store.inspect(
        target,
        kind,
        AbortSignal.timeout(60000),
      );
      if (!index.exists) throw new SearchStoreFailure('SEARCH_INDEX_MISSING');
      if (!index.compatible)
        throw new SearchStoreFailure('SEARCH_INDEX_INCOMPATIBLE');
    }
    for (const d of docs) {
      await progress?.();
      const state = d.searchState,
        version = d.versions[0];
      if (!state || !version || state.desiredVersionId !== version.id)
        throw new SearchStoreFailure('SEARCH_CONFLICT');
      const p = await this.db.versionSearchProjection.findFirst({
        where: {
          documentId: d.id,
          userId: d.userId,
          documentVersionId: version.id,
          indexGenerationId: generationId,
          revision: state.desiredRevision,
          status: 'READY',
          metadataReady: true,
          textCoverage: { in: ['READY', 'UNSUPPORTED'] },
        },
      });
      if (!p?.recordsHash || !p.verifiedAt)
        throw new SearchStoreFailure('SEARCH_CONFLICT');
      const snap = await this.snapshot(p.id);
      await this.store.verifyPublication(
        target,
        p.userId,
        {
          documentId: d.id,
          documentVersionId: version.id,
          projectionId: p.id,
          revision: p.revision,
        },
        snap.records,
        AbortSignal.timeout(60000),
      );
      proofs.push({
        documentId: d.id,
        projectionId: p.id,
        revision: p.revision,
        recordsHash: p.recordsHash,
      });
    }
    return { generationId, fingerprint: generation.fingerprint, proofs };
  }
  async cutover(
    id: string,
    initiator: string,
    generationId: string,
    confirmedGenerationId: string,
    signal?: AbortSignal,
  ): Promise<SearchMaintenanceOperation> {
    maintenanceUuid(id);
    maintenanceUuid(generationId);
    maintenanceInitiator(initiator);
    if (generationId !== confirmedGenerationId)
      throw new ProcessingError('INVALID_INPUT');
    const existing = await this.db.searchMaintenanceOperation.findUnique({
      where: { id },
    });
    if (
      existing?.status === 'COMPLETED' &&
      existing.kind === 'CUTOVER' &&
      existing.initiator === initiator &&
      existing.generationId === generationId
    )
      return existing;
    if (
      existing &&
      (existing.kind !== 'CUTOVER' ||
        existing.initiator !== initiator ||
        existing.generationId !== generationId ||
        existing.status !== 'RUNNING')
    )
      throw new ProcessingError('INVALID_TRANSITION');
    const op =
      existing ??
      (await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(518490510)`;
        return tx.searchMaintenanceOperation.create({
          data: { id, kind: 'CUTOVER', initiator, generationId },
        });
      }));
    const token = randomUUID();
    const beat = async () => {
      if (signal?.aborted) throw new SearchStoreFailure('SEARCH_CANCELLED');
      const result = await this.db.searchMaintenanceOperation.updateMany({
        where: {
          id,
          status: 'RUNNING',
          leaseToken: token,
          leaseExpiresAt: { gt: new Date() },
        },
        data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
      });
      if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    };
    const claim = await this.db.searchMaintenanceOperation.updateMany({
      where: {
        id,
        status: 'RUNNING',
        OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: new Date() } }],
      },
      data: {
        leaseToken: token,
        leaseExpiresAt: new Date(Date.now() + leaseMs),
      },
    });
    if (claim.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    try {
      const verified = await this.verifyCutover(generationId, beat);
      await beat();
      return await this.db.$transaction(
        async (tx) => {
          await this.leaseGuard(tx, op, token);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(518490510)`;
          if (
            await tx.searchMaintenanceOperation.count({
              where: { status: 'RUNNING', id: { not: id } },
            })
          )
            throw new ProcessingError('CONCURRENT_CHANGE');
          // Short bounded SQL-only cutover window. Reads continue; catalog mutation
          // table locks prevent new uploads/versions/associations crossing validation.
          await tx.$executeRaw`LOCK TABLE documents, document_versions, document_tags IN SHARE MODE`;
          await tx.$queryRaw`SELECT d.id FROM documents d WHERE d.deleted_at IS NULL AND NOT d.is_archived AND d.status NOT IN ('ARCHIVED','DELETING') AND EXISTS(SELECT 1 FROM document_versions v WHERE v.document_id=d.id) ORDER BY d.id LIMIT 1001 FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM search_index_generations WHERE id=${generationId}::uuid OR status='SERVING' ORDER BY id FOR UPDATE`;
          const old = await tx.searchIndexGeneration.findFirst({
            where: { status: 'SERVING' },
          });
          const target = await tx.searchIndexGeneration.findUniqueOrThrow({
            where: { id: generationId },
          });
          if (
            target.status !== 'BUILDING' ||
            (old && old.fingerprint !== verified.fingerprint)
          )
            throw new ProcessingError('CONCURRENT_CHANGE');
          const docs = await tx.document.findMany({
            where: eligible,
            orderBy: { id: 'asc' },
            take: 1001,
            include: {
              searchState: true,
              versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
            },
          });
          if (docs.length !== verified.proofs.length)
            throw new ProcessingError('CONCURRENT_CHANGE');
          for (const d of docs) {
            const proof = verified.proofs.find((p) => p.documentId === d.id);
            const state = d.searchState;
            if (
              !proof ||
              !state ||
              state.desiredRevision !== proof.revision ||
              state.desiredVersionId !== d.versions[0]?.id
            )
              throw new ProcessingError('CONCURRENT_CHANGE');
            const p = await tx.versionSearchProjection.findUniqueOrThrow({
              where: { id: proof.projectionId },
            });
            const hash = await this.enrollment.metadataHash(
              tx,
              p.documentVersionId,
            );
            if (
              p.status !== 'READY' ||
              p.indexGenerationId !== generationId ||
              p.recordsHash !== proof.recordsHash ||
              p.metadataHash !== hash
            )
              throw new ProcessingError('CONCURRENT_CHANGE');
          }
          // Both pointer changes and generation selection commit atomically in SQL.
          // External verification above is not an Elasticsearch/SQL transaction.
          if (old) {
            await tx.documentSearchState.updateMany({
              where: { readyProjection: { indexGenerationId: old.id } },
              data: { readyProjectionId: null },
            });
            await tx.searchIndexGeneration.update({
              where: { id: old.id },
              data: { status: 'RETIRED' },
            });
          }
          await tx.searchIndexGeneration.update({
            where: { id: generationId },
            data: { status: 'SERVING' },
          });
          for (const proof of verified.proofs)
            await tx.documentSearchState.update({
              where: { documentId: proof.documentId },
              data: { readyProjectionId: proof.projectionId },
            });
          return tx.searchMaintenanceOperation.update({
            where: { id },
            data: {
              leaseToken: null,
              leaseExpiresAt: null,
              status: 'COMPLETED',
              completedAt: new Date(),
              examined: docs.length,
              outcome: {
                previousGenerationId: old?.id ?? null,
                verifiedPublications: docs.length,
                retentionHours: 24,
              },
            },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 30000,
        },
      );
    } catch (error) {
      await this.db.searchMaintenanceOperation.updateMany({
        where: { id, status: 'RUNNING', leaseToken: token },
        data: {
          failures: { increment: 1 },
          lastFailureCode:
            error instanceof SearchStoreFailure
              ? error.code
              : error instanceof ProcessingError
                ? error.code
                : 'CUTOVER_FAILED',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      throw error;
    }
  }
}
