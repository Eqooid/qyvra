import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  VersionSearchProjection,
  SearchEnrollmentRepository,
  SearchMaintenanceScheduler,
} from '@qyvra/database';
import { ConfigurationService } from '../../configuration/configuration.module';
import { PrismaService } from '../../database/prisma.service';

/** Database-only lifecycle boundary; no search handler is registered here. */
@Injectable()
export class SearchEnrollmentService implements OnModuleInit {
  private readonly repository: SearchEnrollmentRepository;
  constructor(
    private readonly database: PrismaService,
    private readonly configuration: ConfigurationService,
  ) {
    this.repository = new SearchEnrollmentRepository(database.client);
  }
  private get policy() {
    return this.configuration.searchEnrollment;
  }
  async onModuleInit() {
    await this.repository.validatePolicy(this.policy);
  }
  enrollInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
  ): Promise<VersionSearchProjection | null> {
    return this.repository.enrollInTransaction(
      tx,
      userId,
      documentId,
      this.policy,
    );
  }
  invalidateInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
  ) {
    return this.repository.invalidateInTransaction(tx, userId, documentId);
  }
  recordOrganizationChangeInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    resourceId: string,
    reason: 'CATEGORY_DELETED' | 'TAG_DELETED',
  ) {
    return this.repository.recordOrganizationChangeInTransaction(
      tx,
      userId,
      resourceId,
      reason,
      this.policy,
    );
  }
  async reconcile(limit: number) {
    await this.repository.reconcile(this.policy, Math.min(limit, 100));
    await new SearchMaintenanceScheduler(this.database.client).reconcile(
      Math.min(limit, 100),
    );
  }
}
