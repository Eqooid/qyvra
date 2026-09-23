import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser, AuthenticatedSession } from './authenticated-user';

/**
 * @author Cristono Wijaya
 * @description Sets the minimum interval between persisted session activity updates to one minute.
 * @tags Authentication
 * @constant SESSION_ACTIVITY_INTERVAL_MS - The shared SESSION_ACTIVITY_INTERVAL_MS definition.
 */
export const SESSION_ACTIVITY_INTERVAL_MS = 60000;

// Only accept the canonical base64url encoding of the 32 random bytes issued
// by login. Never interpret a refresh token, bearer header or user ID as a session.
/**
 * @author Cristono Wijaya
 * @description Extracts exactly one named cookie and accepts only the canonical base64url encoding of a 32-byte token.
 * @tags Authentication
 * @param cookieHeader - The raw Cookie header, which must never be logged.
 * @param name - The configured cookie name to resolve.
 * @returns - The canonical cookie token, or undefined when missing, duplicated, or malformed.
 * @example
 * ```ts
 * const token = sessionToken(request.headers.cookie, this.configuration.cookie.name);
 * ```
 */
export function sessionToken(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.split('=')[0].trim() === name);
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(matches[0].indexOf('=') + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  if (Buffer.from(value, 'base64url').toString('base64url') !== value)
    return undefined;
  return value;
}

/**
 * @author Cristono Wijaya
 * @description Authenticates opaque session tokens against current PostgreSQL state and returns frozen trusted context.
 * @tags Authentication
 * @class SessionService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class SessionService {
  /**
   * @author Cristono Wijaya
   * @description Initializes SessionService with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes SessionService with the providers supplied by NestJS.
   * @param database - The database provider used for persistence or health checks.
   */
  constructor(private readonly database: PrismaService) {}

  /**
   * @author Cristono Wijaya
   * @description Returns the public user profile for an active session, or null when authentication fails.
   * @tags Authentication
   * @param token - The opaque session token; never log its value.
   * @returns - The safe user profile, or null for an invalid session.
   * @throws Error - Session authentication fails operationally.
   * @example
   * ```ts
   * const user = await this.sessions.authenticate(token);
   * ```
   */
  async authenticate(
    token: string,
  ): Promise<Readonly<AuthenticatedUser> | null> {
    return (await this.authenticateSession(token))?.user ?? null;
  }

  /**
   * @author Cristono Wijaya
   * @description Hashes the token, rejects missing, expired, revoked, or deleted-user sessions, and conditionally updates last-seen activity without caching validity.
   * @tags Authentication
   * @param token - The opaque session token; never log its value.
   * @returns - Frozen user/session context, or null for an invalid session.
   * @throws Error - A database read or activity update fails.
   * @example
   * ```ts
   * const context = await this.sessions.authenticateSession(token);
   * ```
   */
  async authenticateSession(
    token: string,
  ): Promise<Readonly<AuthenticatedSession> | null> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    try {
      const session = await this.database.client.authSession.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          expiresAt: true,
          revokedAt: true,
          lastSeenAt: true,
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              locale: true,
              timezone: true,
              deletedAt: true,
            },
          },
        },
      });
      const now = new Date();
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= now ||
        session.user.deletedAt
      )
        return null;
      const cutoff = new Date(now.getTime() - SESSION_ACTIVITY_INTERVAL_MS);
      if (!session.lastSeenAt || session.lastSeenAt <= cutoff) {
        // Conditional update avoids duplicate writes from concurrent API instances.
        // Authentication reads always hit PostgreSQL; validity is never cached.
        const update = await this.database.client.authSession.updateMany({
          where: {
            id: session.id,
            tokenHash,
            revokedAt: null,
            expiresAt: { gt: now },
            user: { deletedAt: null },
            OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: cutoff } }],
          },
          data: { lastSeenAt: now },
        });
        if (update.count === 0) {
          const stillActive = await this.database.client.authSession.findFirst({
            where: {
              id: session.id,
              tokenHash,
              revokedAt: null,
              expiresAt: { gt: new Date() },
              user: { deletedAt: null },
            },
            select: { id: true },
          });
          if (!stillActive) return null;
        }
      }
      const { id, email, displayName, locale, timezone } = session.user;
      return Object.freeze({
        sessionId: session.id,
        user: Object.freeze({ id, email, displayName, locale, timezone }),
      });
    } catch {
      throw new Error('Session authentication failed.');
    }
  }
}
