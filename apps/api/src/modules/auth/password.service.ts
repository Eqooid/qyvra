import { Injectable, OnModuleInit } from '@nestjs/common';
import { hash, argon2id, verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import { ConfigurationService } from '../../configuration/configuration.module';
import { InvalidRegistration } from './registration.errors';

/**
 * @author Cristono Wijaya
 * @description Applies registration password policy and Argon2id hashing and verification without logging password material.
 * @tags Authentication
 * @class PasswordService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  /**
   * @author Cristono Wijaya
   * @description Caches the promise for a dummy hash used when an account has no stored local credential.
   * @tags Authentication
   * @type {Promise<string>}
   * @private - Used only within this service.
   */
  private dummyHash?: Promise<string>;
  /**
   * @author Cristono Wijaya
   * @description Uses Argon2id with 64 MiB memory, three iterations, one lane, and a 32-byte hash.
   * @tags Authentication
   * @type {object}
   * @readonly - Cannot be reassigned through this contract.
   * @private - Used only within this service.
   */
  private readonly options = {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  };

  /**
   * @author Cristono Wijaya
   * @description Precomputes the dummy hash so the first unknown-account login does not pay an extra hashing cost.
   * @tags Authentication
   * @returns - A promise resolving after the dummy Argon2id hash is ready.
   */
  async onModuleInit(): Promise<void> {
    await this.dummy();
  }

  /**
   * @author Cristono Wijaya
   * @description Creates the dummy Argon2id hash once and shares it across unknown-account checks.
   * @tags Authentication
   * @returns - The shared dummy-hash promise.
   * @private - Internal helper for this service.
   */
  private dummy(): Promise<string> {
    return (this.dummyHash ??= hash(randomBytes(32), this.options));
  }

  /**
   * @author Cristono Wijaya
   * @description Performs Argon2id verification, using a dummy hash for missing accounts to reduce timing differences. Missing credentials always return false.
   * @tags Authentication
   * @param password - The original password; never log or normalize it.
   * @param passwordHash - The stored password hash; never log or expose it.
   * @returns - Whether a supplied stored credential matches the password.
   * @throws Error - The stored hash is not Argon2id or verification fails operationally.
   * @example
   * ```ts
   * const matches = await this.passwords.verify(password, storedHash);
   * ```
   */
  async verify(password: string, passwordHash?: string): Promise<boolean> {
    try {
      const digest = passwordHash ?? (await this.dummy());
      if (!digest.startsWith('$argon2id$')) throw new Error();
      const valid = await verify(digest, password);
      return passwordHash !== undefined && valid;
    } catch {
      throw new Error('Password verification failed.');
    }
  }
  /**
   * @author Cristono Wijaya
   * @description Initializes PasswordService with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes PasswordService with the providers supplied by NestJS.
   * @param configuration - The typed provider for validated application settings.
   */
  constructor(private readonly configuration: ConfigurationService) {}

  /**
   * @author Cristono Wijaya
   * @description Validates configured Unicode code-point length and rejects whitespace-only passwords before hashing the original value.
   * @tags Authentication
   * @param password - The original password; never log or normalize it.
   * @returns - The encoded Argon2id password hash.
   * @throws InvalidRegistration - Password length or content violates policy; hashing failures are propagated.
   * @example
   * ```ts
   * const passwordHash = await this.passwords.hash(password);
   * ```
   */
  async hash(password: string): Promise<string> {
    const length = Array.from(password).length;
    const policy = this.configuration.authentication;
    if (
      length < policy.passwordMinLength ||
      length > policy.passwordMaxLength ||
      !password.trim()
    ) {
      throw new InvalidRegistration();
    }
    return hash(password, this.options);
  }
}
