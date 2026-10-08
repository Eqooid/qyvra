import { NotFoundException } from '@nestjs/common';
import { CitationSourceService } from './citation-source.service';
import { PrismaService } from '../../database/prisma.service';

describe('canonical citation source authorization', () => {
  const findFirst = jest.fn();
  const service = new CitationSourceService({
    client: { documentChunk: { findFirst } },
  } as unknown as PrismaService);
  beforeEach(() => findFirst.mockReset());
  it('authorizes the exact owned tuple, active document and complete canonical set before returning text', async () => {
    findFirst.mockResolvedValue({
      id: 'chunk',
      documentId: 'doc',
      documentVersionId: 'version',
      ordinal: 2,
      text: 'canonical',
      textHash: 'hash',
      startOffset: 0,
      endOffset: 9,
      pageSpans: [{ pageNumber: 2, startOffset: 0, endOffset: 9 }],
      version: {
        versionNumber: 3,
        originalFilename: 'old.pdf',
        document: { title: 'Owned' },
      },
    });
    expect(
      await service.resolve('owner', 'doc', 'version', 'chunk'),
    ).toMatchObject({
      chunkId: 'chunk',
      documentVersionId: 'version',
      versionNumber: 3,
      excerpt: 'canonical',
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'chunk',
          documentId: 'doc',
          documentVersionId: 'version',
          userId: 'owner',
          version: {
            userId: 'owner',
            document: {
              userId: 'owner',
              deletedAt: null,
              isArchived: false,
              status: { not: 'DELETING' },
            },
          },
          set: { complete: true },
        },
      }),
    );
  });
  it('returns the same safe 404 for foreign, missing and revoked sources', async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      service.resolve('owner', 'doc', 'version', 'chunk'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
