import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** @author Cristono Wijaya
 * @description Validates UUID-ordered cursor pagination; no arbitrary filters or owner parameters are accepted.
 * @tags Pagination
 */
export class CursorQuery {
  /** @description Maximum page size, default 25 and capped at 100. */
  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  /** @description Exclusive UUID bound, independent of resource ownership or existence. */
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsUUID()
  declare cursor?: string;

  /** @description Ascending UUID order shared by the Categories and Tags contracts. */
  @ApiPropertyOptional({ default: 'id', enum: ['id'] })
  @IsIn(['id'])
  sort = 'id';
}
