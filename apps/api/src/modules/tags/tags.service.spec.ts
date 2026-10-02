import { Prisma } from '@qyvra/database';
import { PrismaService } from '../../database/prisma.service';
import { TagsService, TagConflict, TagNotFound } from './tags.service';
import { TagListQuery } from './tags.dto';
import { normalizeOwnedName } from '../../common/normalize-owned-name';

describe('TagsService', () => {
  const tag = {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const service = new TagsService({
    client: { tag },
  } as unknown as PrismaService);
  beforeEach(() => jest.resetAllMocks());
  it('uses the existing normalized display policy', () => {
    expect(normalizeOwnedName('  Ｆｉｎａｎｃｅ   Records ')).toBe(
      'Finance Records',
    );
    expect(normalizeOwnedName(null)).toBeNull();
  });
  it('combines trusted ownership, literal search and the exclusive cursor in a bounded query', async () => {
    tag.findMany.mockResolvedValue([{ id: 'one' }, { id: 'two' }]);
    expect(
      await service.list('owner', {
        limit: 1,
        cursor: 'cursor',
        sort: 'id',
        q: '%_\\',
      }),
    ).toEqual({ items: [{ id: 'one' }], nextCursor: 'one', hasMore: true });
    expect(tag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'owner',
          id: { gt: 'cursor' },
          name: { contains: '\\%\\_\\\\', mode: 'insensitive' },
        },
        orderBy: { id: 'asc' },
        take: 2,
      }),
    );
  });
  it('returns empty pagination without an invented cursor', async () => {
    tag.findMany.mockResolvedValue([]);
    expect(await service.list('owner', new TagListQuery())).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });
  it('whitelists persistence fields and applies ownership directly to every write', async () => {
    const input = { name: 'Finance', userId: 'foreign', color: '#ffffff' };
    await service.create('owner', input);
    expect(tag.create).toHaveBeenCalledWith({
      data: { userId: 'owner', name: 'Finance' },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    await service.update('owner', 'id', input);
    expect(tag.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'id', userId: 'owner' },
        data: { name: 'Finance' },
      }),
    );
    expect(await service.delete('owner', 'id')).toEqual({ deleted: true });
    expect(tag.delete).toHaveBeenCalledWith({
      where: { id: 'id', userId: 'owner' },
      select: { id: true },
    });
  });
  it.each(['P2002', 'P2025'])(
    'maps %s without leaking database details',
    async (code) => {
      tag.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('private SQL', {
          code,
          clientVersion: 'test',
        }),
      );
      await expect(
        service.update('owner', 'id', { name: 'Finance' }),
      ).rejects.toBeInstanceOf(code === 'P2002' ? TagConflict : TagNotFound);
    },
  );
  it('sanitizes unexpected infrastructure failures', async () => {
    tag.delete.mockRejectedValue(new Error('private database connection'));
    await expect(service.delete('owner', 'id')).rejects.toThrow(
      'Tag persistence failed.',
    );
  });
});
