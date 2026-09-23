import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * @author Cristono Wijaya
 * @description Validates IANA timezone names using the runtime, excluding numeric UTC offsets.
 * @tags Profile Validation
 * @param value - An untrusted timezone value.
 * @returns - Whether the value is UTC or a supported IANA timezone name.
 */
function validTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 100) return false;
  if (value === 'UTC') return true;
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * @author Cristono Wijaya
 * @description Allows only explicitly supported profile changes; omitted values are preserved and null is rejected.
 * @tags Profile Validation
 * @class UpdateProfileDto
 */
export class UpdateProfileDto {
  /** @description Display name, trimmed before validation; 1–100 characters without control characters. */
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare displayName?: string;

  /** @description A supported IANA timezone name or UTC. */
  @ApiPropertyOptional({ example: 'Asia/Bangkok', maxLength: 100 })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @ValidateBy({
    name: 'supportedTimezone',
    validator: { validate: validTimezone },
  })
  declare timezone?: string;

  /** @description A canonical BCP 47 locale supported by the runtime, at most 35 characters. */
  @ApiPropertyOptional({ example: 'en-US', maxLength: 35 })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @ValidateBy({
    name: 'supportedLocale',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string' || value.length > 35) return false;
        try {
          return (
            Intl.getCanonicalLocales(value)[0] === value &&
            Intl.DateTimeFormat.supportedLocalesOf([value]).length === 1
          );
        } catch {
          return false;
        }
      },
    },
  })
  declare locale?: string;
}

/**
 * @author Cristono Wijaya
 * @description Validates password transport input without normalizing either password. PasswordService enforces new-password strength.
 * @tags Password Change
 * @class ChangePasswordDto
 */
export class ChangePasswordDto {
  /** @description The exact existing local password; never log it. */
  @ApiProperty({
    format: 'password',
    writeOnly: true,
    minLength: 1,
    maxLength: 2048,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  declare currentPassword: string;

  /** @description The exact replacement password; validated against configured Unicode code-point limits. */
  @ApiProperty({
    format: 'password',
    writeOnly: true,
    maxLength: 2048,
    description: 'Existing configurable registration password policy applies.',
  })
  @IsString()
  @MaxLength(2048)
  declare newPassword: string;
}
