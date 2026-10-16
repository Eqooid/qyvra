import { Prisma, PrismaClient } from './generated/prisma/client';
import { createProcessingOutboxIntent, isSearchJobType } from './processing';
import { lockDocument } from './processing-pipeline';
import { ProcessingError } from './processing-rules';
import {
  assertSearchRevision,
  assertSearchUuid,
  searchGenerationFingerprint,
  searchProjectionId,
  type SearchGenerationIdentity,
  type NewSearchJob,
} from './search';

const activeStates = ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'];
/** Opt-in persistence primitives only: not registered in application enrollment. */
export class SearchPersistenceRepository {
  constructor(private readonly db: PrismaClient) {}

  async createGeneration(
    input: SearchGenerationIdentity & {
      generation: number;
      metadataIndexName: string;
      pageIndexName: string;
    },
  ) {
    assertSearchRevision(input.generation);
    const fingerprint = searchGenerationFingerprint(input);
    if (
      ![input.metadataIndexName, input.pageIndexName].every((name) =>
        /^qyvra-search-[a-z0-9][a-z0-9_-]{0,180}$/.test(name),
      ) ||
      input.metadataIndexName === input.pageIndexName
    )
      throw new ProcessingError('INVALID_INPUT');
    const data = {
      generation: input.generation,
      schemaVersion: input.schemaVersion,
      mappingVersion: input.mappingVersion,
      analyzerVersion: input.analyzerVersion,
      extractor: input.extractor,
      extractorVersion: input.extractorVersion,
      normalizationVersion: input.normalizationVersion,
      segmentationVersion: input.segmentationVersion,
      fingerprint,
      metadataIndexName: input.metadataIndexName,
      pageIndexName: input.pageIndexName,
    };
    const row = await this.db.searchIndexGeneration.upsert({
      where: {
        fingerprint_generation: { fingerprint, generation: input.generation },
      },
      create: data,
      update: {},
    });
    if (
      Object.entries(data).some(
        ([key, value]) => row[key as keyof typeof row] !== value,
      )
    )
      throw new ProcessingError('CONCURRENT_CHANGE');
    return row;
  }

  private async requireCurrentVersion(
    tx: Prisma.TransactionClient,
    input: { userId: string; documentId: string; documentVersionId: string },
  ) {
    [input.userId, input.documentId, input.documentVersionId].forEach(
      assertSearchUuid,
    );
    await lockDocument(tx, input.documentId);
    const version = await tx.documentVersion.findFirst({
      where: { documentId: input.documentId, userId: input.userId },
      orderBy: { versionNumber: 'desc' },
      include: { document: true },
    });
    if (
      !version ||
      version.id !== input.documentVersionId ||
      version.document.deletedAt ||
      version.document.isArchived ||
      ['ARCHIVED', 'DELETING'].includes(version.document.status)
    )
      throw new ProcessingError('INELIGIBLE_DOCUMENT');
    return version;
  }

  async initializeStateInTransaction(
    tx: Prisma.TransactionClient,
    input: { userId: string; documentId: string; documentVersionId: string },
  ) {
    await this.requireCurrentVersion(tx, input);
    const state = await tx.documentSearchState.upsert({
      where: { documentId: input.documentId },
      create: {
        documentId: input.documentId,
        userId: input.userId,
        desiredVersionId: input.documentVersionId,
      },
      update: {},
    });
    if (
      state.userId !== input.userId ||
      state.desiredVersionId !== input.documentVersionId
    )
      throw new ProcessingError('CONCURRENT_CHANGE');
    return state;
  }

  /** Caller owns mutation+revision atomicity. T03 will wire this into mutations. */
  async advanceRevisionInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      documentId: string;
      documentVersionId: string;
      expectedRevision: number;
    },
  ) {
    assertSearchRevision(input.expectedRevision);
    if (input.expectedRevision === 2147483647)
      throw new ProcessingError('INVALID_INPUT');
    await this.requireCurrentVersion(tx, input);
    const result = await tx.documentSearchState.updateMany({
      where: {
        documentId: input.documentId,
        userId: input.userId,
        desiredRevision: input.expectedRevision,
      },
      data: {
        desiredVersionId: input.documentVersionId,
        desiredRevision: input.expectedRevision + 1,
        readyProjectionId: null,
      },
    });
    if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    return tx.documentSearchState.findUniqueOrThrow({
      where: { documentId: input.documentId },
    });
  }

  async createProjectionInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      documentId: string;
      documentVersionId: string;
      indexGenerationId: string;
      revision: number;
      metadataHash: string;
    },
  ) {
    assertSearchUuid(input.indexGenerationId);
    assertSearchRevision(input.revision);
    if (!/^[0-9a-f]{64}$/.test(input.metadataHash))
      throw new ProcessingError('INVALID_INPUT');
    await this.requireCurrentVersion(tx, input);
    const state = await tx.documentSearchState.findFirst({
      where: {
        documentId: input.documentId,
        userId: input.userId,
        desiredVersionId: input.documentVersionId,
        desiredRevision: input.revision,
      },
    });
    const generation = await tx.searchIndexGeneration.findUnique({
      where: { id: input.indexGenerationId },
    });
    if (!state || !generation || generation.status === 'RETIRED')
      throw new ProcessingError('INELIGIBLE_DOCUMENT');
    const id = searchProjectionId(
      input.documentVersionId,
      input.indexGenerationId,
      input.revision,
    );
    const row = await tx.versionSearchProjection.upsert({
      where: { id },
      create: { ...input, id },
      update: {},
    });
    if (row.metadataHash !== input.metadataHash)
      throw new ProcessingError('CONCURRENT_CHANGE');
    return row;
  }

  /** Job+outbox creation shares the existing document lock and transaction. */
  async createJobInTransaction(
    tx: Prisma.TransactionClient,
    input: NewSearchJob,
    replay = false,
  ) {
    [
      input.userId,
      input.documentId,
      input.documentVersionId,
      input.searchProjectionId,
      input.correlationId,
    ].forEach(assertSearchUuid);
    if (input.predecessorJobId) assertSearchUuid(input.predecessorJobId);
    if (
      !isSearchJobType(input.jobType) ||
      !Number.isInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 100
    )
      throw new ProcessingError('INVALID_INPUT');
    await lockDocument(tx, input.documentId);
    const projection = await tx.versionSearchProjection.findFirst({
      where: {
        id: input.searchProjectionId,
        userId: input.userId,
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
      },
      include: { generation: true },
    });
    if (!projection) throw new ProcessingError('INELIGIBLE_DOCUMENT');
    if (input.jobType === 'REMOVE_SEARCH_INDEX') {
      if (!['REMOVAL_PENDING', 'REMOVED'].includes(projection.status))
        throw new ProcessingError('INVALID_TRANSITION');
    } else {
      await this.requireCurrentVersion(tx, input);
      const state = await tx.documentSearchState.findFirst({
        where: {
          documentId: input.documentId,
          userId: input.userId,
          desiredVersionId: input.documentVersionId,
          desiredRevision: projection.revision,
        },
      });
      if (
        !state ||
        projection.status !== 'BUILDING' ||
        projection.generation.status === 'RETIRED'
      )
        throw new ProcessingError('INELIGIBLE_DOCUMENT');
    }
    const latest = await tx.processingJob.findFirst({
      where: {
        documentVersionId: input.documentVersionId,
        jobType: input.jobType,
      },
      orderBy: { generation: 'desc' },
      include: { outbox: { where: { dispatchSequence: 1 } } },
    });
    if (latest && activeStates.includes(latest.status)) {
      if (
        latest.searchProjectionId !== input.searchProjectionId ||
        latest.predecessorJobId !== (input.predecessorJobId ?? null) ||
        latest.outbox.length !== 1
      )
        throw new ProcessingError('CONCURRENT_CHANGE');
      return { job: latest, outbox: latest.outbox[0], created: false };
    }
    if (latest?.searchProjectionId === input.searchProjectionId && !replay)
      throw new ProcessingError('DUPLICATE_JOB');
    if (
      replay &&
      (!latest || latest.searchProjectionId !== input.searchProjectionId)
    )
      throw new ProcessingError('INVALID_INPUT');
    const job = await tx.processingJob.create({
      data: {
        ...input,
        generation: (latest?.generation ?? 0) + 1,
      },
    });
    const { outbox, envelope } = await createProcessingOutboxIntent(
      tx,
      job,
      1,
      new Date(),
    );
    return { job, outbox, envelope, created: true };
  }

  findProjection(userId: string, id: string) {
    assertSearchUuid(userId);
    assertSearchUuid(id);
    return this.db.versionSearchProjection.findFirst({ where: { id, userId } });
  }

  async createChangeInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      userId: string;
      reason: 'CATEGORY_DELETED' | 'TAG_DELETED';
      resourceId: string;
    },
  ) {
    [input.id, input.userId, input.resourceId].forEach(assertSearchUuid);
    if (!['CATEGORY_DELETED', 'TAG_DELETED'].includes(input.reason))
      throw new ProcessingError('INVALID_INPUT');
    // Prisma's emulated compound-key upsert can race. A native conflict-ignoring
    // insert followed by the owned unique lookup converges without a new lock.
    await tx.searchProjectionChange.createMany({
      data: [input],
      skipDuplicates: true,
    });
    const row = await tx.searchProjectionChange.findUnique({
      where: {
        userId_reason_resourceId: {
          userId: input.userId,
          reason: input.reason,
          resourceId: input.resourceId,
        },
      },
    });
    if (!row) throw new ProcessingError('CONCURRENT_CHANGE');
    // Stable resource identity coalesces retries even if caller regenerated an event UUID.
    return row;
  }

  async advanceChangeInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      userId: string;
      expectedAfterDocumentId: string | null;
      afterDocumentId: string | null;
      complete: boolean;
    },
  ) {
    [input.id, input.userId].forEach(assertSearchUuid);
    if (input.expectedAfterDocumentId)
      assertSearchUuid(input.expectedAfterDocumentId);
    if (input.afterDocumentId) assertSearchUuid(input.afterDocumentId);
    const result = await tx.searchProjectionChange.updateMany({
      where: {
        id: input.id,
        userId: input.userId,
        status: 'PENDING',
        afterDocumentId: input.expectedAfterDocumentId,
      },
      data: {
        afterDocumentId: input.afterDocumentId,
        ...(input.complete
          ? { status: 'COMPLETED', completedAt: new Date() }
          : {}),
      },
    });
    if (result.count !== 1) throw new ProcessingError('CONCURRENT_CHANGE');
    return tx.searchProjectionChange.findUniqueOrThrow({
      where: { id: input.id },
    });
  }
}
