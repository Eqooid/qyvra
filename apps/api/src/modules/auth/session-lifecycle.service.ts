import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { ConfigurationService } from '../../configuration/configuration.module';
import { AuthenticationTokens } from './authentication-cookies';

/**
 * @author Cristono Wijaya
 * @description Hashes a presented opaque token with SHA-256 for database lookup or persistence.
 * @tags Authentication
 * @param token - The opaque session token; never log its value.
 * @constant digest - The shared digest definition.
 * @returns - The SHA-256 token digest encoded as hexadecimal.
 */
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/**
 * @author Cristono Wijaya
 * @description Rotates session credentials atomically, detects consumed refresh-token replay, and persists logout revocation.
 * @tags Authentication
 * @class SessionLifecycleService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class SessionLifecycleService {
  /**
   * @author Cristono Wijaya
   * @description Initializes SessionLifecycleService with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes SessionLifecycleService with the providers supplied by NestJS.
   * @param database - The database provider used for persistence or health checks.
   * @param configuration - The typed provider for validated application settings.
   */
  constructor(
    private readonly database: PrismaService,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Locks the session, validates its current refresh hash, and rotates both tokens. Known replay commits revocation; the absolute refresh deadline is preserved.
   * @tags Authentication
   * @param refreshToken - The opaque refresh token; never log its value.
   * @returns - Replacement tokens and expiration dates, or null for invalid refresh credentials.
   * @throws Error - Refresh persistence fails; database and token details are suppressed.
   * @example
   * ```ts
   * const result = await this.lifecycle.refresh(refreshToken);
   * if (result) this.cookies.set(response, result);
   * ```
   */
  async refresh(refreshToken: string): Promise<AuthenticationTokens | null> {
    const presentedHash = digest(refreshToken);
    const token = randomBytes(32).toString('base64url');
    const nextRefreshToken = randomBytes(32).toString('base64url');
    try {
      const result = await this.database.client.$transaction(async (tx) => {
        const current = await tx.authSession.findUnique({
          where: { refreshTokenHash: presentedHash },
          select: { id: true },
        });
        const consumed = current
          ? null
          : await tx.consumedRefreshToken.findUnique({
              where: { tokenHash: presentedHash },
              select: { sessionId: true },
            });
        const id = current?.id ?? consumed?.sessionId;
        if (!id) return null;
        await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${id}::uuid FOR UPDATE`;
        const session = await tx.authSession.findUnique({
          where: { id },
          select: {
            refreshTokenHash: true,
            refreshExpiresAt: true,
            revokedAt: true,
            user: { select: { deletedAt: true } },
          },
        });
        if (!session) return null;
        const now = new Date();
        // A known token which is no longer current is a replay, including a
        // concurrent loser. Commit revocation before returning an error.
        if (consumed || session.refreshTokenHash !== presentedHash) {
          await tx.authSession.updateMany({
            where: { id, revokedAt: null },
            data: { revokedAt: now },
          });
          return null;
        }
        if (
          session.revokedAt ||
          session.user.deletedAt ||
          !session.refreshExpiresAt ||
          session.refreshExpiresAt <= now
        )
          return null;
        const expiresAt = new Date(
          Math.min(
            now.getTime() +
              this.configuration.authentication.sessionTtlSeconds * 1000,
            session.refreshExpiresAt.getTime(),
          ),
        );
        await tx.consumedRefreshToken.create({
          data: { tokenHash: presentedHash, sessionId: id, consumedAt: now },
        });
        await tx.authSession.update({
          where: { id },
          data: {
            tokenHash: digest(token),
            refreshTokenHash: digest(nextRefreshToken),
            expiresAt,
            lastSeenAt: now,
          },
        });
        return { expiresAt, refreshExpiresAt: session.refreshExpiresAt };
      });
      return result
        ? { ...result, token, refreshToken: nextRefreshToken }
        : null;
    } catch {
      throw new Error('Session refresh failed.');
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Revokes at most one identified session. The session token takes precedence, with current or consumed refresh hashes as fallback; missing credentials are a no-op.
   * @tags Authentication
   * @param token - The opaque session token; never log its value.
   * @param refreshToken - The opaque refresh token; never log its value.
   * @returns - A promise resolving after any identified session is revoked, or immediately if no token was supplied.
   * @throws Error - Logout persistence fails; database and token details are suppressed.
   * @example
   * ```ts
   * await this.lifecycle.logout(token, refreshToken);
   * ```
   */
  async logout(token?: string, refreshToken?: string): Promise<void> {
    if (!token && !refreshToken) return;
    try {
      await this.database.client.$transaction(async (tx) => {
        let current = token
          ? await tx.authSession.findUnique({
              where: { tokenHash: digest(token) },
              select: { id: true },
            })
          : null;
        if (!current && refreshToken) {
          current = await tx.authSession.findUnique({
            where: { refreshTokenHash: digest(refreshToken) },
            select: { id: true },
          });
          if (!current) {
            const consumed = await tx.consumedRefreshToken.findUnique({
              where: { tokenHash: digest(refreshToken) },
              select: { sessionId: true },
            });
            if (consumed) current = { id: consumed.sessionId };
          }
        }
        if (current)
          await tx.authSession.updateMany({
            where: { id: current.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
      });
    } catch {
      throw new Error('Session logout failed.');
    }
  }
}
