import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@brainless/database';

/**
 * @author Cristono Wijaya
 * @description Identifies the injectable Prisma client so tests can replace the database boundary.
 * @tags Database Lifecycle
 * @constant PRISMA_CLIENT - The shared PRISMA_CLIENT definition.
 */
export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

/**
 * @author Cristono Wijaya
 * @description Owns the Prisma connection lifecycle and exposes bounded PostgreSQL readiness checks.
 * @tags Database Lifecycle
 * @class PrismaService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnApplicationShutdown {
  /**
   * @author Cristono Wijaya
   * @description Tracks successful startup connection and probe completion; it is cleared before disconnecting.
   * @tags Database Lifecycle
   * @type {boolean}
   * @private - Used only within this service.
   */
  private connected = false;

  /**
   * @author Cristono Wijaya
   * @description Initializes PrismaService with its injected dependencies.
   * @tags Database Lifecycle
   * @constructor - Initializes PrismaService with the providers supplied by NestJS.
   * @param client - The injectable shared Prisma client managed by this service.
   */
  constructor(@Inject(PRISMA_CLIENT) readonly client: PrismaClient) {}

  /**
   * @author Cristono Wijaya
   * @description Connects to PostgreSQL and runs SELECT 1 before startup succeeds. Cleans up on failure and hides connection details.
   * @tags Database Lifecycle
   * @returns - A promise resolving after connection and the initial PostgreSQL probe succeed.
   * @throws Error - Connection, startup query, or cleanup fails; infrastructure details are omitted.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.$connect();
      await this.client.$queryRaw`SELECT 1`;
      this.connected = true;
    } catch {
      await this.disconnect();
      throw new Error('PostgreSQL connection failed during startup.');
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Checks a previously initialized database connection with SELECT 1 and reports failures without infrastructure details.
   * @tags Database Lifecycle
   * @returns - A promise resolving when PostgreSQL responds to SELECT 1.
   * @throws Error - The client is uninitialized or the database probe fails.
   * @example
   * ```ts
   * await this.database.ping();
   * ```
   */
  async ping(): Promise<void> {
    if (!this.connected) throw new Error('PostgreSQL is unavailable.');
    try {
      await this.client.$queryRaw`SELECT 1`;
    } catch {
      throw new Error('PostgreSQL is unavailable.');
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Releases Prisma connections when NestJS shuts down.
   * @tags Database Lifecycle
   * @returns - A promise resolving after database connections are closed.
   * @throws Error - Connection cleanup fails.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.disconnect();
  }

  /**
   * @author Cristono Wijaya
   * @description Marks the database unavailable before closing its connections and sanitizes cleanup failures.
   * @tags Database Lifecycle
   * @returns - A promise resolving after Prisma cleanup completes.
   * @throws Error - Prisma cannot close its connections.
   * @private - Internal helper for this service.
   */
  private async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.client.$disconnect();
    } catch {
      throw new Error('PostgreSQL connection cleanup failed.');
    }
  }
}
