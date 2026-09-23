import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CursorQuery } from '../../common/cursor-query';
import { normalizeOwnedName } from '../../common/normalize-owned-name';

/**
 * @author Cristono Wijaya
 * @description Tag names reuse the exact Categories normalization and validation policy.
 * @tags Tags
 */
export class CreateTagDto {
  /**
   * @author Cristono Wijaya
   * @description The name of the tag, which must be a non-empty string between 1 and 100 characters, excluding control characters.
   * @tags Tags
   * @example 'Finance'
   * @minLength 1
   * @maxLength 100
   * @pattern /^[^\u0000-\u001f\u007f]+$/
   */
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Finance' })
  @Transform(({ value }: { value: unknown }) => normalizeOwnedName(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare name: string;
}

/**
 * @author Cristono Wijaya
 * @description Name is the sole editable field, so an update requires a valid name.
 * @tags Tags
 */
export class UpdateTagDto extends CreateTagDto {}

/**
 * @author Cristono Wijaya
 * @description Adds optional literal-substring search to the shared bounded cursor contract.
 * @tags Tags
 */
export class TagListQuery extends CursorQuery {
  /**
   * @author Cristono Wijaya
   * @description Case-insensitive literal substring. Omit q for all owned tags; blank q is invalid.
   * @tags Tags
   * @example 'finance'
   * @minLength 1
   * @maxLength 100
   */
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 100,
    example: 'finance',
    description:
      'Case-insensitive literal substring. Omit q for all owned tags; blank q is invalid.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => normalizeOwnedName(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare q?: string;
}
