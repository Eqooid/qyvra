import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ConfigurationService } from '../../configuration/configuration.module';
import { LoginDto } from './login.dto';
import { InvalidCredentials, LoginService } from './login.service';
import { AuthenticationCookies } from './authentication-cookies';
import { validateBrowserOrigin } from './request-security';

/**
 * @author Cristono Wijaya
 * @description Handles local login transport rules and writes authentication cookies without exposing tokens in the response body.
 * @tags Authentication
 * @class LoginController
 */
@ApiTags('Authentication')
@Controller('auth')
export class LoginController {
  /**
   * @author Cristono Wijaya
   * @description Initializes LoginController with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes LoginController with the providers supplied by NestJS.
   * @param loginService - The application service verifying credentials and creating sessions.
   * @param configuration - The typed provider for validated application settings.
   * @param cookies - The helper writing and clearing authentication cookies with matching attributes.
   */
  constructor(
    private readonly loginService: LoginService,
    private readonly configuration: ConfigurationService,
    private readonly cookies: AuthenticationCookies,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Requires JSON and an allowed browser origin, authenticates credentials, and maps credential failures to a generic 401 response.
   * @tags Authentication
   * @param dto - Validated credentials; never log the DTO.
   * @param request - The incoming HTTP request.
   * @param response - The HTTP response used to write or clear cookies.
   * @returns - The safe account identity and ISO session expiration; tokens are delivered only through cookies.
   * @throws UnauthorizedException - Credentials are invalid; unsupported media, untrusted origins, and infrastructure failures are propagated.
   */
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Authenticate locally and create a session',
    description:
      'Sets separate HttpOnly session and refresh cookies. Unknown, deleted, locked accounts and incorrect passwords receive the same 401 response. Browser Origin must be in CORS_ORIGINS; JSON only. No token values appear in JSON.',
  })
  @ApiOkResponse({
    headers: {
      'Set-Cookie': {
        description:
          'Session and refresh HttpOnly cookies with validated security attributes.',
        schema: { type: 'string' },
      },
    },
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                email: { type: 'string', format: 'email' },
              },
            },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    schema: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', enum: ['UNAUTHORIZED'] },
            message: { type: 'string', enum: ['Unauthorized'] },
            details: { type: 'object', additionalProperties: false },
            traceId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid DTO; standard BAD_REQUEST envelope.',
  })
  @ApiForbiddenResponse({
    description: 'Untrusted browser origin; standard FORBIDDEN envelope.',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!request.is('application/json'))
      throw new UnsupportedMediaTypeException();
    validateBrowserOrigin(request, this.configuration.cors);
    try {
      const result = await this.loginService.login(dto.email, dto.password);
      this.cookies.set(response, result);
      return { user: result.user, expiresAt: result.expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof InvalidCredentials)
        throw new UnauthorizedException();
      throw error;
    }
  }
}
