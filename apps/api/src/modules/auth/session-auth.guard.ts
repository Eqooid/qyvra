import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigurationService } from '../../configuration/configuration.module';
import {
  AUTHENTICATED_USER,
  AUTHENTICATED_SESSION,
  AuthenticatedRequest,
} from './authenticated-user';
import { SessionService, sessionToken } from './session.service';

/**
 * @author Cristono Wijaya
 * @description Authenticates protected HTTP requests through the configured session cookie and attaches trusted ownership context.
 * @tags Authentication
 * @class SessionAuthGuard
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  /**
   * @author Cristono Wijaya
   * @description Initializes SessionAuthGuard with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes SessionAuthGuard with the providers supplied by NestJS.
   * @param sessions - The service implementing session authentication or owned-session operations.
   * @param configuration - The typed provider for validated application settings.
   */
  constructor(
    private readonly sessions: SessionService,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Clears any previous context, validates the session against PostgreSQL, and attaches the verified user and session or throws UnauthorizedException.
   * @tags Authentication
   * @param context - The trusted request or session context supplied by NestJS.
   * @returns - true after trusted user and session context have been attached.
   * @throws UnauthorizedException - The session cookie is missing or invalid; database failures are propagated.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    delete request[AUTHENTICATED_USER];
    delete request[AUTHENTICATED_SESSION];
    const token = sessionToken(
      request.headers.cookie,
      this.configuration.cookie.name,
    );
    if (!token) throw new UnauthorizedException();
    const session = await this.sessions.authenticateSession(token);
    if (!session) throw new UnauthorizedException();
    request[AUTHENTICATED_USER] = session.user;
    request[AUTHENTICATED_SESSION] = session;
    return true;
  }
}
