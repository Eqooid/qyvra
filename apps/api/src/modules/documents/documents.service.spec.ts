import { PrismaService } from '../../database/prisma.service';
import { DocumentsService } from './documents.service';
import { DocumentListQuery } from './documents.dto';
import { DocumentNotFound } from './document-lifecycle';

describe('DocumentsService batching and ownership', () => {
  const client = {
    document: { findMany: jest.fn(), findFirst: jest.fn() },
    category: { findMany: jest.fn() },
    documentTag: { findMany: jest.fn() },
    tag: { findMany: jest.fn() },
  };
  const service = new DocumentsService({ client } as unknown as PrismaService);
  beforeEach(() => {
    jest.resetAllMocks();
    client.category.findMany.mockResolvedValue([]);
    client.documentTag.findMany.mockResolvedValue([]);
    client.tag.findMany.mockResolvedValue([]);
  });
  it('loads a whole page using four batch operations, not per-document relationships', async () => {
    client.document.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        id: `${i}`,
        categoryId: null,
        documentDate: null,
        expirationDate: null,
      })),
    );
    const result = await service.list('owner', new DocumentListQuery());
    expect(result.items).toHaveLength(25);
    for (const model of [
      client.document,
      client.category,
      client.documentTag,
      client.tag,
    ])
      expect(model.findMany).toHaveBeenCalledTimes(1);
    expect(client.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'owner', deletedAt: null }),
        take: 26,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(client.documentTag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'owner',
          documentId: { in: Array.from({ length: 25 }, (_, i) => `${i}`) },
        },
      }),
    );
  });
  it('does no association queries for an empty page', async () => {
    client.document.findMany.mockResolvedValue([]);
    expect(
      (await service.list('owner', new DocumentListQuery())).items,
    ).toEqual([]);
    expect(client.category.findMany).not.toHaveBeenCalled();
  });
  it('retains owner and non-deleted predicates on detail and hides missing rows', async () => {
    client.document.findFirst.mockResolvedValue(null);
    await expect(service.detail('owner', 'foreign')).rejects.toBeInstanceOf(
      DocumentNotFound,
    );
    expect(client.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'foreign', userId: 'owner', deletedAt: null },
      }),
    );
  });
});
