import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProcessingStatusRepository } from './processing-status.repository';
import { ProcessingStatusService } from './processing-status.service';
import { ProcessingProgressStore } from '../../infrastructure/progress/processing-progress';

describe('ProcessingStatusService', () => {
  const userId = randomUUID();
  const documentId = randomUUID();
  const versionId = randomUUID();
  const findOwnedVersion = jest.fn();
  const read = jest.fn();
  const service = new ProcessingStatusService(
    {
      findOwnedVersion,
    } as unknown as ProcessingStatusRepository,
    {
      read,
    } as unknown as ProcessingProgressStore,
  );

  beforeEach(() => jest.resetAllMocks());

  it('keeps a prior run completion out of the current run jobs and pending stages', async () => {
    const runId = randomUUID();
    const now = new Date();
    findOwnedVersion.mockResolvedValue({
      id: versionId,
      documentId,
      aiState: {
        desiredRun: {
          id: runId,
          generation: 2,
          status: 'BUILDING',
          jobs: [{ jobType: 'EXTRACT_TEXT', status: 'RETRYING' }],
        },
      },
      processingJobs: [
        {
          id: randomUUID(),
          aiRunId: randomUUID(),
          jobType: 'GENERATE_CHUNKS',
          status: 'COMPLETED',
          attempts: 1,
          maxAttempts: 3,
          availableAt: now,
          startedAt: now,
          completedAt: now,
          lastFailureCode: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const result = await service.forVersion(userId, documentId, versionId);
    expect(result.jobs).toEqual([]);
    expect(result.pipeline?.generation).toBe(2);
    expect(
      result.pipeline?.stages.find(
        (stage) => stage.jobType === 'GENERATE_CHUNKS',
      )?.status,
    ).toBe('NOT_SCHEDULED');
  });

  it('uses the owner and version boundary and hides missing resources', async () => {
    findOwnedVersion.mockResolvedValue(null);
    await expect(
      service.forVersion(userId, documentId, versionId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findOwnedVersion).toHaveBeenCalledWith(
      userId,
      documentId,
      versionId,
    );
  });

  it('maps only client-safe retry information and failure categories', async () => {
    const now = new Date();
    const job = {
      id: randomUUID(),
      jobType: 'VERIFY_STORED_FILE',
      status: 'RETRYING',
      attempts: 1,
      maxAttempts: 3,
      availableAt: new Date(now.getTime() + 5000),
      startedAt: now,
      completedAt: null,
      lastFailureCode: 'SENSITIVE_INTERNAL_REASON',
      createdAt: now,
      updatedAt: now,
      leaseToken: randomUUID(),
      storageKey: 'private/path',
    };
    findOwnedVersion.mockResolvedValue({
      id: versionId,
      documentId,
      processingJobs: [job],
    });
    const result = await service.forVersion(userId, documentId, versionId);
    expect(result.jobs[0]).toMatchObject({
      status: 'RETRYING',
      nextRetryAt: job.availableAt.toISOString(),
      failureCode: 'PROCESSING_ERROR',
      attempts: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /SENSITIVE_INTERNAL_REASON|private\/path|leaseToken|storageKey|outbox/,
    );
  });

  it('enriches only the current PostgreSQL processing attempt', async () => {
    const now = new Date();
    const job = {
      id: randomUUID(),
      jobType: 'VERIFY_STORED_FILE',
      status: 'PROCESSING',
      attempts: 2,
      maxAttempts: 3,
      availableAt: now,
      startedAt: now,
      completedAt: null,
      lastFailureCode: null,
      createdAt: now,
      updatedAt: now,
    };
    findOwnedVersion.mockResolvedValue({
      id: versionId,
      documentId,
      processingJobs: [job],
    });
    const progress = {
      attempt: 2,
      percent: 50,
      stage: 'READING',
      updatedAt: now.toISOString(),
    };
    read.mockResolvedValue(progress);
    expect(
      (await service.forVersion(userId, documentId, versionId)).jobs[0]
        .progress,
    ).toEqual(progress);
    expect(read).toHaveBeenCalledWith(job.id, 2);
    read.mockResolvedValue({ ...progress, attempt: 1 });
    expect(
      (await service.forVersion(userId, documentId, versionId)).jobs[0]
        .progress,
    ).toBeNull();
    read.mockRejectedValue(new Error('redis unavailable'));
    expect(
      (await service.forVersion(userId, documentId, versionId)).jobs[0]
        .progress,
    ).toBeNull();
    job.status = 'COMPLETED';
    expect(
      (await service.forVersion(userId, documentId, versionId)).jobs[0]
        .progress,
    ).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });
});
