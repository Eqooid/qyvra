import {
  HighlightRangeDto,
  HighlightSegmentDto,
  LexicalSourceReferenceDto,
} from './search-evidence.dto';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isCalendarDate } from '../documents/documents.dto';

const optional = (_: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.normalize('NFC').trim() : value;
const ids = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v.toLowerCase() : v))
    : value;
export function plainKeyword(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4000 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const calendar = () =>
  ValidateBy({ name: 'calendarDate', validator: { validate: isCalendarDate } });
export class KeywordSearchFilters {
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf(optional)
  @IsUUID()
  categoryId?: string;
  @ApiPropertyOptional({
    type: [String],
    maxItems: 10,
    description: 'All tags must match.',
  })
  @ValidateIf(optional)
  @Transform(ids)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  tagIds?: string[];
  @ApiPropertyOptional({ pattern: '^[A-Z][A-Z0-9_]{0,49}$' })
  @ValidateIf(optional)
  @Matches(/^[A-Z][A-Z0-9_]{0,49}$/)
  documentType?: string;
  @ApiPropertyOptional({
    enum: ['UPLOADED', 'PROCESSING', 'READY', 'PARTIALLY_READY', 'FAILED'],
  })
  @ValidateIf(optional)
  @IsIn(['UPLOADED', 'PROCESSING', 'READY', 'PARTIALLY_READY', 'FAILED'])
  status?: string;
  @ApiPropertyOptional({ enum: ['application/pdf', 'image/png', 'image/jpeg'] })
  @ValidateIf(optional)
  @IsIn(['application/pdf', 'image/png', 'image/jpeg'])
  mimeType?: string;
  @ApiPropertyOptional({ maxLength: 200 })
  @ValidateIf(optional)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(/^[^\u0000-\u001f\u007f-\u009f]+$/)
  filename?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  dateFrom?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  dateTo?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  expirationFrom?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  expirationTo?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  createdFrom?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  createdTo?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  updatedFrom?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  updatedTo?: string;
}
export class KeywordSearchDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 4000,
    description: 'Literal NFC plain text; no query language.',
  })
  @Transform(trim)
  @IsString()
  @ValidateBy({ name: 'plainKeyword', validator: { validate: plainKeyword } })
  query!: string;
  @ApiPropertyOptional({ enum: ['terms', 'phrase'], default: 'terms' })
  @ValidateIf(optional)
  @IsIn(['terms', 'phrase'])
  match?: 'terms' | 'phrase';
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 20 })
  @ValidateIf(optional)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
  @ApiPropertyOptional({ enum: ['relevance'], default: 'relevance' })
  @ValidateIf(optional)
  @IsIn(['relevance'])
  sort?: 'relevance';
  @ApiPropertyOptional({
    type: [String],
    maxItems: 50,
    description: 'All IDs must be owned and active.',
  })
  @ValidateIf(optional)
  @Transform(ids)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  documentIds?: string[];
  @ApiPropertyOptional({ type: KeywordSearchFilters })
  @ValidateIf(optional)
  @IsObject()
  @ValidateNested()
  @Type(() => KeywordSearchFilters)
  filters?: KeywordSearchFilters;
  @ApiPropertyOptional({
    maxLength: 4096,
    description:
      'Opaque five-minute owner/session-bound fixed-window continuation.',
  })
  @ValidateIf(optional)
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}

export class KeywordMatchDto {
  @ApiPropertyOptional({ type: [HighlightRangeDto], maxItems: 32 })
  ranges?: HighlightRangeDto[];
  @ApiPropertyOptional({ type: [HighlightSegmentDto], maxItems: 65 })
  segments?: HighlightSegmentDto[];
  @ApiPropertyOptional() field?: string;
  @ApiPropertyOptional() segmentId?: string;
  @ApiPropertyOptional({ type: LexicalSourceReferenceDto })
  source?: LexicalSourceReferenceDto;
  @ApiProperty({ enum: ['metadata', 'page'] }) kind!: 'metadata' | 'page';
  @ApiProperty({
    maxLength: 1024,
    description: 'Plain canonical text; render as text, never HTML.',
  })
  snippet!: string;
  @ApiProperty({ type: [String] }) matchedFields!: string[];
  @ApiPropertyOptional({ minimum: 1 }) pageNumber?: number;
  @ApiPropertyOptional({ format: 'uuid' }) extractedTextId?: string;
  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Unicode scalar start in extraction (page) or canonical field (metadata).',
  })
  startOffset?: number;
  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Exclusive scalar end in extraction or canonical field; ranges remain snippet-relative.',
  })
  endOffset?: number;
}
export class KeywordResultDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ format: 'uuid' }) documentVersionId!: string;
  @ApiProperty({ format: 'uuid' }) projectionId!: string;
  @ApiProperty({ minimum: 1 }) versionNumber!: number;
  @ApiProperty() title!: string;
  @ApiProperty() originalFilename!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() documentType!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) categoryId!:
    string | null;
  @ApiProperty({ type: [String] }) tagIds!: string[];
  @ApiProperty({ enum: ['lexical-bm25'] }) ranking!: 'lexical-bm25';
  @ApiProperty({
    minimum: 1,
    maximum: 200,
    description:
      'Ordinal among authorized results; raw shared-index scores are not exposed.',
  })
  rank!: number;
  @ApiProperty({ type: [KeywordMatchDto], maxItems: 3 })
  matches!: KeywordMatchDto[];
}
export class KeywordCoverageDto {
  @ApiProperty({ minimum: 0 }) eligibleDocuments!: number;
  @ApiProperty({ minimum: 0 }) metadataReadyDocuments!: number;
  @ApiProperty({ minimum: 0 }) textReadyDocuments!: number;
}
export class KeywordPaginationDto {
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({
    description:
      'Additional authorized slots within this bounded fixed result window.',
  })
  hasMore!: boolean;
  @ApiProperty() paginationAvailable!: boolean;
  @ApiProperty({
    description:
      'Candidate retrieval was bounded or continuation unavailable; not an exact total.',
  })
  truncated!: boolean;
}
export class KeywordSearchResponseDto {
  @ApiProperty({ type: [KeywordResultDto], maxItems: 20 })
  results!: KeywordResultDto[];
  @ApiProperty({ type: KeywordCoverageDto }) coverage!: KeywordCoverageDto;
  @ApiProperty({ type: KeywordPaginationDto })
  pagination!: KeywordPaginationDto;
}
