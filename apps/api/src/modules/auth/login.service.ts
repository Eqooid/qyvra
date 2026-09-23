import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ConfigurationService } from '../../configuration/configuration.module';
import { PasswordService } from './password.service';
import { LoginRepository } from './login.repository';

/**
 * @author Cristono Wijaya
 * @description Signals an unsuccessful login without distinguishing missing users, incorrect passwords, or lockout.
 * @tags Authentication
 * @class InvalidCredentials
 */
export class InvalidCredentials extends Error {}

/**
 * @author Cristono Wijaya
 * @description Coordinates password verification and secure token generation before persisting only token hashes.
 * @tags Authentication
 * @class LoginService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class LoginService {
  /**
   * @author Cristono Wijaya
   * @description Initializes LoginService with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes LoginService with the providers supplied by NestJS.
   * @param passwords - The Argon2id password hashing and verification service.
   * @param repository - The repository responsible for transactional account persistence.
   * @param configuration - The typed provider for validated application settings.
   */
  constructor(
    private readonly passwords: PasswordService,
    private readonly repository: LoginRepository,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Verifies the password, applies the transactional login policy, and returns transient tokens only for cookie delivery.
   * @tags Authentication
   * @param email - The account email address.
   * @param password - The original password; never log or normalize it.
   * @returns - The public account result and transient tokens for the cookie writer; never expose the full result as JSON.
   * @throws InvalidCredentials - Account lookup or the login policy rejects authentication; hashing and persistence errors are propagated.
   * @example
   * ```ts
   * const result = await this.loginService.login(email, password);
   * this.cookies.set(response, result);
   * ```
   */
  async login(email: string, password: string) {
    const snapshot = await this.repository.find(email.trim().toLowerCase());
    const valid = await this.passwords.verify(password, snapshot?.passwordHash);
    if (!snapshot) throw new InvalidCredentials();
    const token = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const result = await this.repository.complete(
      snapshot,
      valid,
      { tokenHash: digest(token), refreshTokenHash: digest(refreshToken) },
      this.configuration.authentication,
    );
    if (!result) throw new InvalidCredentials();
    return { ...result, token, refreshToken };
  }
}
