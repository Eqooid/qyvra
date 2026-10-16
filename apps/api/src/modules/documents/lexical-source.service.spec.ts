import { NotFoundException, BadRequestException } from '@nestjs/common';
import { LexicalSourceService } from './lexical-source.service';
import { PrismaService } from '../../database/prisma.service';
import { sourceInteger } from './lexical-source.controller';

describe('bounded canonical lexical source contract', () => {
  it.each(['-1', '1.5', '01', '1e2', '0x1', '100001', 'NaN'])(
    'rejects malformed page/segment %s',
    (value) => {
      expect(() => sourceInteger(value, 0, 10000)).toThrow(BadRequestException);
    },
  );
  it('uses one-based pages and zero-based segments without implicit conversion', () => {
    expect(sourceInteger('1', 1, 10000)).toBe(1);
    expect(sourceInteger('0', 0, 10000)).toBe(0);
    expect(() => sourceInteger('0', 1, 10000)).toThrow(BadRequestException);
  });
  it('returns only a bounded exact source and safe continuation integers', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        documentId: 'd',
        documentVersionId: 'v',
        extractedTextId: 'e',
        versionNumber: 1,
        title: 'Owned',
        originalFilename: 'a.pdf',
        pageNumber: 1,
        segment: 0,
        excerpt: '<script>',
        startOffset: 0,
        endOffset: 8,
        pageEnd: 9000,
      },
    ]);
    const service = new LexicalSourceService({
      client: { $queryRaw: query },
    } as unknown as PrismaService);
    const result = await service.resolve('owner', 'd', 'v', 'e', 1, 0);
    expect(result.excerpt).toBe('<script>');
    expect(result.excerptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toMatchObject({ nextSegment: 1, previousSegment: null });
    expect(result).not.toHaveProperty('pageEnd');
    expect(result).not.toHaveProperty('storageKey');
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValue([]);
    await expect(
      service.resolve('owner', 'd', 'v', 'e', 1, 0),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.resolve('owner', 'd', 'v', 'e', 0, 0),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
