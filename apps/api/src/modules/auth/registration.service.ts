import { Injectable } from '@nestjs/common';
import { PasswordService } from './password.service';
import { RegistrationRepository } from './registration.repository';

/**
 * @author Cristono Wijaya
 * @description Coordinates password hashing, email normalization, and atomic local account creation.
 * @tags Authentication
 * @class RegistrationService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class RegistrationService {
  /**
   * @author Cristono Wijaya
   * @description Initializes RegistrationService with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes RegistrationService with the providers supplied by NestJS.
   * @param passwords - The Argon2id password hashing and verification service.
   * @param repository - The repository responsible for transactional account persistence.
   */
  constructor(
    private readonly passwords: PasswordService,
    private readonly repository: RegistrationRepository,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Hashes the unmodified password and persists the normalized email, returning only the public account result.
   * @tags Authentication
   * @param email - The account email address.
   * @param password - The original password; never log or normalize it.
   * @returns - The new public account identity after password hashing and atomic persistence.
   * @throws InvalidRegistration or RegistrationConflict - Registration is rejected; hashing and persistence failures are propagated.
   * @example
   * ```ts
   * const account = await this.registration.register(email, password);
   * ```
   */
  async register(email: string, password: string) {
    const passwordHash = await this.passwords.hash(password);
    return this.repository.create(email.trim().toLowerCase(), passwordHash);
  }
}
