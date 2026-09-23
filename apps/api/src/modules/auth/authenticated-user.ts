import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * @author Cristono Wijaya
 * @description Defines the safe public profile carried by trusted authentication context, excluding credentials and security metadata.
 * @tags Authentication
 * @interface AuthenticatedUser
 */
export interface AuthenticatedUser {
  /**
   * @author Cristono Wijaya
   * @description The stable internal user UUID used for resource ownership.
   * @tags Authentication
   * @type {string}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly id: string;
  /**
   * @author Cristono Wijaya
   * @description The public account email address; it is not the external identity key.
   * @tags Authentication
   * @type {string}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly email: string;
  /**
   * @author Cristono Wijaya
   * @description The optional public display name; null means no name is stored.
   * @tags Authentication
   * @type {string | null}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly displayName: string | null;
  /**
   * @author Cristono Wijaya
   * @description The user's stored locale preference.
   * @tags Authentication
   * @type {string}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly locale: string;
  /**
   * @author Cristono Wijaya
   * @description The user's stored time-zone preference.
   * @tags Authentication
   * @type {string}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly timezone: string;
}

// A symbol cannot be supplied through HTTP body/query/header properties.
/**
 * @author Cristono Wijaya
 * @description Stores the guard-verified profile under a symbol that HTTP input cannot provide.
 * @tags Authentication
 * @constant AUTHENTICATED_USER - The shared AUTHENTICATED_USER definition.
 */
export const AUTHENTICATED_USER = Symbol('AUTHENTICATED_USER');
/**
 * @author Cristono Wijaya
 * @description Stores the guard-verified session context separately from public profile fields.
 * @tags Authentication
 * @constant AUTHENTICATED_SESSION - The shared AUTHENTICATED_SESSION definition.
 */
export const AUTHENTICATED_SESSION = Symbol('AUTHENTICATED_SESSION');
/**
 * @author Cristono Wijaya
 * @description Pairs the trusted user profile with the current internal session ID for owned-session operations.
 * @tags Authentication
 * @interface AuthenticatedSession
 */
export interface AuthenticatedSession {
  /**
   * @author Cristono Wijaya
   * @description The immutable public profile verified by session authentication.
   * @tags Authentication
   * @type {Readonly<AuthenticatedUser>}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly user: Readonly<AuthenticatedUser>;
  /**
   * @author Cristono Wijaya
   * @description The internal UUID of the authenticated session.
   * @tags Authentication
   * @type {string}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly sessionId: string;
}
/**
 * @author Cristono Wijaya
 * @description Extends the HTTP request with optional symbol-keyed context populated only after session authentication.
 * @tags Authentication
 * @interface AuthenticatedRequest
 */
export interface AuthenticatedRequest extends Request {
  /**
   * @author Cristono Wijaya
   * @description The optional trusted profile attached by SessionAuthGuard, inaccessible through HTTP property names.
   * @tags Authentication
   * @type {Readonly<AuthenticatedUser>}
   */
  [AUTHENTICATED_USER]?: Readonly<AuthenticatedUser>;
  /**
   * @author Cristono Wijaya
   * @description The optional trusted session context attached by SessionAuthGuard.
   * @tags Authentication
   * @type {Readonly<AuthenticatedSession>}
   */
  [AUTHENTICATED_SESSION]?: Readonly<AuthenticatedSession>;
}

/**
 * @author Cristono Wijaya
 * @description Injects the trusted profile into a controller parameter and rejects requests without authenticated context.
 * @tags Authentication
 * @constant CurrentUser - The shared CurrentUser definition.
 * @example
 * ```ts
 * me(@CurrentUser() user: Readonly<AuthenticatedUser>) { return user; }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Readonly<AuthenticatedUser> => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>()[
      AUTHENTICATED_USER
    ];
    if (!user) throw new UnauthorizedException();
    return user;
  },
);

/**
 * @author Cristono Wijaya
 * @description Injects the trusted user and session IDs into a controller parameter and rejects missing context.
 * @tags Authentication
 * @constant CurrentSession - The shared CurrentSession definition.
 * @example
 * ```ts
 * list(@CurrentSession() context: AuthenticatedSession) {
 *   return this.sessions.list(context, 50);
 * }
 * ```
 */
export const CurrentSession = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext,
  ): Readonly<AuthenticatedSession> => {
    const session = context.switchToHttp().getRequest<AuthenticatedRequest>()[
      AUTHENTICATED_SESSION
    ];
    if (!session) throw new UnauthorizedException();
    return session;
  },
);
