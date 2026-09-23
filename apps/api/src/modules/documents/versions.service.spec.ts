import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { ConfigurationService } from '../../configuration/configuration.module';
import { UploadRepository } from './upload.repository';
import { VersionsService } from './versions.service';
import { VersionListQuery } from './versions.dto';

describe('Version history ownership and lifecycle', () => {
  const userId = randomUUID(),
    documentId = randomUUID();
  const document = { findFirst: jest.fn() },
    documentVersion = { findFirst: jest.fn(), findMany: jest.fn() };
  const tx = { document, documentVersion };
  const db = {
    client: {
      ...tx,
      $transaction: jest.fn(
        async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
      ),
    },
  } as unknown as PrismaService;
  const service = new VersionsService(db);
  const repository = new UploadRepository(db, {} as ConfigurationService);
  const row = {
    id: randomUUID(),
    versionNumber: 2,
    originalFilename: 'safe.pdf',
    mimeType: 'application/pdf',
    fileSize: 4,
    pageCount: 1,
    extractionStatus: 'PENDING',
    createdAt: new Date(),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    document.findFirst.mockResolvedValue({ versions: [{ versionNumber: 2 }] });
    documentVersion.findFirst.mockResolvedValue(row);
    documentVersion.findMany.mockResolvedValue([row]);
  });
  it('uses owned document visibility before querying history and returns no provider metadata', async () => {
    const result = await service.list(
      userId,
      documentId,
      new VersionListQuery(),
    );
    expect(document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: documentId,
          userId,
          deletedAt: null,
          status: { not: 'DELETING' },
        },
      }),
    );
    expect(documentVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId, documentId }, take: 26 }),
    );
    expect(result.items[0]).toMatchObject({
      id: row.id,
      isLatest: true,
      createdAt: row.createdAt.toISOString(),
    });
  });
  it('does not query versions for an unavailable document', async () => {
    document.findFirst.mockResolvedValue(null);
    await expect(
      service.list(userId, documentId, new VersionListQuery()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(documentVersion.findMany).not.toHaveBeenCalled();
  });
  it('bounds a page using the owned cursor version number', async () => {
    documentVersion.findFirst.mockResolvedValue({ versionNumber: 2 });
    documentVersion.findMany.mockResolvedValue([{ ...row, versionNumber: 1 }]);
    const result = await service.list(userId, documentId, {
      ...new VersionListQuery(),
      cursor: row.id,
    });
    expect(documentVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: row.id, userId, documentId } }),
    );
    expect(documentVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId, documentId, versionNumber: { lt: 2 } },
      }),
    );
    expect(result.items[0].isLatest).toBe(false);
  });
  it('rejects a missing/foreign cursor identically', async () => {
    documentVersion.findFirst.mockResolvedValue(null);
    await expect(
      service.list(userId, documentId, {
        ...new VersionListQuery(),
        cursor: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('requires the detail version to belong to the specified owned document', async () => {
    documentVersion.findFirst.mockResolvedValue(null);
    await expect(
      service.detail(userId, documentId, row.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(documentVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: row.id, userId, documentId } }),
    );
  });
  it.each(['ARCHIVED', 'DELETING', 'PROCESSING'])(
    'rejects new uploads in %s state',
    async (status) => {
      document.findFirst.mockResolvedValue({
        status,
        isArchived: status === 'ARCHIVED',
      });
      await expect(
        repository.assertVersionTarget(userId, documentId),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );
  it('rejects missing targets and admits active unprocessed documents', async () => {
    document.findFirst.mockResolvedValue(null);
    await expect(
      repository.assertVersionTarget(userId, documentId),
    ).rejects.toBeInstanceOf(NotFoundException);
    document.findFirst.mockResolvedValue({
      status: 'UPLOADED',
      isArchived: false,
    });
    await expect(
      repository.assertVersionTarget(userId, documentId),
    ).resolves.toBeUndefined();
  });
  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { cursor: 'bad' },
    { sort: 'storageKey' },
    { userId: randomUUID() },
  ])('rejects unsafe pagination %j', async (query) => {
    await expect(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }).transform(query, { type: 'query', metatype: VersionListQuery }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
