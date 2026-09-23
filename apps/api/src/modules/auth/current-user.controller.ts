import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from './authenticated-user';
import { SessionAuthGuard } from './session-auth.guard';

/**
 * @author Cristono Wijaya
 * @description Exposes the current-user endpoint behind the reusable session guard.
 * @tags Authentication
 * @class CurrentUserController
 */
@ApiTags('Authentication')
@Controller('auth')
export class CurrentUserController {
  /**
   * @author Cristono Wijaya
   * @description Returns only the trusted public profile. The global interceptor adds the standard success envelope.
   * @tags Authentication
   * @param user - The trusted public profile supplied by the authentication guard.
   * @returns - The trusted public profile, wrapped by the global success interceptor.
   * @throws UnauthorizedException - The guard or current-user decorator rejects unauthenticated requests before this method runs.
   */
  @Get('me')
  @UseGuards(SessionAuthGuard)
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: 'Get the authenticated user',
    description:
      'Uses only the configured session cookie. Request-provided user IDs cannot select another profile. Session validity is checked on every request; activity is recorded at most once per minute.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            displayName: { type: 'string', nullable: true },
            locale: { type: 'string' },
            timezone: { type: 'string' },
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
  me(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
  ): Readonly<AuthenticatedUser> {
    return user;
  }
}
