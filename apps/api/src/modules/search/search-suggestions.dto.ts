import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateBy,
} from 'class-validator';
import { KeywordSearchDto, plainKeyword } from './keyword-search.dto';
export class SearchSuggestionsDto extends PickType(KeywordSearchDto, [
  'filters',
  'documentIds',
] as const) {
  @ApiProperty({
    minLength: 1,
    maxLength: 200,
    description:
      'NFC plain prefix, 2-200 UTF-16 units; at least one letter/number.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @MinLength(1)
  @ValidateBy({
    name: 'prefixUnits',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        value.length >= 2 &&
        value.length <= 200 &&
        plainKeyword(value),
    },
  })
  @MaxLength(200)
  prefix!: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 10, default: 5 })
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}
export class SearchSuggestionDto {
  @ApiProperty({ maxLength: 200 }) text!: string;
  @ApiProperty({ enum: ['title', 'issuer', 'referenceNumber'] }) type!:
    'title' | 'issuer' | 'referenceNumber';
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ format: 'uuid' }) documentVersionId!: string;
}
export class SearchSuggestionsResponseDto {
  @ApiProperty({ type: [SearchSuggestionDto], maxItems: 10 })
  suggestions!: SearchSuggestionDto[];
}
