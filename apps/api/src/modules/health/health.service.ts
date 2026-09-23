import {
  BeforeApplicationShutdown,
  Injectable,
  Inject,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * @author Cristono Wijaya
 * @description Tracks bootstrap and shutdown readiness and checks only the required PostgreSQL dependency.
 * @tags Health Checks
 * @class HealthService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class HealthService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  /**
   * @author Cristono Wijaya
   * @description Tracks whether bootstrap completed and shutdown has not yet begun.
   * @tags Health Checks
   * @type {boolean}
   * @private - Used only within this service.
   */
  private ready = false;

  /**
   * @author Cristono Wijaya
   * @description Initializes HealthService with its injected dependencies.
   * @tags Health Checks
   * @constructor - Initializes HealthService with the providers supplied by NestJS.
   * @param database - The database provider used for persistence or health checks.
   */
  constructor(
    @Inject(PrismaService)
    private readonly database: Pick<PrismaService, 'ping'>,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Marks the process ready after NestJS completes application bootstrap.
   * @tags Health Checks
   * @returns - void; marks lifecycle readiness true.
   */
  onApplicationBootstrap(): void {
    this.ready = true;
  }

  /**
   * @author Cristono Wijaya
   * @description Marks the process unavailable before connections are closed during shutdown.
   * @tags Health Checks
   * @returns - void; marks lifecycle readiness false.
   */
  beforeApplicationShutdown(): void {
    this.ready = false;
  }

  /**
   * @author Cristono Wijaya
   * @description Confirms that the application can execute a local request without contacting PostgreSQL.
   * @tags Health Checks
   * @returns - An object with status set to ok.
   * @example
   * ```ts
   * const result = this.health.live();
   * ```
   */
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * @author Cristono Wijaya
   * @description Requires a ready lifecycle state and successful PostgreSQL ping, rechecking shutdown state after the asynchronous probe.
   * @tags Health Checks
   * @returns - A promise resolving to an object with status ready after the PostgreSQL check.
   * @throws ServiceUnavailableException - Lifecycle or PostgreSQL checks fail.
   * @example
   * ```ts
   * const result = await this.health.readiness();
   * ```
   */
  async readiness(): Promise<{ status: 'ready' }> {
    if (!this.ready) throw new ServiceUnavailableException();
    try {
      await this.database.ping();
    } catch {
      throw new ServiceUnavailableException();
    }
    if (!this.ready) throw new ServiceUnavailableException();
    return { status: 'ready' };
  }
}
