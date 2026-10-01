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
        AND j.attempts < j.max_attempts AND d.deleted_at IS NULL
        AND d.is_archived = false AND d.status NOT IN ('ARCHIVED', 'DELETING')
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
        AND d.deleted_at IS NULL AND d.is_archived = false
        AND d.status NOT IN ('ARCHIVED', 'DELETING')
      ORDER BY j.lease_expires_at, j.id LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  private async requireJob(id: string): Promise<ProcessingJob> {
    const job = await this.db.processingJob.findUnique({ where: { id } });
    if (!job) throw new ProcessingError('NOT_FOUND');
    return job;
  }

  private async updated(id: string, count: number): Promise<ProcessingJob> {
    if (count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    return this.requireJob(id);
  }

  async markQueued(
    id: string,
    dispatchSequence: number,
    now: Date,
  ): Promise<ProcessingJob> {
    const job = await this.requireJob(id);
    if (
      ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(
        job.status,
      )
    )
      return job;
    assertJobTransition(job.status as ProcessingJobStatus, 'QUEUED');
    if (job.availableAt > now || dispatchSequence !== job.attempts + 1)
      throw new ProcessingError('INVALID_TRANSITION');
    const outbox = await this.db.processingOutbox.findUnique({
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
    const result = await this.db.processingJob.updateMany({
      where: {
        id,
        status: job.status,
        attempts: job.attempts,
        availableAt: { lte: now },
        document: {
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['ARCHIVED', 'DELETING'] },
        },
      },
      data: { status: 'QUEUED' },
    });
    return this.updated(id, result.count);
  }

  /** A successful PostgreSQL claim, not a broker delivery, spends one attempt. */
  async claim(id: string, now: Date, leaseMs: number): Promise<ProcessingJob> {
    assertPositiveDuration(leaseMs);
    const job = await this.requireJob(id);
    assertJobTransition(job.status as ProcessingJobStatus, 'PROCESSING');
    if (
      !claimableStates.includes(job.status as ProcessingJobStatus) ||
      job.attempts >= job.maxAttempts ||
      job.availableAt > now
    )
      throw new ProcessingError('INVALID_TRANSITION');
    const token = randomUUID();
    const result = await this.db.processingJob.updateMany({
      where: {
        id,
        status: job.status,
        attempts: job.attempts,
        availableAt: { lte: now },
        leaseToken: null,
        document: {
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['ARCHIVED', 'DELETING'] },
        },
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
    return this.requireJob(id);
  }

  async heartbeat(
    id: string,
    leaseToken: string,
    now: Date,
    leaseMs: number,
  ): Promise<ProcessingJob> {
    assertPositiveDuration(leaseMs);
    const result = await this.db.processingJob.updateMany({
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
    return this.updated(id, result.count);
  }

  async complete(
    id: string,
    leaseToken: string,
    now: Date,
  ): Promise<ProcessingJob> {
    const job = await this.requireJob(id);
    if (job.status === 'COMPLETED') return job;
    assertJobTransition(job.status as ProcessingJobStatus, 'COMPLETED');
    const result = await this.db.processingJob.updateMany({
      where: {
        id,
        status: 'PROCESSING',
        leaseToken,
        leaseExpiresAt: { gt: now },
        document: {
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['ARCHIVED', 'DELETING'] },
        },
      },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastFailureCode: null,
      },
    });
    return this.updated(id, result.count);
  }

  async fail(
    id: string,
    leaseToken: string,
    now: Date,
    failureCode: string,
    retryable: boolean,
  ): Promise<ProcessingJob> {
    return this.recordFailure(
      id,
      leaseToken,
      now,
      failureCode,
      retryable,
      false,
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
  ): Promise<ProcessingJob> {
    assertFailureCode(failureCode);
    const job = await this.requireJob(id);
    assertJobTransition(
      job.status as ProcessingJobStatus,
      retryable && job.attempts < job.maxAttempts ? 'RETRYING' : 'FAILED',
    );
    const willRetry = retryable && job.attempts < job.maxAttempts;
    const result = await this.db.processingJob.updateMany({
      where: {
        id,
        status: 'PROCESSING',
        attempts: job.attempts,
        leaseToken,
        leaseExpiresAt: expired ? { lte: now } : { gt: now },
        document: {
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['ARCHIVED', 'DELETING'] },
        },
      },
      data: {
        status: willRetry ? 'RETRYING' : 'FAILED',
        availableAt: willRetry
          ? new Date(now.getTime() + retryDelayMs(id, job.attempts))
          : job.availableAt,
        completedAt: willRetry ? null : now,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastFailureCode: failureCode,
      },
    });
    return this.updated(id, result.count);
  }

  /** Due retry creates one new durable publication intent, without publishing it. */
  async scheduleRetryDispatch(id: string, now: Date) {
    return this.db.$transaction(async (tx) => {
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
      const eligibleDocument = await tx.document.findFirst({
        where: {
          id: job.documentId,
          userId: job.userId,
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['ARCHIVED', 'DELETING'] },
        },
        select: { id: true },
      });
      if (!eligibleDocument) throw new ProcessingError('INELIGIBLE_DOCUMENT');
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
      const { outbox } = await createProcessingOutboxIntent(
        tx,
        job,
        dispatchSequence,
        now,
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
      where: { userId, documentId, status: { in: activeStates } },
      data: {
        status: 'CANCELLED',
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      },
    });
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
