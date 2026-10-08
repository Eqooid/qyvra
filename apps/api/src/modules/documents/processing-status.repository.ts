import { Injectable } from '@nestjs/common';
import { Prisma } from '@qyvra/database';
import { PrismaService } from '../../database/prisma.service';
import { ConfigurationService } from '../../configuration/configuration.module';

const statusJob = {
  id: true,
  jobType: true,
  aiRunId: true,
  status: true,
  attempts: true,
  maxAttempts: true,
  availableAt: true,
  startedAt: true,
  completedAt: true,
  lastFailureCode: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProcessingJobSelect;

export interface ProcessingStatusSnapshot {
  aiReadiness?:
    'READY' | 'PROCESSING' | 'FAILED' | 'UNAVAILABLE' | 'UNSUPPORTED';
  id: string;
  documentId: string;
  aiState?: {
    desiredRun: {
      id: string;
      generation: number;
      status: string;
      jobs: Array<{ jobType: string; status: string }>;
    } | null;
  } | null;
  processingJobs: Array<{
    id: string;
    jobType: string;
    aiRunId?: string | null;
    status: string;
    attempts: number;
    maxAttempts: number;
    availableAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    lastFailureCode: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

/** One owned, visible version and its newest generation for each job type. */
@Injectable()
export class ProcessingStatusRepository {
  constructor(
    private readonly database: PrismaService,
    private readonly configuration: ConfigurationService,
  ) {}

  async findOwnedVersion(
    userId: string,
    documentId: string,
    versionId: string,
  ): Promise<ProcessingStatusSnapshot | null> {
    const version = await this.database.client.documentVersion.findFirst({
      where: {
        id: versionId,
        documentId,
        userId,
        document: { deletedAt: null, status: { not: 'DELETING' } },
      },
      select: {
        id: true,
        documentId: true,
        mimeType: true,
        document: { select: { isArchived: true } },
        aiState: {
          select: {
            desiredRun: {
              select: {
                id: true,
                generation: true,
                status: true,
                jobs: { select: { jobType: true, status: true } },
              },
            },
          },
        },
        processingJobs: {
          distinct: ['jobType'],
          orderBy: [{ jobType: 'asc' }, { generation: 'desc' }],
          select: statusJob,
        },
      },
    });
    if (!version) return null;
    let aiReadiness: ProcessingStatusSnapshot['aiReadiness'] = 'UNAVAILABLE';
    if (!version.document.isArchived) {
      const ready = this.configuration.semanticSearch.enabled
        ? await this.database.client.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT r.vector_index_id AS id FROM version_ready_indexes r
        JOIN version_vector_indexes i ON i.id = r.vector_index_id
        JOIN chunk_sets s ON s.id = i.chunk_set_id
        JOIN document_versions v ON v.id = r.document_version_id
        JOIN documents d ON d.id = v.document_id
        JOIN ai_serving_profile a ON a.embedding_profile_id = r.embedding_profile_id
        JOIN embedding_profiles p ON p.id = a.embedding_profile_id
        WHERE r.user_id = ${userId}::uuid AND d.user_id = ${userId}::uuid
          AND v.id = ${versionId}::uuid AND d.id = ${documentId}::uuid
          AND i.embedding_profile_id = r.embedding_profile_id AND i.status = 'READY' AND s.complete
          AND p.fingerprint = ${this.configuration.embedding.profileFingerprint ?? ''}
          AND d.deleted_at IS NULL AND NOT d.is_archived AND d.status <> 'DELETING'
          AND NOT EXISTS (SELECT 1 FROM document_versions n WHERE n.document_id = v.document_id AND n.version_number > v.version_number)
        LIMIT 1`)
        : [];
      aiReadiness = ready.length
        ? 'READY'
        : version.mimeType !== 'application/pdf'
          ? 'UNSUPPORTED'
          : version.aiState?.desiredRun?.status === 'BUILDING'
            ? 'PROCESSING'
            : version.aiState?.desiredRun?.status === 'FAILED'
              ? 'FAILED'
              : 'UNAVAILABLE';
    }
    return { ...version, aiReadiness };
  }
}
