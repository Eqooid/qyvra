import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * @author Cristono Wijaya
 * @description Defines registration input validation. Configurable password-strength checks run in PasswordService.
 * @tags Authentication
 * @class RegistrationDto
 */
export class RegistrationDto {
  /**
   * @author Cristono Wijaya
   * @description Normalizes email casing and surrounding whitespace before validating the address.
   * @tags Authentication
   * @type {string}
   */
  @ApiProperty({ format: 'email', maxLength: 320 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({ allow_utf8_local_part: false })
  @MaxLength(320)
  declare email: string;

  /**
   * @author Cristono Wijaya
   * @description Preserves the submitted password and applies a transport size bound before service-level policy validation.
   * @tags Authentication
   * @type {string}
   */
  @ApiProperty({
    format: 'password',
    writeOnly: true,
    description:
      'Unmodified password; configured Unicode code-point length limits apply (default 15–128). Spaces are allowed.',
  })
  @IsString()
  @MaxLength(2048)
  declare password: string;
}
