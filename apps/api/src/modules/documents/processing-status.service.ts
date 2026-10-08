import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PROCESSING_PROGRESS,
  ProcessingProgressStore,
} from '../../infrastructure/progress/processing-progress';
import { ProcessingStatusRepository } from './processing-status.repository';
import {
  ProcessingStatusView,
  PublicFailureCode,
  PublicProcessingState,
  publicProcessingStates,
} from './processing-status.dto';

const timestamp = (date: Date | null): string | null =>
  date?.toISOString() ?? null;

function safeFailure(code: string | null): PublicFailureCode | null {
  switch (code) {
    case 'FILE_CHECKSUM_MISMATCH':
    case 'FILE_SIZE_MISMATCH':
      return 'FILE_INTEGRITY_FAILED';
    case 'FILE_NOT_FOUND':
      return 'STORED_FILE_MISSING';
    case 'STORAGE_READ_FAILED':
    case 'WORKER_INTERRUPTED':
      return 'TEMPORARY_PROCESSING_ERROR';
    case null:
      return null;
    default:
      return 'PROCESSING_ERROR';
  }
}

/** Maps durable, owner-scoped job state to an infrastructure-free HTTP view. */
@Injectable()
export class ProcessingStatusService {
  constructor(
    private readonly repository: ProcessingStatusRepository,
    @Inject(PROCESSING_PROGRESS)
    private readonly progress: ProcessingProgressStore,
  ) {}

  async forVersion(
    userId: string,
    documentId: string,
    versionId: string,
  ): Promise<ProcessingStatusView> {
    const version = await this.repository.findOwnedVersion(
      userId,
      documentId,
      versionId,
    );
    if (!version) throw new NotFoundException();
    const run = version.aiState?.desiredRun;
    const stages = [
      'VERIFY_STORED_FILE',
      'EXTRACT_TEXT',
      'GENERATE_CHUNKS',
      'GENERATE_EMBEDDINGS',
      'INDEX_VECTORS',
    ].map((jobType) => ({
      jobType,
      status:
        (jobType === 'VERIFY_STORED_FILE'
          ? version.processingJobs.find((job) => job.jobType === jobType)
              ?.status
          : run?.jobs.find((job) => job.jobType === jobType)?.status) ??
        'NOT_SCHEDULED',
    }));
    return {
      aiReadiness: version.aiReadiness ?? 'UNAVAILABLE',
      ...(run
        ? {
            pipeline: {
              runId: run.id,
              generation: run.generation,
              status: run.status,
              stages,
              currentStage:
                stages.find((stage) => stage.status !== 'COMPLETED')?.jobType ??
                null,
            },
          }
        : {}),
      documentId: version.documentId,
      documentVersionId: version.id,
      jobs: await Promise.all(
        version.processingJobs
          .filter(
            (job) =>
              !run ||
              ![
                'EXTRACT_TEXT',
                'GENERATE_CHUNKS',
                'GENERATE_EMBEDDINGS',
                'INDEX_VECTORS',
              ].includes(job.jobType) ||
              job.aiRunId === run.id,
          )
          .map(async (job) => ({
            id: job.id,
            jobType: job.jobType,
            status: this.publicStatus(job.status),
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            nextRetryAt:
              job.status === 'RETRYING' ? job.availableAt.toISOString() : null,
            startedAt: timestamp(job.startedAt),
            completedAt: timestamp(job.completedAt),
            createdAt: job.createdAt.toISOString(),
            updatedAt: job.updatedAt.toISOString(),
            failureCode:
              job.status === 'RETRYING' || job.status === 'FAILED'
                ? safeFailure(job.lastFailureCode)
                : null,
            progress: await this.activeProgress(job),
          })),
      ),
    };
  }

  private async activeProgress(job: {
    id: string;
    status: string;
    attempts: number;
    startedAt: Date | null;
  }) {
    if (job.status !== 'PROCESSING' || job.attempts < 1) return null;
    try {
      const value = await this.progress.read(job.id, job.attempts);
      if (!value || value.attempt !== job.attempts) return null;
      if (
        job.startedAt &&
        Date.parse(value.updatedAt) < job.startedAt.getTime() - 5000
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }

  private publicStatus(status: string): PublicProcessingState {
    if (publicProcessingStates.some((candidate) => candidate === status))
      return status as PublicProcessingState;
    throw new Error('Unsupported durable processing status.');
  }
}
