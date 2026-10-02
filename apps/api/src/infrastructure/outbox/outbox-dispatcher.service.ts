import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ProcessingError, ProcessingRepository } from '@qyvra/database';
import type { MessagePublisher } from '../messaging/message-publisher';
import { parseProcessingMessage } from '../messaging/processing-message';
import { outboxRetryDelayMs } from './outbox-policy';

export interface OutboxSettings {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
}

/** Relays committed intent. Broker I/O never runs inside a PostgreSQL transaction. */
@Injectable()
export class OutboxDispatcher implements OnApplicationShutdown {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private stopping = false;
  private loop?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;

  constructor(
    private readonly repository: ProcessingRepository,
    private readonly publisher: MessagePublisher,
    private readonly settings: OutboxSettings,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.loop || this.stopping) return;
    this.logger.log('Outbox dispatcher started.');
    this.loop = this.runLoop();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.dispatchOnce();
      } catch {
        this.logger.error('Outbox polling failed; will retry.');
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

  /** One bounded, sequential batch. Safe to trigger in focused tests. */
  async dispatchOnce(): Promise<number> {
    if (this.stopping) return 0;
    const due = await this.repository.findPendingOutbox(
      this.clock(),
      this.settings.batchSize,
    );
    let processed = 0;
    for (const candidate of due) {
      if (this.stopping) break;
      let claimed: Awaited<ReturnType<ProcessingRepository['claimOutbox']>>;
      try {
        claimed = await this.repository.claimOutbox(
          candidate.id,
          this.clock(),
          this.settings.leaseMs,
        );
      } catch (error) {
        if (
          error instanceof ProcessingError &&
          (error.code === 'CONCURRENT_CHANGE' || error.code === 'NOT_FOUND')
        )
          continue;
        throw error;
      }
      processed++;
      await this.dispatchClaimed(claimed);
    }
    return processed;
  }

  private async dispatchClaimed(
    claimed: Awaited<ReturnType<ProcessingRepository['claimOutbox']>>,
  ): Promise<void> {
    const token = claimed.claimToken;
    if (!token) throw new Error('Claimed outbox record has no lease token.');
    let failureCode = 'PUBLISH_FAILED';
    try {
      const message = parseProcessingMessage(claimed.payload);
      if (
        message.messageId !== claimed.id ||
        message.jobId !== claimed.processingJobId ||
        message.type !== claimed.eventType ||
        message.schemaVersion !== claimed.schemaVersion ||
        message.dispatchSequence !== claimed.dispatchSequence ||
        message.correlationId !== claimed.correlationId ||
        message.occurredAt !== claimed.occurredAt.toISOString()
      )
        throw new Error('Outbox envelope does not match durable metadata.');
      await this.publisher.publishProcessing(message);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Invalid processing message contract.' ||
          error.message === 'Processing message exceeds size limit.' ||
          error.message === 'Outbox envelope does not match durable metadata.')
      )
        failureCode = 'INVALID_OUTBOX_PAYLOAD';
      const now = this.clock();
      const retryAt = new Date(
        now.getTime() +
          outboxRetryDelayMs(claimed.id, claimed.publicationAttempts),
      );
      try {
        await this.repository.recordOutboxFailure(
          claimed.id,
          token,
          now,
          failureCode,
          retryAt,
        );
        this.logger.warn(
          `Outbox publication failed: message=${claimed.id} job=${claimed.processingJobId} attempt=${claimed.publicationAttempts} code=${failureCode}.`,
        );
      } catch {
        // The lease expires, so another dispatcher can recover an uncertain outcome.
        this.logger.error(
          `Outbox failure state could not be persisted: message=${claimed.id}.`,
        );
      }
      return;
    }

    try {
      await this.repository.markOutboxPublished(
        claimed.id,
        token,
        this.clock(),
      );
    } catch {
      // A confirmed publish followed by a failed PostgreSQL update can be replayed.
      this.logger.error(
        `Confirmed outbox publication could not be recorded: message=${claimed.id}.`,
      );
    }
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
    this.logger.log('Outbox dispatcher stopped.');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
