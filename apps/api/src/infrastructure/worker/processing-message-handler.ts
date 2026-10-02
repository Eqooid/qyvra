import { Injectable, Logger } from '@nestjs/common';
import {
  ProcessingError,
  ProcessingRepository,
  type ProcessingMessageV1,
} from '@qyvra/database';
import { ProcessingProgressStore } from '../progress/processing-progress';

export type DeliveryDecision = 'ack' | 'dead-letter' | 'retry';

export type HandlerResult =
  | { readonly kind: 'success' }
  | { readonly kind: 'retryable'; readonly failureCode: string }
  | { readonly kind: 'terminal'; readonly failureCode: string };

export interface ProcessingJobHandler {
  readonly jobType: ProcessingMessageV1['jobType'];
  execute(input: {
    readonly jobId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly leaseToken: string;
    readonly attempt: number;
  }): Promise<HandlerResult>;
}

/** Business boundary: no AMQP channels or acknowledgement APIs enter here. */
@Injectable()
export class ProcessingMessageHandler {
  private readonly logger = new Logger(ProcessingMessageHandler.name);
  private readonly handlers: ReadonlyMap<string, ProcessingJobHandler>;

  constructor(
    private readonly repository: ProcessingRepository,
    handlers: readonly ProcessingJobHandler[],
    private readonly clock: () => Date = () => new Date(),
    private readonly leaseMs = 120_000,
    private readonly progress?: ProcessingProgressStore,
  ) {
    const byType = new Map<string, ProcessingJobHandler>();
    for (const handler of handlers) {
      if (byType.has(handler.jobType))
        throw new Error('Duplicate processing handler registration.');
      byType.set(handler.jobType, handler);
    }
    this.handlers = byType;
  }

  async handle(
    message: ProcessingMessageV1,
    redelivered: boolean,
  ): Promise<DeliveryDecision> {
    let job: Awaited<ReturnType<ProcessingRepository['findById']>>;
    try {
      job = await this.repository.findById(message.jobId);
    } catch {
      this.logger.error(
        `Processing job lookup failed: message=${message.messageId}.`,
      );
      return 'retry';
    }
    if (!job) {
      this.logger.warn(
        `Processing message references missing job: message=${message.messageId}.`,
      );
      return 'dead-letter';
    }
    if (
      job.documentId !== message.documentId ||
      job.documentVersionId !== message.documentVersionId ||
      job.jobType !== message.jobType ||
      job.correlationId !== message.correlationId
    ) {
      this.logger.warn(
        `Processing message identity mismatch: message=${message.messageId} job=${job.id}.`,
      );
      return 'dead-letter';
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) return 'ack';
    if (job.status === 'PROCESSING') {
      if (message.dispatchSequence < job.attempts) return 'ack';
      if (message.dispatchSequence > job.attempts) return 'dead-letter';
      if (!job.leaseToken || !job.leaseExpiresAt) return 'retry';
      if (job.leaseExpiresAt <= this.clock()) {
        try {
          await this.repository.recoverInterrupted(
            job.id,
            job.leaseToken,
            this.clock(),
          );
          return 'ack';
        } catch (error) {
          return this.afterClaimConflict(message, error);
        }
      }
      // A distinct duplicate may be acknowledged while the original delivery runs.
      // A redelivered in-flight message must survive until the lease expires.
      return redelivered ? 'retry' : 'ack';
    }
    if (message.dispatchSequence < job.attempts + 1) return 'ack';
    if (message.dispatchSequence > job.attempts + 1) return 'dead-letter';

    const handler = this.handlers.get(message.jobType);
    if (!handler) {
      this.logger.warn(
        `No production processing handler registered: message=${message.messageId} job=${job.id}.`,
      );
      return 'dead-letter';
    }

    let claimed: Awaited<ReturnType<ProcessingRepository['claim']>>;
    try {
      claimed = await this.repository.claim(job.id, this.clock(), this.leaseMs);
    } catch (error) {
      return this.afterClaimConflict(message, error);
    }
    const token = claimed.leaseToken;
    if (!token) return 'retry';
    let outcome: HandlerResult;
    try {
      outcome = await handler.execute({
        jobId: claimed.id,
        documentId: claimed.documentId,
        documentVersionId: claimed.documentVersionId,
        leaseToken: token,
        attempt: claimed.attempts,
      });
    } catch {
      outcome = { kind: 'retryable', failureCode: 'HANDLER_ERROR' };
    }
    try {
      if (outcome.kind === 'success')
        await this.repository.complete(claimed.id, token, this.clock());
      else
        await this.repository.fail(
          claimed.id,
          token,
          this.clock(),
          outcome.failureCode,
          outcome.kind === 'retryable',
        );
      try {
        await this.progress?.clear(claimed.id, claimed.attempts);
      } catch {
        this.logger.warn(
          `Disposable processing progress cleanup failed: job=${claimed.id}.`,
        );
      }
      return 'ack';
    } catch (error) {
      return this.afterClaimConflict(message, error);
    }
  }

  private async afterClaimConflict(
    message: ProcessingMessageV1,
    error: unknown,
  ): Promise<DeliveryDecision> {
    if (error instanceof ProcessingError) {
      if (error.code === 'NOT_FOUND') return 'dead-letter';
      if (error.code === 'INVALID_TRANSITION') {
        let current: Awaited<ReturnType<ProcessingRepository['findById']>>;
        try {
          current = await this.repository.findById(message.jobId);
        } catch {
          return 'retry';
        }
        if (
          current &&
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)
        )
          return 'ack';
        if (current?.status === 'PROCESSING') return 'retry';
        return 'dead-letter';
      }
      if (error.code === 'CONCURRENT_CHANGE') {
        let current: Awaited<ReturnType<ProcessingRepository['findById']>>;
        try {
          current = await this.repository.findById(message.jobId);
        } catch {
          return 'retry';
        }
        if (
          current &&
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)
        )
          return 'ack';
        return 'retry';
      }
    }
    this.logger.error(
      `Processing state could not be committed: message=${message.messageId}.`,
    );
    return 'retry';
  }
}
