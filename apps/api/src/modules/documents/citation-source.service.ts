import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '@qyvra/database';

export interface CitationSource {
  documentId: string;
  documentVersionId: string;
  chunkId: string;
  chunkOrdinal: number;
  title: string;
  versionNumber: number;
  originalFilename: string;
  excerpt: string;
  excerptHash: string;
  excerptStart: number;
  excerptEnd: number;
  pageSpans: Prisma.JsonValue;
}

@Injectable()
export class CitationSourceService {
  constructor(private readonly database: PrismaService) {}
  async resolve(
    userId: string,
    documentId: string,
    versionId: string,
    chunkId: string,
  ): Promise<CitationSource> {
    const chunk = await this.database.client.documentChunk.findFirst({
      where: {
        id: chunkId,
        documentId,
        documentVersionId: versionId,
        userId,
        version: {
          userId,
          document: {
            userId,
            deletedAt: null,
            isArchived: false,
            status: { not: 'DELETING' },
          },
        },
        set: { complete: true },
      },
      select: {
        id: true,
        documentId: true,
        documentVersionId: true,
        ordinal: true,
        text: true,
        textHash: true,
        startOffset: true,
        endOffset: true,
        pageSpans: true,
        version: {
          select: {
            versionNumber: true,
            originalFilename: true,
            document: { select: { title: true } },
          },
        },
      },
    });
    if (!chunk) throw new NotFoundException();
    return {
      documentId: chunk.documentId,
      documentVersionId: chunk.documentVersionId,
      chunkId: chunk.id,
      chunkOrdinal: chunk.ordinal,
      title: chunk.version.document.title,
      versionNumber: chunk.version.versionNumber,
      originalFilename: chunk.version.originalFilename,
      excerpt: chunk.text,
      excerptHash: chunk.textHash,
      excerptStart: chunk.startOffset,
      excerptEnd: chunk.endOffset,
      pageSpans: chunk.pageSpans,
    };
  }
}
