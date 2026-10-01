import { Injectable } from '@nestjs/common';
import { Prisma } from '@brainless/database';
import { PrismaService } from '../../database/prisma.service';

const statusJob = {
  id: true,
  jobType: true,
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
  id: string;
  documentId: string;
  processingJobs: Array<{
    id: string;
    jobType: string;
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
  constructor(private readonly database: PrismaService) {}

  findOwnedVersion(
    userId: string,
    documentId: string,
    versionId: string,
  ): Promise<ProcessingStatusSnapshot | null> {
    return this.database.client.documentVersion.findFirst({
      where: {
        id: versionId,
        documentId,
        userId,
        document: { deletedAt: null, status: { not: 'DELETING' } },
      },
      select: {
        id: true,
        documentId: true,
        processingJobs: {
          distinct: ['jobType'],
          orderBy: [{ jobType: 'asc' }, { generation: 'desc' }],
          select: statusJob,
        },
      },
    });
  }
}
