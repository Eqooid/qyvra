import { Prisma, ProcessingJob } from './generated/prisma/client';
import { createProcessingOutboxIntent, ProcessingJobType } from './processing';

export interface AiRunRequest {
  userId: string;
  documentId: string;
  documentVersionId: string;
  correlationId: string;
  maxAttempts: number;
  extractor: string;
  extractorVersion: string;
  normalizationVersion: string;
  chunkAlgorithm: string;
  chunkAlgorithmVersion: string;
  tokenizer: string;
  tokenizerVersion: string;
  chunkSize: number;
  chunkOverlap: number;
  embeddingProfileId: string;
}

/** Short database-only publication callback. Never perform provider/storage IO here. */
export type StageCommit = (
  tx: Prisma.TransactionClient,
  job: ProcessingJob,
) => Promise<{
  extractedTextId?: string;
  chunkSetId?: string;
  vectorIndexId?: string;
}>;

export const aiTasks = [
  'EXTRACT_TEXT',
  'GENERATE_CHUNKS',
  'GENERATE_EMBEDDINGS',
  'INDEX_VECTORS',
] as const;
const nextStage: Partial<Record<ProcessingJobType, ProcessingJobType>> = {
  VERIFY_STORED_FILE: 'EXTRACT_TEXT',
  EXTRACT_TEXT: 'GENERATE_CHUNKS',
  GENERATE_CHUNKS: 'GENERATE_EMBEDDINGS',
  GENERATE_EMBEDDINGS: 'INDEX_VECTORS',
};

export async function lockDocument(
  tx: Prisma.TransactionClient,
  documentId: string,
) {
  await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId}::uuid FOR UPDATE`;
}

/** Ownership comes from the row, never a broker-supplied user identifier. */
export async function eligibleJob(
  tx: Prisma.TransactionClient,
  job: Pick<
    ProcessingJob,
    'documentVersionId' | 'documentId' | 'userId' | 'jobType' | 'aiRunId'
  >,
) {
  const version = await tx.documentVersion.findFirst({
    where: {
      id: job.documentVersionId,
      documentId: job.documentId,
      userId: job.userId,
    },
    include: { document: true, aiState: true },
  });
  if (!version) return false;
  if (job.jobType === 'REMOVE_VECTOR_INDEX') return true;
  if (
    version.document.deletedAt ||
    version.document.isArchived ||
    ['ARCHIVED', 'DELETING'].includes(version.document.status)
  )
    return false;
  if (job.jobType === 'VERIFY_STORED_FILE') return true;
  const latest = await tx.documentVersion.findFirst({
    where: { documentId: job.documentId },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  });
  const run = job.aiRunId
    ? await tx.aiProcessingRun.findUnique({ where: { id: job.aiRunId } })
    : null;
  return (
    latest?.id === version.id &&
    version.aiState?.desiredRunId === job.aiRunId &&
    run?.status === 'BUILDING'
  );
}

/** Called under the document lock. Existing SQL constraints validate artifact lineage. */
export async function ensureNextStage(
  tx: Prisma.TransactionClient,
  predecessor: ProcessingJob,
  now: Date,
) {
  if (predecessor.status !== 'COMPLETED') return null;
  if (predecessor.jobType === 'VERIFY_STORED_FILE') {
    const latest = await tx.processingJob.findFirst({
      where: {
        documentVersionId: predecessor.documentVersionId,
        jobType: predecessor.jobType,
      },
      orderBy: { generation: 'desc' },
      select: { id: true },
    });
    if (latest?.id !== predecessor.id) return null;
  }
  const state = await tx.versionAiState.findUnique({
    where: { documentVersionId: predecessor.documentVersionId },
  });
  const runId = predecessor.aiRunId ?? state?.desiredRunId;
  if (!runId || state?.desiredRunId !== runId) return null;
  const run = await tx.aiProcessingRun.findUniqueOrThrow({
    where: { id: runId },
  });
  if (run.status !== 'BUILDING') return null;
  if (
    !(await eligibleJob(tx, {
      ...predecessor,
      jobType: 'EXTRACT_TEXT',
      aiRunId: runId,
    }))
  )
    return null;
  const type = nextStage[predecessor.jobType as ProcessingJobType];
  if (!type) {
    if (predecessor.jobType === 'INDEX_VECTORS' && predecessor.vectorIndexId) {
      const previous = await tx.versionReadyIndex.findUnique({
        where: {
          documentVersionId_embeddingProfileId: {
            documentVersionId: run.documentVersionId,
            embeddingProfileId: run.embeddingProfileId,
          },
        },
      });
      await tx.versionReadyIndex.upsert({
        where: {
          documentVersionId_embeddingProfileId: {
            documentVersionId: run.documentVersionId,
            embeddingProfileId: run.embeddingProfileId,
          },
        },
        create: {
          userId: run.userId,
          documentId: run.documentId,
          documentVersionId: run.documentVersionId,
          embeddingProfileId: run.embeddingProfileId,
          vectorIndexId: predecessor.vectorIndexId,
        },
        update: { vectorIndexId: predecessor.vectorIndexId },
      });
      if (previous && previous.vectorIndexId !== predecessor.vectorIndexId) {
        const oldIndex = await tx.versionVectorIndex.update({
          where: { id: previous.vectorIndexId },
          data: { status: 'REMOVAL_PENDING' },
        });
        await tx.aiProcessingRun.updateMany({
          where: { id: oldIndex.aiRunId, status: 'READY' },
          data: { status: 'SUPERSEDED' },
        });
        await ensureRemoval(tx, run.documentVersionId, now);
      }
      await tx.aiProcessingRun.update({
        where: { id: run.id },
        data: { status: 'READY', completedAt: now },
      });
    }
    return null;
  }
  const existing = await tx.processingJob.findFirst({
    where: { aiRunId: runId, jobType: type },
    orderBy: { generation: 'desc' },
  });
  if (existing) return existing;
  const latest = await tx.processingJob.findFirst({
    where: { documentVersionId: run.documentVersionId, jobType: type },
    orderBy: { generation: 'desc' },
  });
  let vectorIndexId: string | null = null;
  if (type === 'INDEX_VECTORS') {
    const set = await tx.chunkSet.findUniqueOrThrow({
      where: { id: predecessor.chunkSetId! },
    });
    const index = await tx.versionVectorIndex.create({
      data: {
        userId: run.userId,
        documentId: run.documentId,
        documentVersionId: run.documentVersionId,
        aiRunId: run.id,
        chunkSetId: set.id,
        embeddingProfileId: run.embeddingProfileId,
        collectionGeneration: 1,
        collectionName: `qyvra_chunks_${run.embeddingProfileId.replaceAll('-', '')}_v1`,
        expectedPointCount: set.chunkCount,
      },
    });
    vectorIndexId = index.id;
  }
  const job = await tx.processingJob.create({
    data: {
      userId: run.userId,
      documentId: run.documentId,
      documentVersionId: run.documentVersionId,
      aiRunId: run.id,
      predecessorJobId: predecessor.id,
      jobType: type,
      generation: (latest?.generation ?? 0) + 1,
      maxAttempts: predecessor.maxAttempts,
      correlationId: predecessor.correlationId,
      availableAt: now,
      extractedTextId: predecessor.extractedTextId,
      chunkSetId: predecessor.chunkSetId,
      vectorIndexId,
    },
  });
  await createProcessingOutboxIntent(tx, job, 1, now);
  if (type === 'EXTRACT_TEXT') {
    await tx.versionAiState.update({
      where: { documentVersionId: run.documentVersionId },
      data: { lastExtractionJobId: job.id },
    });
    await tx.documentVersion.update({
      where: { id: run.documentVersionId },
      data: { extractionStatus: 'PENDING' },
    });
  }
  return job;
}

/** Revoke immediately; remote cleanup is a separate durable job and may retry. */
export async function retireAiVersions(
  tx: Prisma.TransactionClient,
  documentId: string,
  now: Date,
  exceptVersionId?: string,
  onlyVersionId?: string,
) {
  const where = {
    documentId,
    ...(onlyVersionId
      ? { documentVersionId: onlyVersionId }
      : exceptVersionId
        ? { documentVersionId: { not: exceptVersionId } }
        : {}),
  };
  await tx.processingJob.updateMany({
    where: {
      ...where,
      jobType: { in: [...aiTasks] },
      status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'] },
    },
    data: {
      status: 'CANCELLED',
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    },
  });
  await tx.aiProcessingRun.updateMany({
    where: { ...where, status: 'BUILDING' },
    data: { status: 'CANCELLED', completedAt: now },
  });
  await tx.versionReadyIndex.deleteMany({ where });
  await tx.versionVectorIndex.updateMany({
    where: {
      ...where,
      status: { in: ['BUILDING', 'READY', 'STALE', 'FAILED'] },
    },
    data: { status: 'REMOVAL_PENDING' },
  });
}

export async function ensureRemoval(
  tx: Prisma.TransactionClient,
  documentVersionId: string,
  now: Date,
  replayIndexId?: string,
) {
  const active = await tx.processingJob.findFirst({
    where: {
      documentVersionId,
      jobType: 'REMOVE_VECTOR_INDEX',
      status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'] },
    },
  });
  if (active) return active;
  const indexes = await tx.versionVectorIndex.findMany({
    where: {
      documentVersionId,
      status: 'REMOVAL_PENDING',
      ...(replayIndexId ? { id: replayIndexId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const index of indexes) {
    // An exhausted cleanup remains visible; explicit operator replay is required.
    const previous = await tx.processingJob.findFirst({
      where: { vectorIndexId: index.id, jobType: 'REMOVE_VECTOR_INDEX' },
      orderBy: { generation: 'desc' },
    });
    if (
      previous &&
      previous.status !== 'COMPLETED' &&
      !(previous.status === 'FAILED' && index.id === replayIndexId)
    )
      continue;
    const latest = await tx.processingJob.findFirst({
      where: { documentVersionId, jobType: 'REMOVE_VECTOR_INDEX' },
      orderBy: { generation: 'desc' },
    });
    const job = await tx.processingJob.create({
      data: {
        userId: index.userId,
        documentId: index.documentId,
        documentVersionId,
        vectorIndexId: index.id,
        jobType: 'REMOVE_VECTOR_INDEX',
        generation: (latest?.generation ?? 0) + 1,
        correlationId: index.aiRunId,
        maxAttempts: 5,
        availableAt: now,
      },
    });
    await createProcessingOutboxIntent(tx, job, 1, now);
    return job;
  }
  return null;
}
