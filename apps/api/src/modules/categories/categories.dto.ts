import { CursorQuery } from '../../common/cursor-query';
import { normalizeOwnedName as normalizeCategoryName } from '../../common/normalize-owned-name';
export { normalizeCategoryName };
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

/** @author Cristono Wijaya
 * @description Accepts category styling and a required name; ownership is never a DTO field.
 * @tags Categories
 */
export class CreateCategoryDto {
  /** @description Display name; database uniqueness uses lower(name) per owner. */
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Personal records' })
  @Transform(({ value }: { value: unknown }) => normalizeCategoryName(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare name: string;

  /** @description Optional six-digit CSS hex color; null clears custom styling. */
  @ApiPropertyOptional({
    nullable: true,
    pattern: '^#[0-9a-fA-F]{6}$',
    example: '#336699',
  })
  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsString()
  @Matches(/^#[0-9a-f]{6}$/)
  declare color?: string | null;

  /** @description Optional renderer-neutral icon slug, never HTML, SVG, a URL or a file path. */
  @ApiPropertyOptional({
    nullable: true,
    maxLength: 50,
    example: 'folder-open',
    pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
  })
  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  declare icon?: string | null;
}

/** @author Cristono Wijaya
 * @description Partial category edits; omission preserves values, and name cannot be null.
 * @tags Categories
 */
export class UpdateCategoryDto extends PartialType(CreateCategoryDto, {
  skipNullProperties: false,
}) {}

/** @description Reuses the shared cursor policy without changing the Categories contract. */
export class CategoryListQuery extends CursorQuery {}
