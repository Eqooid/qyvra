import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ProcessingError, ProcessingRepository } from '@brainless/database';

export interface ProcessingRecoverySettings {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
}

/** PostgreSQL-only coordinator. T05 remains solely responsible for broker delivery. */
@Injectable()
export class ProcessingRecovery implements OnApplicationShutdown {
  private readonly logger = new Logger(ProcessingRecovery.name);
  private stopping = false;
  private loop?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;

  constructor(
    private readonly repository: ProcessingRepository,
    private readonly settings: ProcessingRecoverySettings,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.loop || this.stopping) return;
    this.logger.log('Processing retry and recovery coordinator started.');
    this.loop = this.runLoop();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch {
        this.logger.error('Processing recovery polling failed; will retry.');
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, this.settings.pollIntervalMs);
      });
      this.timer = undefined;
      this.wake = undefined;
    }
  }

  /** Recover expired leases, then create bounded due-retry publication intents. */
  async runOnce(): Promise<{ recovered: number; scheduled: number }> {
    if (this.stopping) return { recovered: 0, scheduled: 0 };
    const now = this.clock();
    const stale = await this.repository.findStaleProcessing(
      now,
      this.settings.batchSize,
    );
    let recovered = 0;
    for (const id of stale) {
      if (this.stopping) break;
      const job = await this.repository.findById(id);
      if (job?.status !== 'PROCESSING' || !job.leaseToken) continue;
      try {
        const result = await this.repository.recoverInterrupted(
          id,
          job.leaseToken,
          now,
        );
        recovered++;
        this.logger.warn(
          `Interrupted processing attempt recovered: job=${id} attempt=${result.attempts} status=${result.status}.`,
        );
      } catch (error) {
        if (this.isRace(error)) continue;
        throw error;
      }
    }

    const due = await this.repository.findRetryEligible(
      now,
      this.settings.batchSize,
    );
    let scheduled = 0;
    for (const id of due) {
      if (this.stopping) break;
      try {
        const outbox = await this.repository.scheduleRetryDispatch(id, now);
        scheduled++;
        this.logger.log(
          `Processing retry intent ensured: job=${id} message=${outbox.id} dispatch=${outbox.dispatchSequence}.`,
        );
      } catch (error) {
        if (this.isRace(error)) continue;
        throw error;
      }
    }
    return { recovered, scheduled };
  }

  private isRace(error: unknown): boolean {
    return (
      error instanceof ProcessingError &&
      [
        'NOT_FOUND',
        'INVALID_TRANSITION',
        'CONCURRENT_CHANGE',
        'INELIGIBLE_DOCUMENT',
      ].includes(error.code)
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      if (this.loop) await this.loop;
      return;
    }
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    if (this.loop) await this.loop;
    this.logger.log('Processing retry and recovery coordinator stopped.');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
