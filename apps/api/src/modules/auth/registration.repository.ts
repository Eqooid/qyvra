import { Injectable } from '@nestjs/common';
import { Prisma } from '@qyvra/database';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { RegistrationConflict } from './registration.errors';

/**
 * @author Cristono Wijaya
 * @description Creates local authentication records in one PostgreSQL transaction and maps uniqueness failures to a safe domain error.
 * @tags Authentication
 * @class RegistrationRepository
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class RegistrationRepository {
  /**
   * @author Cristono Wijaya
   * @description Initializes RegistrationRepository with its injected dependencies.
   * @tags Authentication
   * @constructor - Initializes RegistrationRepository with the providers supplied by NestJS.
   * @param prisma - The Prisma service used for transactional account creation.
   */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @author Cristono Wijaya
   * @description Atomically creates the user, LOCAL identity with issuer local, and hashed credentials using a stable internal UUID.
   * @tags Authentication
   * @param email - The account email address.
   * @param passwordHash - The stored password hash; never log or expose it.
   * @returns - The created user UUID and normalized email after the transaction commits.
   * @throws RegistrationConflict - A unique constraint fails; other persistence failures become a sanitized Error.
   */
  async create(
    email: string,
    passwordHash: string,
  ): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { id, email },
          select: { id: true, email: true },
        });
        await tx.userIdentity.create({
          data: { userId: id, provider: 'LOCAL', issuer: 'local', subject: id },
        });
        await tx.localCredential.create({ data: { userId: id, passwordHash } });
        return user;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Prisma adapters expose constraint metadata differently. All unique
        // conflicts in account creation use the same safe public response.
        throw new RegistrationConflict();
      }
      // Do not propagate infrastructure exceptions containing SQL arguments or hashes.
      throw new Error('Registration persistence failed.');
    }
  }
}
