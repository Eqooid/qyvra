import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedSession } from './authenticated-user';

/**
 * @author Cristono Wijaya
 * @description Represents missing or unowned sessions without revealing which condition occurred.
 * @tags Authentication
 * @class SessionNotFound
 */
export class SessionNotFound extends Error {}

/**
 * @author Cristono Wijaya
 * @description Applies trusted user ownership filters to session listing and revocation queries.
 * @tags Authentication
 * @class SessionManagementService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class SessionManagementService {
  /**
   * @author Cristono Wijaya
   * @description Initializes SessionManagementService with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes SessionManagementService with the providers supplied by NestJS.
   * @param database - The database provider used for persistence or health checks.
   */
  constructor(private readonly database: PrismaService) {}

  /**
   * @author Cristono Wijaya
   * @description Returns a UUID-ordered page of safe metadata for owned, unrevoked sessions with unexpired access or refresh eligibility.
   * @tags Authentication
   * @param context - The trusted request or session context supplied by NestJS.
   * @param limit - The validated maximum number of sessions to return.
   * @param cursor - The optional exclusive session UUID cursor.
   * @returns - Safe session metadata with current-session markers and a next cursor, or null as the cursor on the last page.
   * @throws Error - The owned-session query fails.
   * @example
   * ```ts
   * const page = await this.sessions.list(context, 50);
   * ```
   */
  async list(context: AuthenticatedSession, limit: number, cursor?: string) {
    try {
      const now = new Date();
      const rows = await this.database.client.authSession.findMany({
        where: {
          userId: context.user.id,
          revokedAt: null,
          OR: [{ expiresAt: { gt: now } }, { refreshExpiresAt: { gt: now } }],
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: {
          id: true,
          createdAt: true,
          lastSeenAt: true,
          expiresAt: true,
          refreshExpiresAt: true,
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      const sessions = rows
        .slice(0, limit)
        .map((row) => ({ ...row, isCurrent: row.id === context.sessionId }));
      return {
        sessions,
        nextCursor:
          rows.length > limit ? sessions[sessions.length - 1].id : null,
      };
    } catch {
      throw new Error('Session listing failed.');
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Checks ownership and conditionally revokes the session in one transaction. Already revoked owned sessions succeed.
   * @tags Authentication
   * @param context - The trusted request or session context supplied by NestJS.
   * @param id - The internal ID of the session being revoked.
   * @returns - A promise resolving when the owned session is revoked or was already revoked.
   * @throws SessionNotFound - No owned session exists; persistence failures become a sanitized Error.
   * @example
   * ```ts
   * await this.sessions.revoke(context, sessionId);
   * ```
   */
  async revoke(context: AuthenticatedSession, id: string): Promise<void> {
    let exists: boolean;
    try {
      exists = await this.database.client.$transaction(async (tx) => {
        const session = await tx.authSession.findFirst({
          where: { id, userId: context.user.id },
          select: { id: true },
        });
        if (!session) return false;
        await tx.authSession.updateMany({
          where: { id, userId: context.user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return true;
      });
    } catch {
      throw new Error('Session revocation failed.');
    }
    if (!exists) throw new SessionNotFound();
  }

  /**
   * @author Cristono Wijaya
   * @description Revokes all unrevoked sessions belonging to the trusted user except the authenticated session, returning the affected count.
   * @tags Authentication
   * @param context - The trusted request or session context supplied by NestJS.
   * @returns - The number of sessions newly revoked.
   * @throws Error - The conditional revocation update fails.
   * @example
   * ```ts
   * const revokedCount = await this.sessions.revokeOthers(context);
   * ```
   */
  async revokeOthers(context: AuthenticatedSession): Promise<number> {
    try {
      const result = await this.database.client.authSession.updateMany({
        where: {
          userId: context.user.id,
          id: { not: context.sessionId },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      return result.count;
    } catch {
      throw new Error('Session revocation failed.');
    }
  }
}
