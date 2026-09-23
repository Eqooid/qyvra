import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * @author Cristono Wijaya
 * @description Validates login input while preserving the existing password exactly; registration strength rules are not reapplied.
 * @tags Authentication
 * @class LoginDto
 */
export class LoginDto {
  /**
   * @author Cristono Wijaya
   * @description Trims and lowercases the email before validating its format and maximum length.
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
   * @description Accepts a nonempty password within the transport limit without trimming or normalizing it.
   * @tags Authentication
   * @type {string}
   */
  @ApiProperty({
    format: 'password',
    writeOnly: true,
    description:
      'Existing password, preserved exactly. Current registration strength rules do not apply.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  declare password: string;
}
