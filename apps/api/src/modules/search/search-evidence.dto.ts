import { ApiProperty } from '@nestjs/swagger';
export class HighlightRangeDto {
  @ApiProperty({
    minimum: 0,
    description: 'Inclusive Unicode scalar offset relative to snippet.',
  })
  start!: number;
  @ApiProperty({
    minimum: 1,
    description: 'Exclusive Unicode scalar offset relative to snippet.',
  })
  end!: number;
}
export class HighlightSegmentDto {
  @ApiProperty({ description: 'Plain text, never HTML.' }) text!: string;
  @ApiProperty() matched!: boolean;
}
export class LexicalSourceReferenceDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ format: 'uuid' }) documentVersionId!: string;
  @ApiProperty({ format: 'uuid' }) extractedTextId!: string;
  @ApiProperty({ minimum: 1, description: 'One-based PDF page.' })
  pageNumber!: number;
  @ApiProperty({
    minimum: 0,
    description: 'Zero-based deterministic 8192-scalar page segment.',
  })
  segment!: number;
  @ApiProperty({
    description:
      'Immutable extraction/page/segment identity; not an authorization token.',
  })
  sourceId!: string;
  @ApiProperty({
    description:
      'Same-origin authenticated canonical text route, not a PDF/file URL.',
  })
  href!: string;
}
export function lexicalSourceReference(
  documentId: string,
  documentVersionId: string,
  extractedTextId: string,
  pageNumber: number,
  segment: number,
): LexicalSourceReferenceDto {
  return {
    documentId,
    documentVersionId,
    extractedTextId,
    pageNumber,
    segment,
    sourceId: `${extractedTextId}:page:${pageNumber}:segment:${segment}`,
    href: `/api/v1/documents/${documentId}/versions/${documentVersionId}/extractions/${extractedTextId}/pages/${pageNumber}/segments/${segment}`,
  };
}
