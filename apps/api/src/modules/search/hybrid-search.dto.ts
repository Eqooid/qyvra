import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  KeywordCoverageDto,
  KeywordMatchDto,
  KeywordPaginationDto,
  KeywordResultDto,
} from './keyword-search.dto';

export class ChunkMatchDto {
  @ApiProperty({ enum: ['chunk'] }) kind!: 'chunk';
  @ApiProperty({ maxLength: 1024 }) snippet!: string;
  @ApiProperty({ format: 'uuid' }) chunkId!: string;
  @ApiProperty({ format: 'uuid' }) chunkSetId!: string;
  @ApiProperty({ format: 'uuid' }) indexManifestId!: string;
  @ApiProperty({ format: 'uuid' }) embeddingProfileId!: string;
  @ApiProperty({ minimum: 0 }) startOffset!: number;
  @ApiProperty({ minimum: 0 }) endOffset!: number;
}
@ApiExtraModels(KeywordMatchDto, ChunkMatchDto)
export class HybridResultDto extends OmitType(KeywordResultDto, [
  'ranking',
  'matches',
  'projectionId',
] as const) {
  @ApiPropertyOptional({ format: 'uuid' }) projectionId?: string;
  @ApiProperty({ enum: ['document-rrf60-v1'] }) ranking!: 'document-rrf60-v1';
  @ApiProperty({
    maxItems: 3,
    type: 'array',
    items: {
      oneOf: [
        { $ref: getSchemaPath(KeywordMatchDto) },
        { $ref: getSchemaPath(ChunkMatchDto) },
      ],
    },
  })
  matches!: (KeywordMatchDto | ChunkMatchDto)[];
}
export class HybridSearchResponseDto {
  @ApiProperty({ enum: ['hybrid'] }) mode!: 'hybrid';
  @ApiProperty({ type: [HybridResultDto], maxItems: 20 })
  results!: HybridResultDto[];
  @ApiProperty({ type: KeywordCoverageDto }) coverage!: KeywordCoverageDto;
  @ApiProperty({ type: KeywordPaginationDto })
  pagination!: KeywordPaginationDto;
}
