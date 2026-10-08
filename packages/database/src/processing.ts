import { randomUUID } from 'node:crypto';
import { Prisma, ProcessingJob } from './generated/prisma/client';

// Stored as checked strings, following the existing document status convention.
export const processingJobStatuses = [
  'PENDING',
  'QUEUED',
  'PROCESSING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type ProcessingJobStatus = (typeof processingJobStatuses)[number];

// Persistence/domain vocabulary only. V1 delivery and creation remain integrity-only.
export const processingJobTypes = [
  'VERIFY_STORED_FILE',
  'EXTRACT_TEXT',
  'GENERATE_CHUNKS',
  'GENERATE_EMBEDDINGS',
  'INDEX_VECTORS',
  'REMOVE_VECTOR_INDEX',
] as const;
export type ProcessingJobType = (typeof processingJobTypes)[number];

export const processingOutboxStatuses = ['PENDING', 'PUBLISHED'] as const;
export type ProcessingOutboxStatus = (typeof processingOutboxStatuses)[number];

export interface ProcessingMessageV1 {
  readonly schemaVersion: 1;
  readonly messageId: string;
  readonly type: 'processing.execute';
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly jobId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly jobType: 'VERIFY_STORED_FILE';
  readonly dispatchSequence: number;
}

export interface ProcessingMessageV2 extends Omit<
  ProcessingMessageV1,
  'schemaVersion' | 'jobType'
> {
  readonly schemaVersion: 2;
  readonly jobType: ProcessingJobType;
}
export type ProcessingMessage = ProcessingMessageV1 | ProcessingMessageV2;

export interface NewStoredFileVerification {
  readonly jobType?: string;
  readonly userId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly correlationId: string;
  readonly maxAttempts: number;
  /** Explicitly advanced only after the preceding generation became terminal. */
  readonly generation?: number;
}

/**
 * Add version-specific work and its first publication intent to an existing
 * transaction. The caller must commit the transaction; this function never
 * publishes or changes the document lifecycle.
 */
export async function createStoredFileVerificationIntent(
  tx: Prisma.TransactionClient,
  input: NewStoredFileVerification,
) {
  if (
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 100
  ) {
    throw new Error('Invalid processing attempt limit.');
  }
  if (input.jobType !== undefined && input.jobType !== 'VERIFY_STORED_FILE')
    throw new Error('Unsupported processing job type.');
  if (
    input.generation !== undefined &&
    (!Number.isSafeInteger(input.generation) || input.generation < 1)
  )
    throw new Error('Invalid processing generation.');

  const jobId = randomUUID();
  const occurredAt = new Date();
  const job = await tx.processingJob.create({
    data: {
      id: jobId,
      userId: input.userId,
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      jobType: 'VERIFY_STORED_FILE',
      generation: input.generation ?? 1,
      maxAttempts: input.maxAttempts,
      correlationId: input.correlationId,
      availableAt: occurredAt,
    },
  });

  const { outbox, envelope } = await createProcessingOutboxIntent(
    tx,
    job,
    1,
    occurredAt,
  );
  return { job, outbox, envelope };
}

/** Persist a new dispatch intent; the caller owns the transaction and dispatch rules. */
export async function createProcessingOutboxIntent(
  tx: Prisma.TransactionClient,
  job: ProcessingJob,
  dispatchSequence: number,
  occurredAt: Date,
  schemaVersion: 1 | 2 = job.jobType === 'VERIFY_STORED_FILE' ? 1 : 2,
) {
  if (schemaVersion === 1 && job.jobType !== 'VERIFY_STORED_FILE')
    throw new Error('Unsupported v1 processing job type.');
  if (!processingJobTypes.includes(job.jobType as ProcessingJobType))
    throw new Error('Unsupported processing job type.');
  if (!Number.isSafeInteger(dispatchSequence) || dispatchSequence < 1)
    throw new Error('Invalid dispatch sequence.');
  const messageId = randomUUID();
  const envelope = {
    schemaVersion,
    messageId,
    type: 'processing.execute',
    occurredAt: occurredAt.toISOString(),
    correlationId: job.correlationId,
    jobId: job.id,
    documentId: job.documentId,
    documentVersionId: job.documentVersionId,
    jobType: job.jobType as ProcessingJobType,
    dispatchSequence,
  } as ProcessingMessage;
  const outbox = await tx.processingOutbox.create({
    data: {
      id: messageId,
      processingJobId: job.id,
      eventType: envelope.type,
      schemaVersion: envelope.schemaVersion,
      dispatchSequence: envelope.dispatchSequence,
      payload: { ...envelope },
      occurredAt,
      correlationId: job.correlationId,
      availableAt: occurredAt,
    },
  });
  return { outbox, envelope };
}
