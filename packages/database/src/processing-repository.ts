import {
  AiRunRequest,
  StageCommit,
  eligibleJob,
  lockDocument,
  ensureNextStage,
  retireAiVersions,
  ensureRemoval,
} from './processing-pipeline';
import { reuseAiArtifacts, type AiProcessingStart } from './ai-scheduling';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, ProcessingJob } from './generated/prisma/client';
import {
  createProcessingOutboxIntent,
  createStoredFileVerificationIntent,
  NewStoredFileVerification,
  ProcessingJobStatus,
} from './processing';
import {
  assertFailureCode,
  assertJobTransition,
  assertPositiveDuration,
  ProcessingError,
  retryDelayMs,
} from './processing-rules';

const activeStates = ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'];
const claimableStates: ProcessingJobStatus[] = [
  'PENDING',
  'QUEUED',
  'RETRYING',
];

function boundedLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ProcessingError('INVALID_INPUT');
}

function knownConstraint(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ['P2002', 'P2003'].includes(error.code)
  );
}

/** Shared persistence boundary for future API, relay, and worker processes. */
export class ProcessingRepository {
  constructor(private readonly db: PrismaClient) {}

  /** Caller can include document/version/receipt writes in the same transaction. */
  async createInTransaction(
    tx: Prisma.TransactionClient,
    input: NewStoredFileVerification,
    replay = false,
  ) {
    if (input.jobType !== undefined && input.jobType !== 'VERIFY_STORED_FILE')
      throw new ProcessingError('UNSUPPORTED_JOB_TYPE');
    if (
      ![
        input.userId,
        input.documentId,
        input.documentVersionId,
        input.correlationId,
      ].every((value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value,
        ),
      )
    )
      throw new ProcessingError('INVALID_INPUT');
    if (input.generation !== undefined)
      throw new ProcessingError('INVALID_INPUT');
    if (
      !Number.isSafeInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 100
    )
      throw new ProcessingError('INVALID_INPUT');
    // Uploads already hold the document row lock before scheduling. Keep the
    // same lock order for standalone creation to avoid a cross-path deadlock.
    await tx.$queryRaw`SELECT id FROM documents WHERE id = ${input.documentId}::uuid AND user_id = ${input.userId}::uuid FOR UPDATE`;
    // Serialize equivalent creation, while database uniqueness remains the last guard.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`processing:${input.documentVersionId}:VERIFY_STORED_FILE`}, 0))`;
    const version = await tx.documentVersion.findFirst({
      where: {
        id: input.documentVersionId,
        documentId: input.documentId,
        userId: input.userId,
        document: {
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['ARCHIVED', 'DELETING'] },
        },
      },
      select: { id: true },
    });
    if (!version) throw new ProcessingError('INELIGIBLE_DOCUMENT');
    const current = await tx.documentVersion.findFirst({
      where: { documentId: input.documentId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
    if (current?.id === input.documentVersionId)
      await retireAiVersions(tx, input.documentId, new Date(), current.id);
    const latest = await tx.processingJob.findFirst({
      where: {
        documentVersionId: input.documentVersionId,
        jobType: 'VERIFY_STORED_FILE',
      },
      orderBy: { generation: 'desc' },
      include: { outbox: { where: { dispatchSequence: 1 }, take: 1 } },
    });
    if (latest && activeStates.includes(latest.status)) {
      if (latest.outbox.length !== 1)
        throw new ProcessingError('CONCURRENT_CHANGE');
      return { job: latest, outbox: latest.outbox[0], created: false };
    }
    if (latest && !replay) throw new ProcessingError('DUPLICATE_JOB');
    if (!latest && replay) throw new ProcessingError('INVALID_INPUT');
    try {
      const result = await createStoredFileVerificationIntent(tx, {
        ...input,
        generation: latest ? latest.generation + 1 : 1,
      });
      return { ...result, created: true };
    } catch (error) {
      if (knownConstraint(error)) throw new ProcessingError('DUPLICATE_JOB');
      throw error;
    }
  }

  create(input: NewStoredFileVerification, replay = false) {
    return this.db.$transaction((tx) =>
      this.createInTransaction(tx, input, replay),
    );
  }

  /** Standalone compatibility boundary; callers can also schedule inside their transaction. */
  requestAiProcessing(input: AiRunRequest, reprocess = false) {
    return this.db.$transaction((tx) =>
      this.requestAiProcessingInTransaction(tx, input, reprocess),
    );
  }

  async requestAiProcessingInTransaction(
    tx: Prisma.TransactionClient,
    input: AiRunRequest,
    reprocess = false,
    reuse = false,
    startAt: AiProcessingStart = 'repair',
  ) {
    await lockDocument(tx, input.documentId);
    const version = await tx.documentVersion.findFirst({
      where: {
        id: input.documentVersionId,
        documentId: input.documentId,
        userId: input.userId,
      },
      include: { document: true },
    });
    const latestVersion = await tx.documentVersion.findFirst({
      where: { documentId: input.documentId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
    if (
      !version ||
      latestVersion?.id !== version.id ||
      version.document.deletedAt ||
      version.document.isArchived ||
      ['ARCHIVED', 'DELETING'].includes(version.document.status)
    )
      throw new ProcessingError('INELIGIBLE_DOCUMENT');
    if (
      !Number.isSafeInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 100
    )
      throw new ProcessingError('INVALID_INPUT');
    const { correlationId, maxAttempts, ...snapshot } = input;
    const previous = await tx.aiProcessingRun.findFirst({
      where: { documentVersionId: version.id },
      orderBy: { generation: 'desc' },
    });
    if (previous) {
      const identical = Object.entries(snapshot).every(
        ([key, value]) => previous[key as keyof typeof previous] === value,
      );
      if (identical && (previous.status === 'BUILDING' || !reprocess))
        return previous;
      if (previous.status === 'BUILDING' || !reprocess)
        throw new ProcessingError('INVALID_TRANSITION');
    }
    const run = await tx.aiProcessingRun.create({
      data: { ...snapshot, generation: (previous?.generation ?? 0) + 1 },
    });
    await tx.versionAiState.upsert({
      where: { documentVersionId: version.id },
      create: {
        userId: input.userId,
        documentId: input.documentId,
        documentVersionId: version.id,
        desiredRunId: run.id,
      },
      update: { desiredRunId: run.id },
    });
    let verification = await tx.processingJob.findFirst({
      where: { documentVersionId: version.id, jobType: 'VERIFY_STORED_FILE' },
      orderBy: { generation: 'desc' },
    });
    if (
      !verification ||
      ['FAILED', 'CANCELLED'].includes(verification.status)
    ) {
      verification = (
        await this.createInTransaction(
          tx,
          {
            userId: input.userId,
            documentId: input.documentId,
            documentVersionId: version.id,
            correlationId,
            maxAttempts,
          },
          !!verification,
        )
      ).job;
    }
    if (reuse && verification.status === 'COMPLETED')
      verification = await reuseAiArtifacts(
        tx,
        run,
        verification,
        startAt,
        new Date(),
      );
    await ensureNextStage(tx, verification, new Date());
    return run;
  }

  /** Explicit operator replay after cleanup retry exhaustion; never restores eligibility. */
  replayVectorRemoval(
    userId: string,
    indexManifestId: string,
    now = new Date(),
  ) {
    return this.db.$transaction(async (tx) => {
      const index = await tx.versionVectorIndex.findFirst({
        where: { id: indexManifestId, userId },
      });
      if (!index) throw new ProcessingError('INELIGIBLE_DOCUMENT');
      await lockDocument(tx, index.documentId);
      const current = await tx.versionVectorIndex.findUniqueOrThrow({
        where: { id: index.id },
      });
      if (
        !['REMOVAL_PENDING', 'REMOVED', 'FAILED', 'STALE'].includes(
          current.status,
        ) ||
        (await tx.versionReadyIndex.findFirst({
          where: { vectorIndexId: index.id },
        }))
      )
        throw new ProcessingError('INVALID_TRANSITION');
      await tx.versionVectorIndex.update({
        where: { id: index.id },
        data: { status: 'REMOVAL_PENDING' },
      });
      return ensureRemoval(tx, index.documentVersionId, now, index.id);
    });
  }

  /** Internal rebuild: validates and reuses durable artifacts; no parser/provider is called. */
  requestVectorRebuild(
    userId: string,
    indexManifestId: string,
    now = new Date(),
  ) {
    return this.db.$transaction(async (tx) => {
      const source = await tx.versionVectorIndex.findFirst({
        where: { id: indexManifestId, userId },
        include: { run: true, set: { include: { extraction: true } } },
      });
      if (!source) throw new ProcessingError('INELIGIBLE_DOCUMENT');
      await lockDocument(tx, source.documentId);
      const version = await tx.documentVersion.findUniqueOrThrow({
        where: { id: source.documentVersionId },
        include: { document: true },
      });
      const latestVersion = await tx.documentVersion.findFirst({
        where: { documentId: source.documentId },
        orderBy: { versionNumber: 'desc' },
      });
      if (
        version.userId !== userId ||
        latestVersion?.id !== version.id ||
        version.document.deletedAt ||
        version.document.isArchived ||
        ['ARCHIVED', 'DELETING'].includes(version.document.status)
      )
        throw new ProcessingError('INELIGIBLE_DOCUMENT');
      const previous = await tx.aiProcessingRun.findFirst({
        where: { documentVersionId: version.id },
        orderBy: { generation: 'desc' },
      });
      if (previous?.status === 'BUILDING') {
        const matching = await tx.processingJob.findFirst({
          where: {
            aiRunId: previous.id,
            jobType: 'INDEX_VECTORS',
            chunkSetId: source.chunkSetId,
          },
        });
        if (
          matching &&
          previous.embeddingProfileId === source.embeddingProfileId
        )
          return previous;
        throw new ProcessingError('INVALID_TRANSITION');
      }
      const verification = await tx.processingJob.findFirst({
        where: { documentVersionId: version.id, jobType: 'VERIFY_STORED_FILE' },
        orderBy: { generation: 'desc' },
      });
      if (
        verification?.status !== 'COMPLETED' ||
        !source.set.complete ||
        source.set.extraction.outcome !== 'COMPLETED' ||
        source.set.extraction.sourceChecksum !== version.checksumSha256
      )
        throw new ProcessingError('INVALID_INPUT');
      const sourceRun = source.run;
      const run = await tx.aiProcessingRun.create({
        data: {
          userId,
          documentId: source.documentId,
          documentVersionId: version.id,
          generation: (previous?.generation ?? 0) + 1,
          extractor: sourceRun.extractor,
          extractorVersion: sourceRun.extractorVersion,
          normalizationVersion: sourceRun.normalizationVersion,
          chunkAlgorithm: sourceRun.chunkAlgorithm,
          chunkAlgorithmVersion: sourceRun.chunkAlgorithmVersion,
          tokenizer: sourceRun.tokenizer,
          tokenizerVersion: sourceRun.tokenizerVersion,
          chunkSize: sourceRun.chunkSize,
          chunkOverlap: sourceRun.chunkOverlap,
          embeddingProfileId: source.embeddingProfileId,
        },
      });
      await tx.versionAiState.upsert({
        where: { documentVersionId: version.id },
        create: {
          userId,
          documentId: source.documentId,
          documentVersionId: version.id,
          desiredRunId: run.id,
        },
        update: { desiredRunId: run.id },
      });
      let predecessor = verification;
      for (const type of [
        'EXTRACT_TEXT',
        'GENERATE_CHUNKS',
        'GENERATE_EMBEDDINGS',
      ] as const) {
        const latest = await tx.processingJob.findFirst({
          where: { documentVersionId: version.id, jobType: type },
          orderBy: { generation: 'desc' },
        });
        // These completed jobs reference real immutable artifacts. SQL revalidates
        // configurations, complete chunk sets and every required embedding checkpoint.
        predecessor = await tx.processingJob.create({
          data: {
            userId,
            documentId: source.documentId,
            documentVersionId: version.id,
            aiRunId: run.id,
            predecessorJobId: predecessor.id,
            jobType: type,
            generation: (latest?.generation ?? 0) + 1,
            maxAttempts: 5,
            correlationId: run.id,
            status: 'COMPLETED',
            completedAt: now,
            extractedTextId: source.set.extractedTextId,
            ...(type === 'EXTRACT_TEXT'
              ? {}
              : { chunkSetId: source.chunkSetId }),
          },
        });
      }
      await ensureNextStage(tx, predecessor, now);
      return run;
    });
  }

  /** Bounded reconciliation repairs missed transitions from durable rows, never Redis. */
  async reconcilePipelines(now: Date, limit: number): Promise<number> {
    boundedLimit(limit);
    const runs = await this.db.aiProcessingRun.findMany({
      where: { status: 'BUILDING' },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    let scheduled = 0;
    for (const candidate of runs)
      await this.db.$transaction(async (tx) => {
        await lockDocument(tx, candidate.documentId);
        const run = await tx.aiProcessingRun.findUnique({
          where: { id: candidate.id },
        });
        if (run?.status !== 'BUILDING') return;
        if (
          !(await eligibleJob(tx, {
            documentVersionId: run.documentVersionId,
            documentId: run.documentId,
            userId: run.userId,
            jobType: 'EXTRACT_TEXT',
            aiRunId: run.id,
          }))
        ) {
          await retireAiVersions(
            tx,
            run.documentId,
            now,
            undefined,
            run.documentVersionId,
          );
          return;
        }
        const jobs = await tx.processingJob.findMany({
          where: { aiRunId: run.id },
          orderBy: { createdAt: 'desc' },
        });
        let verification = await tx.processingJob.findFirst({
          where: {
            documentVersionId: run.documentVersionId,
            jobType: 'VERIFY_STORED_FILE',
          },
          orderBy: { generation: 'desc' },
        });
        if (!verification) {
          verification = (
            await this.createInTransaction(tx, {
              userId: run.userId,
              documentId: run.documentId,
              documentVersionId: run.documentVersionId,
              correlationId: run.id,
              maxAttempts: 3,
            })
          ).job;
        }
        const failed =
          jobs.find((job) => job.status === 'FAILED') ??
          (verification?.status === 'FAILED' ? verification : undefined);
        if (failed) {
          await tx.aiProcessingRun.update({
            where: { id: run.id },
            data: {
              status: 'FAILED',
              lastFailureCode: failed.lastFailureCode,
              completedAt: now,
            },
          });
          return;
        }
        const completed =
          jobs.find((job) => job.status === 'COMPLETED') ??
          (await tx.processingJob.findFirst({
            where: {
              documentVersionId: run.documentVersionId,
              jobType: 'VERIFY_STORED_FILE',
              status: 'COMPLETED',
            },
            orderBy: { generation: 'desc' },
          }));
        if (completed) {
          const next = await ensureNextStage(tx, completed, now);
          if (next) {
            const intent = await tx.processingOutbox.findFirst({
              where: {
                processingJobId: next.id,
                dispatchSequence: next.attempts + 1,
              },
            });
            if (!intent && ['PENDING', 'QUEUED'].includes(next.status))
              await createProcessingOutboxIntent(
                tx,
                next,
                next.attempts + 1,
                now,
              );
            scheduled++;
          }
        }
        // Rotate healthy runs so a bounded scan does not starve later candidates.
        await tx.aiProcessingRun.update({
          where: { id: run.id },
          data: { updatedAt: now },
        });
      });
    const pending = await this.db.versionVectorIndex.findMany({
      where: {
        OR: [
          { status: 'REMOVAL_PENDING' },
          { status: { in: ['FAILED', 'STALE'] } },
          {
            status: 'REMOVED',
            updatedAt: { lte: new Date(now.getTime() - 600000) },
          },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    for (const index of pending)
      await this.db.$transaction(async (tx) => {
        await lockDocument(tx, index.documentId);
        const current = await tx.versionVectorIndex.findUnique({
          where: { id: index.id },
        });
        if (
          !current ||
          ['READY', 'BUILDING'].includes(current.status) ||
          (await tx.versionReadyIndex.findFirst({
            where: { vectorIndexId: index.id },
          }))
        )
          return;
        if (current.status !== 'REMOVAL_PENDING')
          await tx.versionVectorIndex.update({
            where: { id: index.id },
            data: { status: 'REMOVAL_PENDING' },
          });
        if (await ensureRemoval(tx, index.documentVersionId, now)) scheduled++;
        await tx.versionVectorIndex.update({
          where: { id: index.id },
          data: { updatedAt: now },
        });
      });
    return scheduled;
  }

  findById(id: string) {
    return this.db.processingJob.findUnique({ where: { id } });
  }

  findByDocument(userId: string, documentId: string, limit: number) {
    boundedLimit(limit);
    return this.db.processingJob.findMany({
      where: { userId, documentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  findByVersion(userId: string, documentId: string, documentVersionId: string) {
    return this.db.processingJob.findMany({
      where: { userId, documentId, documentVersionId },
      orderBy: [{ generation: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** Candidate IDs only: schedulers must still use conditional transitions. */
  async findRetryEligible(now: Date, limit: number): Promise<string[]> {
    boundedLimit(limit);
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT j.id FROM processing_jobs j JOIN documents d ON d.id = j.document_id
      WHERE j.status = 'RETRYING' AND j.available_at <= ${now}
        AND j.attempts < j.max_attempts AND (j.job_type = 'REMOVE_VECTOR_INDEX' OR (d.deleted_at IS NULL
        AND d.is_archived = false AND d.status NOT IN ('ARCHIVED', 'DELETING')))
        AND NOT EXISTS (
          SELECT 1 FROM processing_outbox o
          WHERE o.processing_job_id = j.id
            AND o.event_type = 'processing.execute'
            AND o.dispatch_sequence = j.attempts + 1
        )
      ORDER BY j.available_at, j.id LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async findStaleProcessing(now: Date, limit: number): Promise<string[]> {
    boundedLimit(limit);
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT j.id FROM processing_jobs j JOIN documents d ON d.id = j.document_id
      WHERE j.status = 'PROCESSING' AND j.lease_expires_at <= ${now}
        AND (j.job_type = 'REMOVE_VECTOR_INDEX' OR (d.deleted_at IS NULL AND d.is_archived = false
        AND d.status NOT IN ('ARCHIVED', 'DELETING')))
      ORDER BY j.lease_expires_at, j.id LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  private async requireJob(id: string): Promise<ProcessingJob> {
    const job = await this.db.processingJob.findUnique({ where: { id } });
    if (!job) throw new ProcessingError('NOT_FOUND');
    return job;
  }

  async markQueued(
    id: string,
    dispatchSequence: number,
    now: Date,
  ): Promise<ProcessingJob> {
    return this.db.$transaction(async (tx) => {
      const initial = await this.requireJob(id);
      await lockDocument(tx, initial.documentId);
      const job = await tx.processingJob.findUniqueOrThrow({ where: { id } });
      if (
        ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(
          job.status,
        )
      )
        return job;
      if (!(await eligibleJob(tx, job)))
        throw new ProcessingError('INELIGIBLE_DOCUMENT');
      assertJobTransition(job.status as ProcessingJobStatus, 'QUEUED');
      if (job.availableAt > now || dispatchSequence !== job.attempts + 1)
        throw new ProcessingError('INVALID_TRANSITION');
      const outbox = await tx.processingOutbox.findUnique({
        where: {
          processingJobId_eventType_dispatchSequence: {
            processingJobId: id,
            eventType: 'processing.execute',
            dispatchSequence,
          },
        },
        select: { status: true },
      });
      if (outbox?.status !== 'PUBLISHED')
        throw new ProcessingError('INVALID_TRANSITION');
      const result = await tx.processingJob.updateMany({
        where: {
          id,
          status: job.status,
          attempts: job.attempts,
          availableAt: { lte: now },
        },
        data: { status: 'QUEUED' },
      });
      if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
      return tx.processingJob.findUniqueOrThrow({ where: { id } });
    });
  }

  /** A successful PostgreSQL claim, not a broker delivery, spends one attempt. */
  async claim(id: string, now: Date, leaseMs: number): Promise<ProcessingJob> {
    assertPositiveDuration(leaseMs);
    return this.db.$transaction(async (tx) => {
      const initial = await this.requireJob(id);
      await lockDocument(tx, initial.documentId);
      const job = await tx.processingJob.findUniqueOrThrow({ where: { id } });
      if (!(await eligibleJob(tx, job)))
        throw new ProcessingError(
          job.jobType === 'VERIFY_STORED_FILE'
            ? 'CONCURRENT_CHANGE'
            : 'INELIGIBLE_DOCUMENT',
        );
      assertJobTransition(job.status as ProcessingJobStatus, 'PROCESSING');
      if (
        !claimableStates.includes(job.status as ProcessingJobStatus) ||
        job.attempts >= job.maxAttempts ||
        job.availableAt > now
      )
        throw new ProcessingError('INVALID_TRANSITION');
      const token = randomUUID();
      const result = await tx.processingJob.updateMany({
        where: {
          id,
          status: job.status,
          attempts: job.attempts,
          availableAt: { lte: now },
          leaseToken: null,
        },
        data: {
          status: 'PROCESSING',
          attempts: job.attempts + 1,
          startedAt: now,
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          heartbeatAt: now,
          lastFailureCode: null,
        },
      });
      if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
      if (job.jobType === 'EXTRACT_TEXT')
        await tx.documentVersion.update({
          where: { id: job.documentVersionId },
          data: { extractionStatus: 'PROCESSING' },
        });
      return tx.processingJob.findUniqueOrThrow({ where: { id } });
    });
  }

  async heartbeat(
    id: string,
    leaseToken: string,
    now: Date,
    leaseMs: number,
  ): Promise<ProcessingJob> {
    assertPositiveDuration(leaseMs);
    return this.db.$transaction(async (tx) => {
      const initial = await this.requireJob(id);
      await lockDocument(tx, initial.documentId);
      const job = await tx.processingJob.findUniqueOrThrow({ where: { id } });
      if (!(await eligibleJob(tx, job)))
        throw new ProcessingError('INELIGIBLE_DOCUMENT');
      const result = await tx.processingJob.updateMany({
        where: {
          id,
          status: 'PROCESSING',
          leaseToken,
          leaseExpiresAt: { gt: now },
        },
        data: {
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        },
      });
      if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
      return tx.processingJob.findUniqueOrThrow({ where: { id } });
    });
  }

  /** Durable intermediate batch write under the same document/job/lease fences. */
  async checkpoint(
    id: string,
    leaseToken: string,
    now: Date,
    commit: StageCommit,
  ): Promise<void> {
    const began = performance.now();
    const initial = await this.requireJob(id);
    await this.db.$transaction(async (tx) => {
      await lockDocument(tx, initial.documentId);
      await tx.$queryRaw`SELECT id FROM processing_jobs WHERE id = ${id}::uuid FOR UPDATE`;
      const job = await tx.processingJob.findUniqueOrThrow({ where: { id } });
      if (!(await eligibleJob(tx, job)))
        throw new ProcessingError('INELIGIBLE_DOCUMENT');
      const currentTime = () =>
        new Date(now.getTime() + Math.floor(performance.now() - began));
      if (
        !['GENERATE_EMBEDDINGS', 'INDEX_VECTORS'].includes(job.jobType) ||
        job.status !== 'PROCESSING' ||
        job.leaseToken !== leaseToken ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt <= currentTime()
      )
        throw new ProcessingError('CONCURRENT_CHANGE');
      await commit(tx, job);
      if (job.leaseExpiresAt <= currentTime())
        throw new ProcessingError('CONCURRENT_CHANGE');
    });
  }

  async complete(
    id: string,
    leaseToken: string,
    now: Date,
    commit?: StageCommit,
  ): Promise<ProcessingJob> {
    const began = performance.now();
    const currentTime = () =>
      new Date(now.getTime() + Math.floor(performance.now() - began));
    const initial = await this.requireJob(id);
    // Publishing a bounded complete chunk set can exceed Prisma's 5 s default.
    // Never extend the execution lease; the inner fences still reject stale commits.
    const timeout =
      initial.jobType === 'GENERATE_CHUNKS'
        ? Math.max(
            1,
            Math.min(
              60000,
              (initial.leaseExpiresAt?.getTime() ?? now.getTime() + 5000) -
                currentTime().getTime(),
            ),
          )
        : 5000;
    return this.db.$transaction(
      async (tx) => {
        await lockDocument(tx, initial.documentId);
        const job = await tx.processingJob.findUniqueOrThrow({ where: { id } });
        if (job.status === 'COMPLETED') {
          await ensureNextStage(tx, job, now);
          return job;
        }
        assertJobTransition(job.status as ProcessingJobStatus, 'COMPLETED');
        if (!(await eligibleJob(tx, job)))
          throw new ProcessingError('INELIGIBLE_DOCUMENT');
        if (
          job.status !== 'PROCESSING' ||
          job.leaseToken !== leaseToken ||
          !job.leaseExpiresAt ||
          job.leaseExpiresAt <= now
        )
          throw new ProcessingError('CONCURRENT_CHANGE');
        // Account for lock/callback time while retaining the caller's clock contract.
        if (job.leaseExpiresAt <= currentTime())
          throw new ProcessingError('CONCURRENT_CHANGE');
        await tx.$queryRaw`SELECT id FROM processing_jobs WHERE id = ${id}::uuid FOR UPDATE`;
        const outputs = commit ? await commit(tx, job) : {};
        const fencedAt = currentTime();
        if (job.leaseExpiresAt <= fencedAt)
          throw new ProcessingError('CONCURRENT_CHANGE');
        const result = await tx.processingJob.updateMany({
          where: {
            id,
            status: 'PROCESSING',
            leaseToken,
            leaseExpiresAt: { gt: fencedAt },
          },
          data: {
            ...outputs,
            status: 'COMPLETED',
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            lastFailureCode: null,
          },
        });
        if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
        const completed = await tx.processingJob.findUniqueOrThrow({
          where: { id },
        });
        await ensureNextStage(tx, completed, now);
        if (completed.jobType === 'REMOVE_VECTOR_INDEX')
          await ensureRemoval(tx, completed.documentVersionId, now);
        return completed;
      },
      { timeout },
    );
  }

  async fail(
    id: string,
    leaseToken: string,
    now: Date,
    failureCode: string,
    retryable: boolean,
    retryAfterMs?: number,
  ): Promise<ProcessingJob> {
    return this.recordFailure(
      id,
      leaseToken,
      now,
      failureCode,
      retryable,
      false,
      retryAfterMs,
    );
  }

  /** Only an expired matching lease may be recovered; this does not run a scanner. */
  async recoverInterrupted(
    id: string,
    leaseToken: string,
    now: Date,
  ): Promise<ProcessingJob> {
    return this.recordFailure(
      id,
      leaseToken,
      now,
      'WORKER_INTERRUPTED',
      true,
      true,
    );
  }

  private async recordFailure(
    id: string,
    leaseToken: string,
    now: Date,
    failureCode: string,
    retryable: boolean,
    expired: boolean,
    retryAfterMs = 0,
  ): Promise<ProcessingJob> {
    assertFailureCode(failureCode);
    if (
      !Number.isFinite(retryAfterMs) ||
      retryAfterMs < 0 ||
      retryAfterMs > 3600000
    )
      throw new ProcessingError('INVALID_INPUT');
    return this.db.$transaction(async (tx) => {
      const initial = await this.requireJob(id);
      await lockDocument(tx, initial.documentId);
      const job = await tx.processingJob.findUniqueOrThrow({ where: { id } });
      if (!(await eligibleJob(tx, job)))
        throw new ProcessingError('INELIGIBLE_DOCUMENT');
      assertJobTransition(
        job.status as ProcessingJobStatus,
        retryable && job.attempts < job.maxAttempts ? 'RETRYING' : 'FAILED',
      );
      const willRetry = retryable && job.attempts < job.maxAttempts;
      const result = await tx.processingJob.updateMany({
        where: {
          id,
          status: 'PROCESSING',
          attempts: job.attempts,
          leaseToken,
          leaseExpiresAt: expired ? { lte: now } : { gt: now },
        },
        data: {
          status: willRetry ? 'RETRYING' : 'FAILED',
          availableAt: willRetry
            ? new Date(
                now.getTime() +
                  Math.max(retryDelayMs(id, job.attempts), retryAfterMs),
              )
            : job.availableAt,
          completedAt: willRetry ? null : now,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          lastFailureCode: failureCode,
        },
      });
      if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
      if (!willRetry) {
        const state = await tx.versionAiState.findUnique({
          where: { documentVersionId: job.documentVersionId },
        });
        const runId =
          job.aiRunId ??
          (job.jobType === 'VERIFY_STORED_FILE' ? state?.desiredRunId : null);
        if (runId)
          await tx.aiProcessingRun.updateMany({
            where: { id: runId, status: 'BUILDING' },
            data: {
              status: 'FAILED',
              lastFailureCode: failureCode,
              completedAt: now,
            },
          });
        if (job.vectorIndexId && job.jobType === 'INDEX_VECTORS')
          await tx.versionVectorIndex.updateMany({
            where: { id: job.vectorIndexId, status: 'BUILDING' },
            data: { status: 'FAILED', lastFailureCode: failureCode },
          });
      }
      if (job.jobType === 'EXTRACT_TEXT')
        await tx.documentVersion.update({
          where: { id: job.documentVersionId },
          data: {
            extractionStatus: willRetry
              ? 'PENDING'
              : [
                    'UNSUPPORTED_FORMAT',
                    'OCR_REQUIRED',
                    'PDF_ENCRYPTED',
                  ].includes(failureCode)
                ? 'UNSUPPORTED'
                : 'FAILED',
          },
        });
      return tx.processingJob.findUniqueOrThrow({ where: { id } });
    });
  }

  /** Due retry creates one new durable publication intent, without publishing it. */
  async scheduleRetryDispatch(id: string, now: Date) {
    return this.db.$transaction(async (tx) => {
      const initial = await this.requireJob(id);
      await lockDocument(tx, initial.documentId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`processing-retry:${id}`}, 0))`;
      await tx.$queryRaw`SELECT id FROM processing_jobs WHERE id = ${id}::uuid FOR UPDATE`;
      const job = await tx.processingJob.findUnique({ where: { id } });
      if (!job) throw new ProcessingError('NOT_FOUND');
      if (
        job.status !== 'RETRYING' ||
        job.availableAt > now ||
        job.attempts >= job.maxAttempts
      )
        throw new ProcessingError('INVALID_TRANSITION');
      if (!(await eligibleJob(tx, job)))
        throw new ProcessingError('INELIGIBLE_DOCUMENT');
      const dispatchSequence = job.attempts + 1;
      const existing = await tx.processingOutbox.findUnique({
        where: {
          processingJobId_eventType_dispatchSequence: {
            processingJobId: id,
            eventType: 'processing.execute',
            dispatchSequence,
          },
        },
      });
      if (existing) return existing;
      const firstIntent = await tx.processingOutbox.findFirst({
        where: { processingJobId: id },
        orderBy: { dispatchSequence: 'asc' },
        select: { schemaVersion: true },
      });
      const { outbox } = await createProcessingOutboxIntent(
        tx,
        job,
        dispatchSequence,
        now,
        firstIntent?.schemaVersion === 2 || job.jobType !== 'VERIFY_STORED_FILE'
          ? 2
          : 1,
      );
      return outbox;
    });
  }

  async cancelUnfinishedForDocument(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    now: Date,
  ): Promise<number> {
    const result = await tx.processingJob.updateMany({
      where: {
        userId,
        documentId,
        jobType: { not: 'REMOVE_VECTOR_INDEX' },
        status: { in: activeStates },
      },
      data: {
        status: 'CANCELLED',
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      },
    });
    await retireAiVersions(tx, documentId, now);
    const versions = await tx.documentVersion.findMany({
      where: { documentId, userId },
      select: { id: true },
    });
    for (const version of versions) await ensureRemoval(tx, version.id, now);
    return result.count;
  }

  findPendingOutbox(now: Date, limit: number) {
    boundedLimit(limit);
    return this.db.processingOutbox.findMany({
      where: {
        status: 'PENDING',
        availableAt: { lte: now },
        OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }],
      },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  async claimOutbox(id: string, now: Date, leaseMs: number) {
    assertPositiveDuration(leaseMs);
    const row = await this.db.processingOutbox.findUnique({ where: { id } });
    if (!row) throw new ProcessingError('NOT_FOUND');
    const token = randomUUID();
    const result = await this.db.processingOutbox.updateMany({
      where: {
        id,
        status: 'PENDING',
        publicationAttempts: row.publicationAttempts,
        availableAt: { lte: now },
        OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }],
      },
      data: {
        claimToken: token,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
        publicationAttempts: row.publicationAttempts + 1,
      },
    });
    if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    return this.db.processingOutbox.findUniqueOrThrow({ where: { id } });
  }

  async markOutboxPublished(id: string, claimToken: string, now: Date) {
    const result = await this.db.processingOutbox.updateMany({
      where: { id, status: 'PENDING', claimToken, claimExpiresAt: { gt: now } },
      data: {
        status: 'PUBLISHED',
        publishedAt: now,
        claimToken: null,
        claimExpiresAt: null,
        lastFailureCode: null,
      },
    });
    if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    return this.db.processingOutbox.findUniqueOrThrow({ where: { id } });
  }

  async recordOutboxFailure(
    id: string,
    claimToken: string,
    now: Date,
    code: string,
    retryAt: Date,
  ) {
    assertFailureCode(code);
    if (retryAt <= now) throw new ProcessingError('INVALID_INPUT');
    const result = await this.db.processingOutbox.updateMany({
      where: { id, status: 'PENDING', claimToken, claimExpiresAt: { gt: now } },
      data: {
        claimToken: null,
        claimExpiresAt: null,
        availableAt: retryAt,
        lastFailureCode: code,
      },
    });
    if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    return this.db.processingOutbox.findUniqueOrThrow({ where: { id } });
  }
}
