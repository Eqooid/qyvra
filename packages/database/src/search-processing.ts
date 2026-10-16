import {
  ProcessingJob,
  Prisma,
  VersionSearchProjection,
} from './generated/prisma/client';
import { createProcessingOutboxIntent } from './processing';
import { eligibleJob } from './processing-pipeline';
import { searchProjectionId } from './search';

/** Called under the document lock, after the predecessor is durably terminal. */
export async function advanceSearchBranch(
  tx: Prisma.TransactionClient,
  job: ProcessingJob,
  now: Date,
) {
  if (!job.searchProjectionId || !(await eligibleJob(tx, job))) return;
  const p = await tx.versionSearchProjection.findUniqueOrThrow({
    where: { id: job.searchProjectionId },
  });
  if (
    job.jobType === 'EXTRACT_SEARCH_TEXT' &&
    ['COMPLETED', 'FAILED'].includes(job.status)
  ) {
    if (p.textCoverage !== 'PENDING') return;
    const coverage =
      job.status === 'COMPLETED'
        ? 'READY'
        : ['OCR_REQUIRED', 'PDF_ENCRYPTED', 'UNSUPPORTED_FORMAT'].includes(
              job.lastFailureCode ?? '',
            )
          ? 'UNSUPPORTED'
          : 'FAILED';
    // A full-text-first shadow is still BUILDING: attach canonical output before
    // its first immutable publication, without advancing the serving revision.
    if (p.status === 'BUILDING') {
      await tx.versionSearchProjection.update({
        where: { id: p.id },
        data: {
          textCoverage: coverage,
          extractedTextId:
            job.status === 'COMPLETED' ? job.extractedTextId : null,
        },
      });
      await createSearchJob(tx, job, p.id, 'INDEX_SEARCH', now);
      return;
    }
    await replaceProjection(
      tx,
      job,
      p,
      coverage,
      now,
      job.status === 'COMPLETED' ? job.extractedTextId : null,
    );
    return;
  }
  if (
    job.jobType !== 'INDEX_SEARCH' ||
    job.status !== 'COMPLETED' ||
    p.textCoverage !== 'PENDING'
  )
    return;
  const previous = await tx.processingJob.findFirst({
    where: { searchProjectionId: p.id, jobType: 'EXTRACT_SEARCH_TEXT' },
    orderBy: { generation: 'desc' },
  });
  if (previous) {
    if (previous.status === 'COMPLETED' || previous.status === 'FAILED')
      await advanceSearchBranch(tx, previous, now);
    return;
  }
  const integrity = await tx.processingJob.findFirst({
    where: {
      documentVersionId: job.documentVersionId,
      userId: job.userId,
      jobType: 'VERIFY_STORED_FILE',
    },
    orderBy: { generation: 'desc' },
  });
  if (integrity?.status === 'FAILED') {
    await replaceProjection(tx, job, p, 'FAILED', now);
    return;
  }
  if (!integrity || integrity.status !== 'COMPLETED') return;
  await createSearchJob(
    tx,
    job,
    p.id,
    'EXTRACT_SEARCH_TEXT',
    now,
    integrity.id,
  );
}

async function createSearchJob(
  tx: Prisma.TransactionClient,
  source: ProcessingJob,
  projectionId: string,
  jobType: 'INDEX_SEARCH' | 'EXTRACT_SEARCH_TEXT',
  now: Date,
  predecessorJobId?: string,
) {
  const latest = await tx.processingJob.findFirst({
    where: { documentVersionId: source.documentVersionId, jobType },
    orderBy: { generation: 'desc' },
  });
  if (
    latest &&
    ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'].includes(latest.status)
  )
    return;
  const next = await tx.processingJob.create({
    data: {
      userId: source.userId,
      documentId: source.documentId,
      documentVersionId: source.documentVersionId,
      searchProjectionId: projectionId,
      jobType,
      correlationId: source.correlationId,
      generation: (latest?.generation ?? 0) + 1,
      maxAttempts: source.maxAttempts,
      availableAt: now,
      predecessorJobId,
    },
  });
  await createProcessingOutboxIntent(tx, next, 1, now);
}

/** Integrity and search are independent branches; never insert search into the AI successor map. */
export async function resumeSearchAfterIntegrity(
  tx: Prisma.TransactionClient,
  job: ProcessingJob,
  now: Date,
) {
  if (
    job.jobType !== 'VERIFY_STORED_FILE' ||
    !['COMPLETED', 'FAILED'].includes(job.status)
  )
    return;
  const state = await tx.documentSearchState.findUnique({
    where: { documentId: job.documentId },
  });
  if (!state) return;
  const indexed = await tx.processingJob.findFirst({
    where: {
      documentVersionId: job.documentVersionId,
      jobType: 'INDEX_SEARCH',
      status: 'COMPLETED',
      searchProjection: { revision: state.desiredRevision },
    },
    orderBy: { generation: 'desc' },
  });
  if (indexed) await advanceSearchBranch(tx, indexed, now);
}

async function replaceProjection(
  tx: Prisma.TransactionClient,
  job: ProcessingJob,
  p: VersionSearchProjection,
  coverage: string,
  now: Date,
  extractedTextId: string | null = null,
) {
  const id = searchProjectionId(
    job.documentVersionId,
    p.indexGenerationId,
    p.revision + 1,
  );
  await tx.documentSearchState.update({
    where: { documentId: job.documentId },
    data: { desiredRevision: p.revision + 1, readyProjectionId: null },
  });
  await tx.versionSearchProjection.update({
    where: { id: p.id },
    data: { status: 'REMOVAL_PENDING' },
  });
  await tx.versionSearchProjection.create({
    data: {
      id,
      userId: job.userId,
      documentId: job.documentId,
      documentVersionId: job.documentVersionId,
      indexGenerationId: p.indexGenerationId,
      revision: p.revision + 1,
      metadataHash: p.metadataHash,
      textCoverage: coverage,
      extractedTextId,
    },
  });
  await createSearchJob(tx, job, id, 'INDEX_SEARCH', now);
}
