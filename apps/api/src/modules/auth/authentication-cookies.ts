import { Injectable } from '@nestjs/common';
import { Response } from 'express';
import { ConfigurationService } from '../../configuration/configuration.module';

/**
 * @author Cristono Wijaya
 * @description Carries transient raw tokens and expiration dates to the cookie writer. Never log this object or return it in JSON.
 * @tags Authentication
 * @interface AuthenticationTokens
 */
export interface AuthenticationTokens {
  /**
   * @author Cristono Wijaya
   * @description The transient raw session token for cookie delivery only. Never persist or log it.
   * @tags Authentication
   * @type {string}
   */
  token: string;
  /**
   * @author Cristono Wijaya
   * @description The transient raw refresh token for cookie delivery only. Never persist or log it.
   * @tags Authentication
   * @type {string}
   */
  refreshToken: string;
  /**
   * @author Cristono Wijaya
   * @description The absolute expiration date of the session token.
   * @tags Authentication
   * @type {Date}
   */
  expiresAt: Date;
  /**
   * @author Cristono Wijaya
   * @description The absolute deadline for renewing the session with a refresh token.
   * @tags Authentication
   * @type {Date}
   */
  refreshExpiresAt: Date;
}

/**
 * @author Cristono Wijaya
 * @description Writes and clears authentication cookies using the same validated security and scope attributes.
 * @tags Authentication
 * @class AuthenticationCookies
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class AuthenticationCookies {
  /**
   * @author Cristono Wijaya
   * @description Initializes AuthenticationCookies with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes AuthenticationCookies with the providers supplied by NestJS.
   * @param configuration - The typed provider for validated application settings.
   */
  constructor(private readonly configuration: ConfigurationService) {}
  /**
   * @author Cristono Wijaya
   * @description Builds shared cookie attributes for the supplied session or refresh path.
   * @tags Authentication
   * @param path - The validated cookie scope path.
   * @returns - The shared HttpOnly, Secure, SameSite, domain, and path attributes.
   * @private - Internal helper for this service.
   */
  private options(path: string) {
    const cookie = this.configuration.cookie;
    return {
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      domain: cookie.domain,
      path,
    };
  }
  /**
   * @author Cristono Wijaya
   * @description Writes separate HttpOnly session and refresh cookies with lifetimes bounded by their stored expiration dates.
   * @tags Authentication
   * @param response - The HTTP response used to write or clear cookies.
   * @param tokens - Transient token values and expiration dates for cookie delivery only.
   * @returns - void; writes the two authentication cookies to the response.
   * @example
   * ```ts
   * this.cookies.set(response, issuedTokens);
   * ```
   */
  set(response: Response, tokens: AuthenticationTokens): void {
    const cookie = this.configuration.cookie;
    response.cookie(cookie.name, tokens.token, {
      ...this.options(cookie.path),
      expires: tokens.expiresAt,
      maxAge: Math.max(0, tokens.expiresAt.getTime() - Date.now()),
    });
    response.cookie(cookie.refreshName, tokens.refreshToken, {
      ...this.options(cookie.refreshPath),
      expires: tokens.refreshExpiresAt,
      maxAge: Math.max(0, tokens.refreshExpiresAt.getTime() - Date.now()),
    });
  }
  /**
   * @author Cristono Wijaya
   * @description Expires both authentication cookies using their original scope, without reusing their previous lifetime.
   * @tags Authentication
   * @param response - The HTTP response used to write or clear cookies.
   * @returns - void; expires both authentication cookies on the response.
   * @example
   * ```ts
   * this.cookies.clear(response);
   * ```
   */
  clear(response: Response): void {
    const cookie = this.configuration.cookie;
    // Do not pass Max-Age or the original Expires to clearCookie.
    response.clearCookie(cookie.name, this.options(cookie.path));
    response.clearCookie(cookie.refreshName, this.options(cookie.refreshPath));
  }
}
