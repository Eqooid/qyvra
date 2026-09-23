import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Header,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RegistrationDto } from './registration.dto';
import { RegistrationService } from './registration.service';
import {
  InvalidRegistration,
  RegistrationConflict,
} from './registration.errors';

/**
 * @author Cristono Wijaya
 * @description Builds the documented registration error envelope without including submitted account details.
 * @tags Authentication
 * @param code - The public error code.
 * @param message - The public error message.
 * @constant errorSchema - The shared errorSchema definition.
 * @returns - The OpenAPI error-envelope schema with the specified public code and message.
 */
const errorSchema = (code: string, message: string) => ({
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', enum: [code] },
        message: { type: 'string', enum: [message] },
        details: { type: 'object', additionalProperties: false },
        traceId: { type: 'string', format: 'uuid' },
      },
    },
  },
});

/**
 * @author Cristono Wijaya
 * @description Exposes local registration and translates application errors into standard HTTP failures.
 * @tags Authentication
 * @class RegistrationController
 */
@ApiTags('Authentication')
@Controller('auth')
export class RegistrationController {
  /**
   * @author Cristono Wijaya
   * @description Initializes RegistrationController with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes RegistrationController with the providers supplied by NestJS.
   * @param registration - The application service coordinating local account registration.
   */
  constructor(private readonly registration: RegistrationService) {}

  /**
   * @author Cristono Wijaya
   * @description Creates a local account and maps invalid input or uniqueness conflicts to safe responses. Does not create a session.
   * @tags Authentication
   * @param dto - Validated credentials; never log the DTO.
   * @returns - The new user UUID and normalized email, without a session or credential fields.
   * @throws BadRequestException or ConflictException - Application validation or uniqueness fails; other failures are propagated.
   */
  @Post('register')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Register a local account',
    description:
      'Creates a user, LOCAL identity and credentials atomically. Does not create a session or set a cookie.',
  })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
          },
        },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  @ApiBadRequestResponse({ schema: errorSchema('BAD_REQUEST', 'Bad Request') })
  @ApiConflictResponse({ schema: errorSchema('CONFLICT', 'Conflict') })
  async register(@Body() dto: RegistrationDto) {
    try {
      return await this.registration.register(dto.email, dto.password);
    } catch (error) {
      if (error instanceof InvalidRegistration) throw new BadRequestException();
      if (error instanceof RegistrationConflict) throw new ConflictException();
      throw error;
    }
  }
}
