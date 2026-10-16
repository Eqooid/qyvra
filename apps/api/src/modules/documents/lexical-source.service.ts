import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@qyvra/database';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';

export class LexicalPageSourceDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ format: 'uuid' }) documentVersionId!: string;
  @ApiProperty({ format: 'uuid' }) extractedTextId!: string;
  @ApiProperty({ minimum: 1 }) versionNumber!: number;
  @ApiProperty() title!: string;
  @ApiProperty() originalFilename!: string;
  @ApiProperty({ minimum: 1, description: 'One-based PDF page.' })
  pageNumber!: number;
  @ApiProperty({
    minimum: 0,
    description: 'Zero-based 8192-scalar page segment.',
  })
  segment!: number;
  @ApiProperty({
    maximum: 16384,
    description: 'Plain canonical text, never HTML.',
  })
  excerpt!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) excerptHash!: string;
  @ApiProperty({
    minimum: 0,
    description: 'Inclusive Unicode scalar offset in the immutable extraction.',
  })
  startOffset!: number;
  @ApiProperty({
    minimum: 1,
    description: 'Exclusive Unicode scalar offset in the immutable extraction.',
  })
  endOffset!: number;
  @ApiProperty({ type: Number, nullable: true }) nextSegment!: number | null;
  @ApiProperty({ type: Number, nullable: true }) previousSegment!:
    number | null;
}
/** Same retained historical-source policy as citation reads; IDs never grant access. */
@Injectable()
export class LexicalSourceService {
  constructor(private readonly database: PrismaService) {}
  async resolve(
    userId: string,
    documentId: string,
    versionId: string,
    extractionId: string,
    pageNumber: number,
    segment: number,
  ): Promise<LexicalPageSourceDto> {
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > 10000 ||
      !Number.isInteger(segment) ||
      segment < 0 ||
      segment > 10000
    )
      throw new BadRequestException();
    const rows = await this.database.client.$queryRaw<
      (Omit<
        LexicalPageSourceDto,
        'excerptHash' | 'nextSegment' | 'previousSegment'
      > & { pageEnd: number })[]
    >(Prisma.sql`
      SELECT d.id AS "documentId",v.id AS "documentVersionId",t.id AS "extractedTextId",
        v.version_number AS "versionNumber",d.title,v.original_filename AS "originalFilename",
        ${pageNumber}::integer AS "pageNumber",${segment}::integer AS segment,
        span.start_offset+${segment}::integer*8192 AS "startOffset",
        least(span.end_offset,span.start_offset+(${segment}::integer+1)*8192) AS "endOffset",
        span.end_offset AS "pageEnd",
        substr(t.text,span.start_offset+${segment}::integer*8192+1,
          least(8192,span.end_offset-(span.start_offset+${segment}::integer*8192))) AS excerpt
      FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.user_id=d.user_id
      JOIN extracted_texts t ON t.document_version_id=v.id AND t.document_id=d.id AND t.user_id=d.user_id
        AND t.source_checksum=v.checksum_sha256
      JOIN LATERAL (SELECT (p->>'startOffset')::integer AS start_offset,(p->>'endOffset')::integer AS end_offset
        FROM jsonb_array_elements(t.page_spans) p WHERE (p->>'pageNumber')::integer=${pageNumber}) span ON TRUE
      WHERE d.id=${documentId}::uuid AND d.user_id=${userId}::uuid AND v.id=${versionId}::uuid
        AND t.id=${extractionId}::uuid AND v.mime_type='application/pdf'
        AND d.deleted_at IS NULL AND NOT d.is_archived AND d.status NOT IN ('ARCHIVED','DELETING')
        AND span.start_offset+${segment}::integer*8192<span.end_offset
        AND EXISTS (SELECT 1 FROM version_search_projections p JOIN search_index_generations g ON g.id=p.index_generation_id
          WHERE p.user_id=d.user_id AND p.document_id=d.id AND p.document_version_id=v.id AND p.extracted_text_id=t.id
            AND p.text_coverage='READY' AND p.metadata_ready AND p.verified_at IS NOT NULL AND p.records_hash IS NOT NULL
            AND p.status IN ('READY','REMOVAL_PENDING','REMOVED') AND g.status IN ('SERVING','RETIRED')
            AND p.expected_record_ids ? (p.id::text||':page:'||${pageNumber}::text||':'||${segment}::text))
      LIMIT 1`);
    const row = rows[0];
    if (
      !row ||
      !row.excerpt ||
      Array.from(row.excerpt).length !== row.endOffset - row.startOffset
    )
      throw new NotFoundException();
    const { pageEnd, ...source } = row;
    return {
      ...source,
      excerptHash: createHash('sha256').update(row.excerpt).digest('hex'),
      nextSegment: row.endOffset < pageEnd ? segment + 1 : null,
      previousSegment: segment > 0 ? segment - 1 : null,
    };
  }
}
