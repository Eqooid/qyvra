import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedSession } from './authenticated-user';
import { PasswordService } from './password.service';
import { InvalidCredentials } from './login.service';
import { UpdateProfileDto } from './profile.dto';

/** @author Cristono Wijaya
 * @description Safe profile fields shared by the profile update projection.
 * @tags Profile
 * @constant publicProfile - Credentials and session metadata are excluded.
 */
const publicProfile = {
  id: true,
  email: true,
  displayName: true,
  locale: true,
  timezone: true,
} as const;

/** @author Cristono Wijaya
 * @description Updates owned profiles and local credentials without exposing private authentication data.
 * @tags Profile
 * @class ProfileService
 * @injectable - Registers the application service with NestJS.
 */
@Injectable()
export class ProfileService {
  /** @author Cristono Wijaya
   * @constructor - Injects persistence and the existing Argon2id password policy.
   * @param database - The shared Prisma service.
   * @param passwords - Password hashing and verification.
   */
  constructor(
    private readonly database: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  /** @author Cristono Wijaya
   * @description Applies only explicitly selected profile fields to the authenticated internal user.
   * @param context - Trusted session and ownership context.
   * @param changes - Validated profile fields.
   * @returns - Safe public profile fields.
   * @throws Error - Persistence fails; infrastructure details are suppressed.
   */
  async update(context: AuthenticatedSession, changes: UpdateProfileDto) {
    try {
      return await this.database.client.user.update({
        where: { id: context.user.id, deletedAt: null },
        data: {
          displayName: changes.displayName,
          timezone: changes.timezone,
          locale: changes.locale,
        },
        select: publicProfile,
      });
    } catch {
      throw new Error('Profile update failed.');
    }
  }

  /** @author Cristono Wijaya
   * @description Verifies outside the transaction, then locks and rechecks account, credential, and session state before atomically changing the password and revoking other sessions.
   * @param context - Trusted ownership and current-session context.
   * @param currentPassword - Original current password; never log it.
   * @param newPassword - Original replacement password; never log it.
   * @returns - A promise resolving after commit, preserving the current session.
   * @throws InvalidCredentials - Credentials, local identity, or session state are invalid; policy and persistence failures propagate safely.
   */
  async changePassword(
    context: AuthenticatedSession,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    let snapshot;
    try {
      snapshot = await this.database.client.user.findFirst({
        where: {
          id: context.user.id,
          deletedAt: null,
          identities: {
            some: {
              provider: 'LOCAL',
              issuer: 'local',
              subject: context.user.id,
            },
          },
        },
        select: { localCredentials: { select: { passwordHash: true } } },
      });
    } catch {
      throw new Error('Password update failed.');
    }
    const previousHash = snapshot?.localCredentials?.passwordHash;
    const valid = await this.passwords.verify(currentPassword, previousHash);
    if (!previousHash || !valid) throw new InvalidCredentials();
    const nextHash = await this.passwords.hash(newPassword);
    let changed: boolean;
    try {
      changed = await this.database.client.$transaction(async (tx) => {
        // Use the same account/credential lock order as login to serialize password changes with login.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${context.user.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM local_credentials WHERE user_id = ${context.user.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${context.sessionId}::uuid FOR UPDATE`;
        const user = await tx.user.findFirst({
          where: {
            id: context.user.id,
            deletedAt: null,
            identities: {
              some: {
                provider: 'LOCAL',
                issuer: 'local',
                subject: context.user.id,
              },
            },
          },
          select: { localCredentials: { select: { passwordHash: true } } },
        });
        const now = new Date();
        const session = await tx.authSession.findFirst({
          where: {
            id: context.sessionId,
            userId: context.user.id,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true },
        });
        if (!session || user?.localCredentials?.passwordHash !== previousHash)
          return false;
        await tx.localCredential.update({
          where: { userId: context.user.id },
          data: {
            passwordHash: nextHash,
            passwordChangedAt: now,
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            lockedUntil: null,
          },
        });
        await tx.authSession.updateMany({
          where: {
            userId: context.user.id,
            id: { not: context.sessionId },
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        return true;
      });
    } catch {
      throw new Error('Password update failed.');
    }
    if (!changed) throw new InvalidCredentials();
  }

  /** @author Cristono Wijaya
   * @description Revokes every unrevoked owned session, including the current one, serialized with account login writes.
   * @param context - Trusted ownership context from the session guard.
   * @returns - A promise resolving once revocation commits.
   * @throws Error - Persistence fails without reporting success.
   */
  async logoutAll(context: AuthenticatedSession): Promise<void> {
    try {
      await this.database.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${context.user.id}::uuid FOR UPDATE`;
        await tx.authSession.updateMany({
          where: { userId: context.user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
    } catch {
      throw new Error('Session logout failed.');
    }
  }
}
