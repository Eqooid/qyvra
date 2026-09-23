import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@brainless/database';
import { PrismaService } from '../../database/prisma.service';
import { PaginatedData } from '../../common/paginated-data';
import { VersionListQuery, VersionView } from './versions.dto';

const safeVersion = {
  id: true,
  versionNumber: true,
  originalFilename: true,
  mimeType: true,
  fileSize: true,
  pageCount: true,
  extractionStatus: true,
  createdAt: true,
} satisfies Prisma.DocumentVersionSelect;

/** @description Owned version history uses a single request snapshot and never accesses binary storage. */
@Injectable()
export class VersionsService {
  constructor(private readonly database: PrismaService) {}
  private async latest(
    tx: Prisma.TransactionClient,
    userId: string,
    documentId: string,
  ) {
    const document = await tx.document.findFirst({
      where: {
        id: documentId,
        userId,
        deletedAt: null,
        status: { not: 'DELETING' },
      },
      select: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          select: { versionNumber: true },
        },
      },
    });
    if (!document) throw new NotFoundException();
    return document.versions[0]?.versionNumber ?? 0;
  }
  async list(
    userId: string,
    documentId: string,
    query: VersionListQuery,
  ): Promise<PaginatedData<VersionView>> {
    return this.database.client.$transaction(
      async (tx) => {
        const latest = await this.latest(tx, userId, documentId);
        const cursor = query.cursor
          ? await tx.documentVersion.findFirst({
              where: { id: query.cursor, userId, documentId },
              select: { versionNumber: true },
            })
          : null;
        if (query.cursor && !cursor)
          throw new BadRequestException('Invalid cursor');
        const rows = await tx.documentVersion.findMany({
          where: {
            userId,
            documentId,
            ...(cursor ? { versionNumber: { lt: cursor.versionNumber } } : {}),
          },
          orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
          select: safeVersion,
        });
        const hasMore = rows.length > query.limit;
        const items = rows.slice(0, query.limit).map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          isLatest: row.versionNumber === latest,
        }));
        return new PaginatedData(
          items,
          hasMore ? items[items.length - 1].id : null,
          hasMore,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async detail(
    userId: string,
    documentId: string,
    versionId: string,
  ): Promise<VersionView> {
    return this.database.client.$transaction(
      async (tx) => {
        const latest = await this.latest(tx, userId, documentId);
        const row = await tx.documentVersion.findFirst({
          where: { id: versionId, userId, documentId },
          select: safeVersion,
        });
        if (!row) throw new NotFoundException();
        return {
          ...row,
          createdAt: row.createdAt.toISOString(),
          isLatest: row.versionNumber === latest,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
