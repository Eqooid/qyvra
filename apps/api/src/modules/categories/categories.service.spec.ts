import { Prisma } from '@qyvra/database';
import { PrismaService } from '../../database/prisma.service';
import {
  CategoriesService,
  CategoryConflict,
  CategoryNotFound,
} from './categories.service';
import { CategoryListQuery } from './categories.dto';

describe('CategoriesService', () => {
  const category = {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const service = new CategoriesService({
    client: { category },
  } as unknown as PrismaService);
  beforeEach(() => jest.resetAllMocks());
  it('bounds pages and keeps the owner predicate independent of the cursor', async () => {
    category.findMany.mockResolvedValue([{ id: 'first' }, { id: 'second' }]);
    const page = await service.list('owner', {
      limit: 1,
      cursor: 'foreign-cursor',
      sort: 'id',
    });
    expect(page).toEqual({
      items: [{ id: 'first' }],
      nextCursor: 'first',
      hasMore: true,
    });
    expect(category.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'owner', id: { gt: 'foreign-cursor' } },
        take: 2,
        orderBy: { id: 'asc' },
      }),
    );
  });
  it('returns empty pagination without fabricating a cursor', async () => {
    category.findMany.mockResolvedValue([]);
    expect(await service.list('owner', new CategoryListQuery())).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });
  it('ignores forged fields even at the service boundary and returns a safe projection', async () => {
    await service.create('owner', { name: 'Name', userId: 'foreign' } as {
      name: string;
    });
    expect(category.create).toHaveBeenCalledWith({
      data: {
        userId: 'owner',
        name: 'Name',
        color: undefined,
        icon: undefined,
      },
      select: {
        id: true,
        name: true,
        color: true,
        icon: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    await service.update('owner', 'id', { color: null });
    expect(category.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'id', userId: 'owner' },
        data: { name: undefined, color: null, icon: undefined },
      }),
    );
    expect(await service.delete('owner', 'id')).toEqual({ deleted: true });
    expect(category.delete).toHaveBeenCalledWith({
      where: { id: 'id', userId: 'owner' },
      select: { id: true },
    });
  });
  it.each(['create', 'update', 'delete'] as const)(
    'sanitizes %s infrastructure failures',
    async (method) => {
      category[method].mockRejectedValue(
        new Error('private database connection'),
      );
      const call =
        method === 'create'
          ? service.create('owner', { name: 'Name' })
          : method === 'update'
            ? service.update('owner', 'id', { name: 'Name' })
            : service.delete('owner', 'id');
      await expect(call).rejects.toThrow('Category persistence failed.');
    },
  );
  it('maps unique and missing-row constraints to safe domain outcomes', async () => {
    category.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create('owner', { name: 'Name' }),
    ).rejects.toBeInstanceOf(CategoryConflict);
    category.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('row missing', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.update('owner', 'foreign', { name: 'Name' }),
    ).rejects.toBeInstanceOf(CategoryNotFound);
  });
});
