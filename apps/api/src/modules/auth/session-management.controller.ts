import {
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Request, Response } from 'express';
import { validateSessionMutation } from './request-security';
import { ConfigurationService } from '../../configuration/configuration.module';
import { AuthenticatedSession, CurrentSession } from './authenticated-user';
import { SessionAuthGuard } from './session-auth.guard';
import { AuthenticationCookies } from './authentication-cookies';
import {
  SessionManagementService,
  SessionNotFound,
} from './session-management.service';

/**
 * @author Cristono Wijaya
 * @description Validates bounded session-list pagination using an optional exclusive UUID cursor.
 * @tags Authentication
 * @class SessionListQuery
 */
export class SessionListQuery {
  /**
   * @author Cristono Wijaya
   * @description Caps the number of returned sessions at 100 and defaults to 50.
   * @tags Authentication
   * @type {number}
   */
  @ApiPropertyOptional({ type: Number, default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
  /**
   * @author Cristono Wijaya
   * @description Identifies the last session from the previous page; it never supplies an ownership identity.
   * @tags Authentication
   * @type {string}
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Exclusive UUID cursor from the previous response.',
  })
  @IsOptional()
  @IsUUID()
  declare cursor?: string;
}

/**
 * @author Cristono Wijaya
 * @description Documents the safe session projection without tokens, hashes, or collected device information.
 * @tags Authentication
 * @constant metadataSchema - The shared metadataSchema definition.
 */
const metadataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
    expiresAt: { type: 'string', format: 'date-time' },
    refreshExpiresAt: { type: 'string', format: 'date-time', nullable: true },
    isCurrent: { type: 'boolean' },
  },
};
/**
 * @author Cristono Wijaya
 * @description Wraps a Swagger data schema in the standard success envelope with request correlation metadata.
 * @tags Authentication
 * @param data - The Swagger schema for the response data.
 * @constant envelope - The shared envelope definition.
 * @returns - The OpenAPI success-envelope schema containing data and correlation metadata.
 */
const envelope = (data: object) => ({
  type: 'object',
  properties: {
    data,
    meta: {
      type: 'object',
      properties: { requestId: { type: 'string', format: 'uuid' } },
    },
  },
});

/**
 * @author Cristono Wijaya
 * @description Exposes authenticated session listing and owned-session revocation with shared mutation security checks.
 * @tags Authentication
 * @class SessionManagementController
 */
@ApiTags('Sessions')
@ApiCookieAuth('session')
@ApiUnauthorizedResponse({
  description: 'Missing or invalid session; standard UNAUTHORIZED envelope.',
})
@UseGuards(SessionAuthGuard)
@Controller('me/sessions')
export class SessionManagementController {
  /**
   * @author Cristono Wijaya
   * @description Initializes SessionManagementController with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes SessionManagementController with the providers supplied by NestJS.
   * @param sessions - The service implementing session authentication or owned-session operations.
   * @param configuration - The typed provider for validated application settings.
   * @param cookies - The helper writing and clearing authentication cookies with matching attributes.
   */
  constructor(
    private readonly sessions: SessionManagementService,
    private readonly configuration: ConfigurationService,
    private readonly cookies: AuthenticationCookies,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Lists only sessions belonging to the guard-authenticated user with validated pagination.
   * @tags Authentication
   * @param context - The trusted request or session context supplied by NestJS.
   * @param query - Validated session-list pagination settings.
   * @returns - A page of safe owned-session metadata and its optional continuation cursor.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List your active or renewable sessions',
    description:
      'Only owned, unrevoked sessions with unexpired access or refresh are included. Ordered by UUID; no device information is collected.',
  })
  @ApiOkResponse({
    schema: envelope({
      type: 'object',
      properties: {
        sessions: { type: 'array', items: metadataSchema },
        nextCursor: { type: 'string', format: 'uuid', nullable: true },
      },
    }),
  })
  list(
    @CurrentSession() context: AuthenticatedSession,
    @Query() query: SessionListQuery,
  ) {
    return this.sessions.list(context, query.limit, query.cursor);
  }

  /**
   * @author Cristono Wijaya
   * @description Revokes the authenticated user's other sessions while preserving the current session.
   * @tags Authentication
   * @param context - The trusted request or session context supplied by NestJS.
   * @param request - The incoming HTTP request.
   * @returns - An object containing the number of sessions newly revoked.
   * @throws ForbiddenException or BadRequestException - Mutation validation fails; persistence failures are propagated.
   */
  @Delete('others')
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiOperation({
    summary: 'Revoke all your other sessions',
    description:
      'Preserves only the authenticated session. Idempotent. Requires the CSRF header and trusted browser Origin; no body/query fields.',
  })
  @ApiOkResponse({
    schema: envelope({
      type: 'object',
      properties: { revokedCount: { type: 'integer' } },
    }),
  })
  async others(
    @CurrentSession() context: AuthenticatedSession,
    @Req() request: Request,
  ) {
    validateSessionMutation(request, this.configuration.cors);
    return { revokedCount: await this.sessions.revokeOthers(context) };
  }

  /**
   * @author Cristono Wijaya
   * @description Revokes an owned session idempotently, maps missing or foreign sessions to 404, and clears cookies when revoking the current session.
   * @tags Authentication
   * @param context - The trusted request or session context supplied by NestJS.
   * @param id - The internal ID of the session being revoked.
   * @param request - The incoming HTTP request.
   * @param response - The HTTP response used to write or clear cookies.
   * @returns - An object with revoked set to true for an owned session, including one already revoked.
   * @throws NotFoundException - The session is missing or unowned; validation and persistence failures are propagated.
   */
  @Delete(':sessionId')
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiOperation({
    summary: 'Revoke one of your sessions',
    description:
      'Already revoked owned sessions return success. Missing and foreign sessions share 404. Revoking the authenticated session clears authentication cookies.',
  })
  @ApiNotFoundResponse({
    description: 'Missing or unowned session; standard NOT_FOUND envelope.',
  })
  @ApiOkResponse({
    schema: envelope({
      type: 'object',
      properties: { revoked: { type: 'boolean', enum: [true] } },
    }),
  })
  async revoke(
    @CurrentSession() context: AuthenticatedSession,
    @Param('sessionId', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    validateSessionMutation(request, this.configuration.cors);
    try {
      await this.sessions.revoke(context, id);
    } catch (error) {
      if (error instanceof SessionNotFound) throw new NotFoundException();
      throw error;
    }
    if (id === context.sessionId) this.cookies.clear(response);
    return { revoked: true };
  }
}
