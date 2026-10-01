import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProcessingRepository } from '@brainless/database';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { ConfigurationService } from '../../configuration/configuration.module';
import { UploadedFile } from './upload-multipart';
import { UploadResponse } from './upload.dto';

const uploadDocumentSelect = {
  id: true,
  title: true,
  status: true,
  documentType: true,
  issuer: true,
  referenceNumber: true,
  documentDate: true,
  expirationDate: true,
  createdAt: true,
  category: {
    select: {
      id: true,
      name: true,
      color: true,
      icon: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.DocumentSelect;

/** @description Durable upload-only idempotency, scoped by authenticated owner and UUID key. */
@Injectable()
export class UploadRepository {
  private readonly processing: ProcessingRepository;
  constructor(
    private readonly database: PrismaService,
    private readonly configuration: ConfigurationService,
  ) {
    this.processing = new ProcessingRepository(database.client);
  }
  /** @description Rechecked under the document row lock at commit, so lifecycle changes during streaming cannot be bypassed. */
  async assertVersionTarget(
    userId: string,
    documentId: string,
    tx: Prisma.TransactionClient = this.database.client,
  ) {
    const row = await tx.document.findFirst({
      where: { id: documentId, userId, deletedAt: null },
      select: { status: true, isArchived: true },
    });
    if (!row) throw new NotFoundException();
    if (
      row.isArchived ||
      ['ARCHIVED', 'DELETING', 'PROCESSING'].includes(row.status)
    )
      throw new ConflictException('Document cannot accept a version');
  }
  private async lock(
    tx: Prisma.TransactionClient,
    userId: string,
    key: string,
    scope = 'create',
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`upload:${userId}:${scope}:${key}`}, 0))`;
  }
  async reserve(userId: string, key: string, scope = 'create') {
    return this.database.client.$transaction(async (tx) => {
      await this.lock(tx, userId, key, scope);
      const now = new Date();
      const previous = await tx.documentUpload.findUnique({
        where: { userId_scope_key: { userId, scope, key } },
      });
      if (previous && previous.expiresAt > now) {
        if (previous.state !== 'COMPLETED')
          throw new ConflictException('Upload already in progress');
        return { attemptId: previous.attemptId, replay: true };
      }
      if (previous)
        await tx.documentUpload.delete({
          where: { userId_scope_key: { userId, scope, key } },
        });
      const attemptId = randomUUID();
      const lifetime =
        this.configuration.upload.timeoutMs +
        3 * this.configuration.upload.inspectionTimeoutMs +
        120000;
      await tx.documentUpload.create({
        data: {
          userId,
          scope,
          key,
          attemptId,
          expiresAt: new Date(now.getTime() + lifetime),
        },
      });
      return { attemptId, replay: false };
    });
  }
  async release(
    userId: string,
    key: string,
    attemptId: string,
    scope = 'create',
  ) {
    await this.database.client.documentUpload.deleteMany({
      where: { userId, scope, key, attemptId, state: 'RECEIVING' },
    });
  }
  /** @description Resolves a lost commit acknowledgement before compensating storage deletion. */
  async committed(
    userId: string,
    key: string,
    attemptId: string,
    documentId: string,
    scope = 'create',
    versionId?: string,
  ): Promise<UploadResponse | null> {
    return this.database.client.$transaction(async (tx) => {
      // Wait for any uncertain prior transaction before deciding that compensation is safe.
      await this.lock(tx, userId, key, scope);
      const row = await tx.documentUpload.findUnique({
        where: { userId_scope_key: { userId, scope, key } },
      });
      return row?.state === 'COMPLETED' &&
        row.attemptId === attemptId &&
        row.documentId === documentId &&
        (!versionId ||
          (row.response as unknown as UploadResponse).version.id === versionId)
        ? (row.response as unknown as UploadResponse)
        : null;
    });
  }
  async complete(
    userId: string,
    key: string,
    attemptId: string,
    documentId: string,
    versionId: string,
    file: UploadedFile,
    pageCount: number | null,
    scope: string,
    correlationId: string,
  ): Promise<{ response: UploadResponse; replay: boolean }> {
    const dto = file.dto;
    const metadata = {
      title: dto.title,
      documentType: dto.documentType ?? 'OTHER',
      issuer: dto.issuer ?? null,
      referenceNumber: dto.referenceNumber ?? null,
      documentDate: dto.documentDate ?? null,
      expirationDate: dto.expirationDate ?? null,
      categoryId: dto.categoryId?.toLowerCase() ?? null,
      tagIds: [...new Set(dto.tagIds ?? [])].sort(),
    };
    const description = dto.description ?? null;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          ...(scope === 'create' ? metadata : {}),
          ...(scope === 'create' && description !== null
            ? { description }
            : {}),
          filename: file.filename,
          mime: file.mime,
          size: file.size,
          checksum: file.checksum,
        }),
      )
      .digest('hex');
    try {
      return await this.database.client.$transaction(async (tx) => {
        await this.lock(tx, userId, key, scope);
        if (scope !== 'create') {
          await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
          await this.assertVersionTarget(userId, documentId, tx);
        }
        const record = await tx.documentUpload.findUnique({
          where: { userId_scope_key: { userId, scope, key } },
        });
        if (
          !record ||
          record.attemptId !== attemptId ||
          record.expiresAt <= new Date()
        )
          throw new ConflictException('Upload reservation expired');
        if (record.state === 'COMPLETED') {
          if (record.fingerprint !== fingerprint)
            throw new ConflictException(
              'Idempotency key was used for a different request',
            );
          // Only this repository writes these safe, versioned-by-operation receipts.
          return {
            response: record.response as unknown as UploadResponse,
            replay: true,
          };
        }
        if (
          scope === 'create' &&
          metadata.categoryId &&
          !(await tx.category.findFirst({
            where: { id: metadata.categoryId, userId },
            select: { id: true },
          }))
        )
          throw new NotFoundException();
        const tags =
          scope !== 'create'
            ? (
                await tx.documentTag.findMany({
                  where: { userId, documentId },
                  orderBy: { tagId: 'asc' },
                  select: {
                    tag: {
                      select: {
                        id: true,
                        name: true,
                        createdAt: true,
                        updatedAt: true,
                      },
                    },
                  },
                })
              ).map((join) => join.tag)
            : await tx.tag.findMany({
                where: { userId, id: { in: metadata.tagIds } },
                select: {
                  id: true,
                  name: true,
                  createdAt: true,
                  updatedAt: true,
                },
                orderBy: { id: 'asc' },
              });
        if (scope === 'create' && tags.length !== metadata.tagIds.length)
          throw new NotFoundException();
        if (scope === 'create' && !metadata.title)
          throw new BadRequestException('Title required');
        const document =
          scope !== 'create'
            ? await tx.document.update({
                where: { id: documentId, userId },
                data: { status: 'UPLOADED' },
                select: uploadDocumentSelect,
              })
            : await tx.document.create({
                data: {
                  id: documentId,
                  userId,
                  title: metadata.title ?? '',
                  description,
                  documentType: metadata.documentType,
                  issuer: metadata.issuer,
                  referenceNumber: metadata.referenceNumber,
                  documentDate: metadata.documentDate
                    ? new Date(metadata.documentDate)
                    : null,
                  expirationDate: metadata.expirationDate
                    ? new Date(metadata.expirationDate)
                    : null,
                  categoryId: metadata.categoryId,
                },
                select: uploadDocumentSelect,
              });
        const previous =
          scope === 'create'
            ? null
            : await tx.documentVersion.findFirst({
                where: { documentId, userId },
                orderBy: { versionNumber: 'desc' },
                select: { versionNumber: true },
              });
        const versionNumber = (previous?.versionNumber ?? 0) + 1;
        if (versionNumber > 2147483647)
          throw new ConflictException('Version limit reached');
        const version = await tx.documentVersion.create({
          data: {
            id: versionId,
            documentId,
            userId,
            versionNumber,
            originalFilename: file.filename,
            storageKey: file.key,
            mimeType: file.mime,
            fileSize: file.size,
            checksumSha256: file.checksum,
            pageCount,
          },
          select: {
            id: true,
            versionNumber: true,
            originalFilename: true,
            mimeType: true,
            fileSize: true,
            pageCount: true,
            extractionStatus: true,
            createdAt: true,
          },
        });
        await this.processing.createInTransaction(tx, {
          userId,
          documentId,
          documentVersionId: version.id,
          correlationId,
          maxAttempts: 3,
        });
        if (scope === 'create' && tags.length)
          await tx.documentTag.createMany({
            data: tags.map((tag) => ({ documentId, userId, tagId: tag.id })),
          });
        const response: UploadResponse = {
          ...document,
          createdAt: document.createdAt.toISOString(),
          documentDate:
            document.documentDate?.toISOString().slice(0, 10) ?? null,
          expirationDate:
            document.expirationDate?.toISOString().slice(0, 10) ?? null,
          category: document.category
            ? {
                ...document.category,
                createdAt: document.category.createdAt.toISOString(),
                updatedAt: document.category.updatedAt.toISOString(),
              }
            : null,
          tags: tags.map((tag) => ({
            ...tag,
            createdAt: tag.createdAt.toISOString(),
            updatedAt: tag.updatedAt.toISOString(),
          })),
          version: { ...version, createdAt: version.createdAt.toISOString() },
        };
        await tx.documentUpload.update({
          where: { userId_scope_key: { userId, scope, key } },
          data: {
            state: 'COMPLETED',
            fingerprint,
            documentId,
            response: JSON.parse(
              JSON.stringify(response),
            ) as Prisma.InputJsonObject,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
        return { response, replay: false };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Duplicate document');
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      )
        throw new NotFoundException();
      throw error;
    }
  }
}
