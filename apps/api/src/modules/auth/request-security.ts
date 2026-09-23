import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { ApiConfiguration } from '../../configuration/settings';

/**
 * @author Cristono Wijaya
 * @description Rejects origins outside the configured allowlist and cross-site browser requests that omit Origin.
 * @tags Authentication
 * @param request - The incoming HTTP request.
 * @param cors - The validated allowed-origin policy.
 * @returns - void when the request satisfies the browser-origin policy.
 * @throws ForbiddenException - The supplied Origin is untrusted or a cross-site request omits it.
 * @example
 * ```ts
 * validateBrowserOrigin(request, this.configuration.cors);
 * ```
 */
export function validateBrowserOrigin(
  request: Request,
  cors: ApiConfiguration['cors'],
): void {
  const origin = request.headers.origin;
  if (
    (origin !== undefined && !cors.origins.includes(origin)) ||
    (origin === undefined && request.headers['sec-fetch-site'] === 'cross-site')
  )
    throw new ForbiddenException();
}

// Shared by refresh, logout and owned-session revocation. Do not weaken one
// endpoint's CSRF rules independently of the others.
/**
 * @author Cristono Wijaya
 * @description Requires the CSRF header and trusted browser origin, then rejects query parameters and nonempty or malformed bodies.
 * @tags Authentication
 * @param request - The incoming HTTP request.
 * @param cors - The validated allowed-origin policy.
 * @returns - void when the shared session-mutation checks pass.
 * @throws ForbiddenException or BadRequestException - CSRF, origin, query, or body validation fails.
 * @example
 * ```ts
 * validateSessionMutation(request, this.configuration.cors);
 * ```
 */
export function validateSessionMutation(
  request: Request,
  cors: ApiConfiguration['cors'],
): void {
  validateAuthenticatedMutation(request, cors);
  const body: unknown = request.body;
  if (
    body !== undefined &&
    (body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0)
  )
    throw new BadRequestException();
}

/**
 * @author Cristono Wijaya
 * @description Checks CSRF, browser origin, and query parameters for authenticated mutations that may carry DTO bodies.
 * @tags Authentication
 * @param request - The incoming request; never log its body or cookies.
 * @param cors - The validated browser-origin allowlist.
 * @returns - void when the checks succeed.
 * @throws ForbiddenException or BadRequestException - The mutation is not trusted or contains query parameters.
 */
export function validateAuthenticatedMutation(
  request: Request,
  cors: ApiConfiguration['cors'],
): void {
  if (request.headers['x-csrf-protection'] !== '1')
    throw new ForbiddenException();
  validateBrowserOrigin(request, cors);
  if (Object.keys(request.query).length) throw new BadRequestException();
}
