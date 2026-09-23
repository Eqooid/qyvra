import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ConfigurationService } from '../../configuration/configuration.module';
import { AuthenticatedSession, CurrentSession } from './authenticated-user';
import { AuthenticationCookies } from './authentication-cookies';
import { SessionAuthGuard } from './session-auth.guard';
import { ProfileService } from './profile.service';
import { ChangePasswordDto, UpdateProfileDto } from './profile.dto';
import { InvalidCredentials } from './login.service';
import { InvalidRegistration } from './registration.errors';
import {
  validateAuthenticatedMutation,
  validateSessionMutation,
} from './request-security';

/** @author Cristono Wijaya
 * @description Documents the public profile projection inside the shared success envelope.
 * @tags Profile
 * @constant profileSchema - Contains no credential or session fields.
 */
const profileSchema = {
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'email', 'displayName', 'locale', 'timezone'],
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
};

/** @author Cristono Wijaya
 * @description Documents an acknowledged profile/security mutation using the standard envelope.
 * @param field - The public success flag.
 * @returns - The OpenAPI response schema.
 */
const acknowledgement = (field: string) => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data: {
      type: 'object',
      required: [field],
      additionalProperties: false,
      properties: { [field]: { type: 'boolean', enum: [true] } },
    },
    meta: {
      type: 'object',
      properties: { requestId: { type: 'string', format: 'uuid' } },
    },
  },
});

/** @author Cristono Wijaya
 * @description Exposes trusted current-user profile operations and logout-all without accepting ownership from HTTP input.
 * @tags Profile
 * @class ProfileController
 */
@ApiTags('Profile')
@ApiCookieAuth('session')
@ApiUnauthorizedResponse({
  description:
    'Missing, invalid or revoked session; incorrect current password uses the same generic response.',
})
@ApiBadRequestResponse({
  description: 'Invalid or unsupported fields; standard BAD_REQUEST envelope.',
})
@UseGuards(SessionAuthGuard)
@Controller()
export class ProfileController {
  /** @author Cristono Wijaya
   * @constructor - Injects profile operations and existing transport-security helpers.
   * @param profiles - The profile and credential application service.
   * @param configuration - Validated CORS policy.
   * @param cookies - Matching cookie writer/clearer.
   */
  constructor(
    private readonly profiles: ProfileService,
    private readonly configuration: ConfigurationService,
    private readonly cookies: AuthenticationCookies,
  ) {}

  /** @author Cristono Wijaya
   * @description Returns the same trusted profile as the preserved /auth/me endpoint.
   * @param context - Guard-populated session context.
   * @returns - Safe public profile fields.
   */
  @Get('me')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get your public profile',
    description:
      'Compatibility route for /auth/me; request-provided user IDs never select another user.',
  })
  @ApiOkResponse({ schema: profileSchema })
  me(@CurrentSession() context: AuthenticatedSession) {
    return context.user;
  }

  /** @author Cristono Wijaya
   * @description Validates mutation security and requires at least one supported profile field.
   * @param context - Trusted user and session identity.
   * @param dto - Validated profile changes.
   * @param request - Request used for Origin, CSRF and query checks.
   * @returns - Updated safe public profile.
   */
  @Patch('me')
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiForbiddenResponse({
    description: 'Missing CSRF header or untrusted Origin.',
  })
  @ApiOperation({
    summary: 'Update your profile',
    description:
      'Nonempty partial update of displayName, timezone and locale only. Null values and query parameters are rejected. Timezones and canonical BCP 47 locales must be supported by the server runtime.',
  })
  @ApiOkResponse({ schema: profileSchema })
  update(
    @CurrentSession() context: AuthenticatedSession,
    @Body() dto: UpdateProfileDto,
    @Req() request: Request,
  ) {
    validateAuthenticatedMutation(request, this.configuration.cors);
    if (!dto || !Object.keys(dto).length) throw new BadRequestException();
    return this.profiles.update(context, dto);
  }

  /** @author Cristono Wijaya
   * @description Changes a verified local password and maps credential/policy errors to generic HTTP responses.
   * @param context - Trusted current session, which remains active after success.
   * @param dto - Private password input; never log it.
   * @param request - Request used for mutation security checks.
   * @returns - Only a passwordChanged acknowledgement.
   */
  @Patch('me/password')
  @ApiTooManyRequestsResponse({
    description:
      'Shares the configured login and global authentication budgets; Retry-After indicates seconds until retry.',
  })
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiForbiddenResponse({
    description: 'Missing CSRF header or untrusted Origin.',
  })
  @ApiOperation({
    summary: 'Change your local password',
    description:
      'Requires currentPassword and newPassword. Atomically updates the credential and revokes all other sessions, preserving the current session. Existing password policy applies; non-local accounts and incorrect current passwords return generic 401.',
  })
  @ApiOkResponse({ schema: acknowledgement('passwordChanged') })
  async password(
    @CurrentSession() context: AuthenticatedSession,
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
  ) {
    validateAuthenticatedMutation(request, this.configuration.cors);
    try {
      await this.profiles.changePassword(
        context,
        dto.currentPassword,
        dto.newPassword,
      );
    } catch (error) {
      if (error instanceof InvalidCredentials)
        throw new UnauthorizedException();
      if (error instanceof InvalidRegistration) throw new BadRequestException();
      throw error;
    }
    return { passwordChanged: true };
  }

  /** @author Cristono Wijaya
   * @description Revokes all owned sessions and clears current cookies after commit. Subsequent unauthenticated retries return 401 without further effects.
   * @param context - Trusted ownership context.
   * @param request - Request with required CSRF header and no body/query fields.
   * @param response - Response on which matching authentication cookies are cleared.
   * @returns - Only a loggedOut acknowledgement.
   */
  @Post('auth/logout-all')
  @HttpCode(200)
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiForbiddenResponse({
    description: 'Missing CSRF header or untrusted Origin.',
  })
  @ApiOperation({
    summary: 'Revoke all your sessions',
    description:
      'Requires authentication, revokes only owned sessions, and clears current cookies. A repeat with revoked/missing credentials returns 401 with no additional revocation. Concurrent requests already authenticated may return success.',
  })
  @ApiOkResponse({
    schema: acknowledgement('loggedOut'),
    headers: {
      'Set-Cookie': {
        description:
          'Expires both authentication cookies using their configured attributes.',
        schema: { type: 'string' },
      },
    },
  })
  async logoutAll(
    @CurrentSession() context: AuthenticatedSession,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    validateSessionMutation(request, this.configuration.cors);
    await this.profiles.logoutAll(context);
    this.cookies.clear(response);
    return { loggedOut: true };
  }
}
