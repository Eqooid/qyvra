import {
  ConflictException,
  Injectable,
  OnModuleInit,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, ProcessingRepository, ProcessingError } from '@qyvra/database';
import { randomUUID } from 'node:crypto';
import { ConfigurationService } from '../../configuration/configuration.module';
import { PrismaService } from '../../database/prisma.service';
import { PDF_EXTRACTOR } from '../../infrastructure/extraction/pdf-parser';
import { CHUNK_STRATEGY } from './deterministic-chunker';

export const reprocessingModes = [
  'repair',
  'extraction',
  'chunking',
  'embedding',
  'index',
] as const;
export type ReprocessingMode = (typeof reprocessingModes)[number];

/** The single enrollment boundary. Database only: no file, provider, broker or Qdrant calls. */
@Injectable()
export class AiIngestionService implements OnModuleInit {
  private readonly processing: ProcessingRepository;
  constructor(
    private readonly database: PrismaService,
    private readonly configuration: ConfigurationService,
  ) {
    this.processing = new ProcessingRepository(database.client);
  }

  async onModuleInit() {
    if (
      this.configuration.aiIngestion?.enabled &&
      !(await this.database.client.embeddingProfile.findUnique({
        where: {
          fingerprint: this.configuration.aiIngestion.profileFingerprint,
        },
        select: { id: true },
      }))
    )
      throw new Error(
        'AI ingestion profile must be provisioned before enabling enrollment.',
      );
  }

  async scheduleInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
    versionId: string,
    mode: ReprocessingMode = 'repair',
    key?: string,
    dryRun = false,
  ) {
    if (!this.configuration.aiIngestion?.enabled) {
      if (key)
        throw new ServiceUnavailableException('AI ingestion is disabled.');
      return null;
    }
    await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
    const version = await tx.documentVersion.findFirst({
      where: { id: versionId, documentId, userId },
      include: { document: true },
    });
    if (!version || version.document.deletedAt) throw new NotFoundException();
    const current = await tx.documentVersion.findFirst({
      where: { documentId, userId },
      orderBy: { versionNumber: 'desc' },
    });
    if (
      current?.id !== versionId ||
      version.document.isArchived ||
      ['ARCHIVED', 'DELETING'].includes(version.document.status)
    )
      throw new ConflictException('Version is not eligible for AI processing.');
    if (version.mimeType !== 'application/pdf') {
      if (key)
        throw new ConflictException('Only PDF versions support AI processing.');
      return null;
    }
    if (key) {
      const receipt = await tx.aiReprocessingRequest.findUnique({
        where: { documentVersionId_key: { documentVersionId: versionId, key } },
        include: { run: true },
      });
      if (receipt) {
        if (receipt.mode !== mode)
          throw new ConflictException('Idempotency key has a different mode.');
        return this.receipt(receipt.run);
      }
    }
    const profile = await tx.embeddingProfile.findUnique({
      where: { fingerprint: this.configuration.aiIngestion.profileFingerprint },
    });
    if (!profile)
      throw new ServiceUnavailableException(
        'AI ingestion profile is not provisioned.',
      );
    const snapshot = {
      userId,
      documentId,
      documentVersionId: versionId,
      ...PDF_EXTRACTOR,
      ...CHUNK_STRATEGY,
      chunkSize: this.configuration.chunking.chunkSize,
      chunkOverlap: this.configuration.chunking.chunkOverlap,
      embeddingProfileId: profile.id,
    };
    const previous = await tx.aiProcessingRun.findFirst({
      where: { documentVersionId: versionId },
      orderBy: { generation: 'desc' },
    });
    const identical =
      previous &&
      Object.entries(snapshot).every(
        ([field, value]) => previous[field as keyof typeof previous] === value,
      );
    if (
      previous?.status === 'BUILDING' &&
      (!identical || (key && mode !== 'repair'))
    ) {
      if (dryRun)
        return {
          runId: previous.id,
          status: 'SKIPPED_ACTIVE',
          generation: previous.generation,
        };
      throw new ConflictException('Processing generation is already active.');
    }
    const ready =
      identical &&
      previous.status === 'READY' &&
      (await tx.versionReadyIndex.findFirst({
        where: {
          documentVersionId: versionId,
          embeddingProfileId: profile.id,
          index: { aiRunId: previous.id, status: 'READY' },
        },
      }));
    // Automatic repair never resets exhausted/deterministic failures. An owned explicit request can.
    const reuseRun =
      identical &&
      (previous.status === 'BUILDING' ||
        (mode === 'repair' &&
          (ready || (previous.status === 'FAILED' && !key))));
    if (dryRun)
      return {
        runId: previous?.id ?? null,
        status: reuseRun ? 'SKIPPED' : 'WOULD_SCHEDULE',
        generation: previous?.generation ?? 0,
      };
    let run;
    try {
      run = reuseRun
        ? previous
        : await this.processing.requestAiProcessingInTransaction(
            tx,
            { ...snapshot, correlationId: randomUUID(), maxAttempts: 5 },
            true,
            true,
            mode,
          );
    } catch (error) {
      if (error instanceof ProcessingError)
        throw new ConflictException(
          'Processing generation is already active or ineligible.',
        );
      throw error;
    }
    if (key)
      await tx.aiReprocessingRequest.create({
        data: {
          userId,
          documentId,
          documentVersionId: versionId,
          key,
          mode,
          runId: run!.id,
        },
      });
    return this.receipt(run!);
  }

  reprocess(
    userId: string,
    documentId: string,
    versionId: string,
    mode: ReprocessingMode,
    key: string,
  ) {
    return this.database.client.$transaction((tx) =>
      this.scheduleInTransaction(tx, userId, documentId, versionId, mode, key),
    );
  }

  /** UUID keyset cursor is bounded and reproducible; all eligibility is rechecked under lock. */
  async backfillBatch(limit: number, after?: string, dryRun = false) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Backfill batch must be between 1 and 100.');
    if (
      after &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        after,
      )
    )
      throw new Error('Invalid backfill cursor.');
    if (!this.configuration.aiIngestion?.enabled)
      throw new ServiceUnavailableException('AI ingestion is disabled.');
    const candidates = await this.database.client.$queryRaw<
      { id: string; documentId: string; userId: string }[]
    >(Prisma.sql`
      SELECT v.id, v.document_id AS "documentId", v.user_id AS "userId"
      FROM document_versions v JOIN documents d ON d.id = v.document_id AND d.user_id = v.user_id
      WHERE d.deleted_at IS NULL AND NOT d.is_archived AND d.status NOT IN ('ARCHIVED','DELETING')
        AND v.mime_type = 'application/pdf'
        AND NOT EXISTS (SELECT 1 FROM document_versions n WHERE n.document_id = v.document_id AND n.version_number > v.version_number)
        ${after ? Prisma.sql`AND v.id > ${after}::uuid` : Prisma.empty}
      ORDER BY v.id ASC LIMIT ${limit}
    `);
    const results = [];
    for (const candidate of candidates) {
      try {
        const result = await this.database.client.$transaction(async (tx) => {
          const preview = await this.scheduleInTransaction(
            tx,
            candidate.userId,
            candidate.documentId,
            candidate.id,
            'repair',
            undefined,
            true,
          );
          if (dryRun || preview?.status !== 'WOULD_SCHEDULE') return preview;
          const scheduled = await this.scheduleInTransaction(
            tx,
            candidate.userId,
            candidate.documentId,
            candidate.id,
          );
          return { ...scheduled, status: 'SCHEDULED' };
        });
        results.push({ versionId: candidate.id, ...result });
      } catch (error) {
        if (!(
          error instanceof NotFoundException ||
          error instanceof ConflictException
        ))
          throw error;
        results.push({ versionId: candidate.id, status: 'SKIPPED_INELIGIBLE' });
      }
    }
    return {
      scanned: candidates.length,
      scheduled: results.filter((result) => result.status === 'SCHEDULED')
        .length,
      wouldSchedule: results.filter(
        (result) => result.status === 'WOULD_SCHEDULE',
      ).length,
      skipped: results.filter((result) => result.status?.startsWith('SKIPPED'))
        .length,
      cursor: candidates[candidates.length - 1]?.id ?? after ?? null,
      hasMore: candidates.length === limit,
      results,
    };
  }

  private receipt(run: { id: string; generation: number; status: string }) {
    return { runId: run.id, generation: run.generation, status: run.status };
  }
}
