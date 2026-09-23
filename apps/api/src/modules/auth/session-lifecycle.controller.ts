import {
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { validateSessionMutation } from './request-security';
import { ConfigurationService } from '../../configuration/configuration.module';
import { AuthenticationCookies } from './authentication-cookies';
import { SessionLifecycleService } from './session-lifecycle.service';
import { sessionToken } from './session.service';

/**
 * @author Cristono Wijaya
 * @description Handles cookie-based refresh and idempotent logout with shared Origin and CSRF validation.
 * @tags Authentication
 * @class SessionLifecycleController
 */
@ApiTags('Authentication')
@ApiHeader({
  name: 'X-CSRF-Protection',
  required: true,
  schema: { type: 'string', enum: ['1'] },
  description:
    'Required custom header; browser Origin must also be allowlisted.',
})
@ApiForbiddenResponse({
  description:
    'Missing CSRF-protection header or untrusted Origin; standard FORBIDDEN envelope.',
})
@Controller('auth')
export class SessionLifecycleController {
  /**
   * @author Cristono Wijaya
   * @description Initializes SessionLifecycleController with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes SessionLifecycleController with the providers supplied by NestJS.
   * @param lifecycle - The service rotating tokens and persisting logout revocations.
   * @param cookies - The helper writing and clearing authentication cookies with matching attributes.
   * @param configuration - The typed provider for validated application settings.
   */
  constructor(
    private readonly lifecycle: SessionLifecycleService,
    private readonly cookies: AuthenticationCookies,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Rotates valid refresh credentials and writes replacement cookies. Invalid credentials clear cookies and return a generic 401.
   * @tags Authentication
   * @param request - The incoming HTTP request.
   * @param response - The HTTP response used to write or clear cookies.
   * @returns - The renewed session expiration as an ISO timestamp; replacement tokens are set only in cookies.
   * @throws UnauthorizedException - Refresh credentials are invalid; mutation-security and persistence failures are propagated.
   */
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth('refresh')
  @ApiOperation({
    summary: 'Rotate session and refresh tokens',
    description:
      'Uses the refresh cookie. Reuse revokes the session; concurrent refresh requests must be serialized by clients. Absolute refresh expiration is not extended. No request body is required.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { expiresAt: { type: 'string', format: 'date-time' } },
        },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    headers: {
      'Set-Cookie': {
        schema: { type: 'string' },
        description: 'Rotated HttpOnly session and refresh cookies.',
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
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    validateSessionMutation(request, this.configuration.cors);
    const token = sessionToken(
      request.headers.cookie,
      this.configuration.cookie.refreshName,
    );
    const result = token ? await this.lifecycle.refresh(token) : null;
    if (!result) {
      this.cookies.clear(response);
      throw new UnauthorizedException();
    }
    this.cookies.set(response, result);
    return { expiresAt: result.expiresAt.toISOString() };
  }

  /**
   * @author Cristono Wijaya
   * @description Revokes the session identified by the cookies and clears matching cookie scopes after a successful persistence operation.
   * @tags Authentication
   * @param request - The incoming HTTP request.
   * @param response - The HTTP response used to write or clear cookies.
   * @returns - An object with loggedOut set to true after revocation and cookie clearing.
   * @throws ForbiddenException or BadRequestException - Mutation validation fails; persistence failures are propagated.
   */
  @Post('logout')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Revoke the current session and clear cookies',
    description:
      'Idempotent, including missing/invalid/expired cookies. Session cookie takes precedence; a current or consumed refresh cookie can identify the session when access credentials are absent. No body is required.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { loggedOut: { type: 'boolean', enum: [true] } },
        },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    validateSessionMutation(request, this.configuration.cors);
    await this.lifecycle.logout(
      sessionToken(request.headers.cookie, this.configuration.cookie.name),
      sessionToken(
        request.headers.cookie,
        this.configuration.cookie.refreshName,
      ),
    );
    this.cookies.clear(response);
    return { loggedOut: true };
  }
}
