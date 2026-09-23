import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ApiConfiguration } from '../../configuration/settings';

/**
 * @author Cristono Wijaya
 * @description Contains the internal user ID and private credential hash needed to verify a local login. Never expose or log this snapshot.
 * @tags Authentication
 * @interface LoginSnapshot
 */
export interface LoginSnapshot {
  /**
   * @author Cristono Wijaya
   * @description The stable internal UUID of the local account being authenticated.
   * @tags Authentication
   * @type {string}
   */
  userId: string;
  /**
   * @author Cristono Wijaya
   * @description The private encoded Argon2id credential hash. Never return or log it.
   * @tags Authentication
   * @type {string}
   */
  passwordHash: string;
}
/**
 * @author Cristono Wijaya
 * @description Contains only SHA-256 token digests for persistence; raw session and refresh values never enter this contract.
 * @tags Authentication
 * @interface SessionHashes
 */
export interface SessionHashes {
  /**
   * @author Cristono Wijaya
   * @description The SHA-256 session-token digest stored in PostgreSQL. Never return or log it.
   * @tags Authentication
   * @type {string}
   */
  tokenHash: string;
  /**
   * @author Cristono Wijaya
   * @description The SHA-256 refresh-token digest stored in PostgreSQL. Never return or log it.
   * @tags Authentication
   * @type {string}
   */
  refreshTokenHash: string;
}

/**
 * @author Cristono Wijaya
 * @description Persists local login outcomes, account lockouts, and session metadata through short PostgreSQL transactions.
 * @tags Authentication
 * @class LoginRepository
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class LoginRepository {
  /**
   * @author Cristono Wijaya
   * @description Initializes LoginRepository with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes LoginRepository with the providers supplied by NestJS.
   * @param database - The database provider used for persistence or health checks.
   */
  constructor(private readonly database: PrismaService) {}

  /**
   * @author Cristono Wijaya
   * @description Loads credentials for a non-deleted local account, returning undefined for missing or ineligible users.
   * @tags Authentication
   * @param email - The account email address.
   * @returns - A private credential snapshot, or undefined for an ineligible account.
   * @throws Error - Credential retrieval fails; database details are suppressed.
   */
  async find(email: string): Promise<LoginSnapshot | undefined> {
    try {
      const user = await this.database.client.user.findUnique({
        where: { email },
        select: {
          id: true,
          deletedAt: true,
          localCredentials: { select: { passwordHash: true } },
        },
      });
      if (!user || user.deletedAt || !user.localCredentials) return undefined;
      return {
        userId: user.id,
        passwordHash: user.localCredentials.passwordHash,
      };
    } catch {
      throw new Error('Login persistence failed.');
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Locks account and credential rows, rechecks the verified credential snapshot, and commits failure tracking or successful session creation atomically.
   * @tags Authentication
   * @param snapshot - The credential snapshot used for password verification.
   * @param valid - Whether password verification succeeded.
   * @param hashes - Token hashes to persist without raw token values.
   * @param policy - The validated authentication lifetime and lockout policy.
   * @returns - Public account and expiration metadata on success, or null after an unsuccessful login.
   * @throws Error - The login transaction fails; database details are suppressed.
   */
  async complete(
    snapshot: LoginSnapshot,
    valid: boolean,
    hashes: SessionHashes,
    policy: ApiConfiguration['authentication'],
  ) {
    try {
      return await this.database.client.$transaction(async (tx) => {
        // Lock both rows only after expensive password verification. All login
        // attempts for this account serialize here, including failures.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${snapshot.userId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM local_credentials WHERE user_id = ${snapshot.userId}::uuid FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: snapshot.userId },
          include: { localCredentials: true },
        });
        const credential = user?.localCredentials;
        if (
          !user ||
          user.deletedAt ||
          !credential ||
          credential.passwordHash !== snapshot.passwordHash
        )
          return null;
        const now = new Date();
        if (credential.lockedUntil && credential.lockedUntil > now) return null;
        if (!valid) {
          const reset =
            credential.lockedUntil !== null ||
            !credential.lastFailedLoginAt ||
            now.getTime() - credential.lastFailedLoginAt.getTime() >=
              policy.loginWindowSeconds * 1000;
          const failedLoginAttempts =
            (reset ? 0 : credential.failedLoginAttempts) + 1;
          await tx.localCredential.update({
            where: { id: credential.id },
            data: {
              failedLoginAttempts,
              lastFailedLoginAt: now,
              lockedUntil:
                failedLoginAttempts >= policy.loginMaxAttempts
                  ? new Date(now.getTime() + policy.loginLockoutSeconds * 1000)
                  : null,
            },
          });
          // Return, rather than throw, so the failure counter commits.
          return null;
        }
        const expiresAt = new Date(
          now.getTime() + policy.sessionTtlSeconds * 1000,
        );
        const refreshExpiresAt = new Date(
          now.getTime() + policy.refreshTtlSeconds * 1000,
        );
        await tx.authSession.create({
          data: {
            userId: user.id,
            ...hashes,
            createdAt: now,
            expiresAt,
            refreshExpiresAt,
            authenticationMethod: 'LOCAL_PASSWORD',
          },
        });
        await tx.localCredential.update({
          where: { id: credential.id },
          data: {
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            lockedUntil: null,
          },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { lastLoginAt: now },
        });
        return {
          user: { id: user.id, email: user.email },
          expiresAt,
          refreshExpiresAt,
        };
      });
    } catch {
      throw new Error('Login persistence failed.');
    }
  }
}
