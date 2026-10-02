import type { ProcessingMessageV1 } from '@qyvra/database';
import { ProcessingError, type ProcessingRepository } from '@qyvra/database';
import type { MessagePublisher } from '../messaging/message-publisher';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { outboxRetryDelayMs } from './outbox-policy';

const message: ProcessingMessageV1 = {
  schemaVersion: 1,
  messageId: '11111111-1111-4111-8111-111111111111',
  type: 'processing.execute',
  occurredAt: '2026-01-01T00:00:00.000Z',
  correlationId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  documentId: '44444444-4444-4444-8444-444444444444',
  documentVersionId: '55555555-5555-4555-8555-555555555555',
  jobType: 'VERIFY_STORED_FILE',
  dispatchSequence: 1,
};
const row = {
  id: message.messageId,
  processingJobId: message.jobId,
  eventType: message.type,
  schemaVersion: message.schemaVersion,
  dispatchSequence: message.dispatchSequence,
  correlationId: message.correlationId,
  occurredAt: new Date(message.occurredAt),
  payload: { ...message },
  claimToken: '66666666-6666-4666-8666-666666666666',
  publicationAttempts: 1,
};
const now = new Date('2026-01-01T00:01:00.000Z');
const settings = { pollIntervalMs: 1000, batchSize: 10, leaseMs: 120000 };

function setup(
  publishProcessing: jest.Mock = jest.fn().mockResolvedValue(undefined),
) {
  const repository = {
    findPendingOutbox: jest.fn().mockResolvedValue([row]),
    claimOutbox: jest.fn().mockResolvedValue(row),
    markOutboxPublished: jest
      .fn()
      .mockResolvedValue({ ...row, status: 'PUBLISHED' }),
    recordOutboxFailure: jest
      .fn()
      .mockResolvedValue({ ...row, status: 'PENDING' }),
  };
  const publisher: MessagePublisher = { publishProcessing };
  const dispatcher = new OutboxDispatcher(
    repository as unknown as ProcessingRepository,
    publisher,
    settings,
    () => now,
  );
  return { dispatcher, repository, publishProcessing };
}

describe('outbox publication policy', () => {
  it('uses deterministic bounded backoff distinct from job attempt state', () => {
    expect(outboxRetryDelayMs(message.messageId, 1)).toBeGreaterThanOrEqual(
      5000,
    );
    expect(outboxRetryDelayMs(message.messageId, 2)).toBeGreaterThanOrEqual(
      10000,
    );
    expect(outboxRetryDelayMs(message.messageId, 50)).toBe(300000);
    expect(outboxRetryDelayMs(message.messageId, 2)).toBe(
      outboxRetryDelayMs(message.messageId, 2),
    );
  });

  it('records success only after publisher confirmation', async () => {
    let confirm: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const { dispatcher, repository, publishProcessing } = setup(
      jest.fn().mockReturnValue(pending),
    );
    const draining = dispatcher.dispatchOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishProcessing).toHaveBeenCalledWith(message);
    expect(repository.markOutboxPublished).not.toHaveBeenCalled();
    confirm?.();
    await draining;
    expect(repository.markOutboxPublished).toHaveBeenCalledWith(
      row.id,
      row.claimToken,
      now,
    );
  });

  it('keeps failure pending and schedules the same message ID for retry', async () => {
    const { dispatcher, repository, publishProcessing } = setup(
      jest.fn().mockRejectedValue(new Error('broker down')),
    );
    await dispatcher.dispatchOnce();
    expect(repository.markOutboxPublished).not.toHaveBeenCalled();
    expect(repository.recordOutboxFailure).toHaveBeenCalledWith(
      row.id,
      row.claimToken,
      now,
      'PUBLISH_FAILED',
      new Date(now.getTime() + outboxRetryDelayMs(row.id, 1)),
    );
    expect(publishProcessing.mock.calls[0][0].messageId).toBe(row.id);
  });

  it('leaves confirmed-but-unrecorded publication for lease recovery and possible duplicate', async () => {
    const { dispatcher, repository } = setup();
    repository.markOutboxPublished.mockRejectedValue(
      new Error('database down'),
    );
    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);
    expect(repository.recordOutboxFailure).not.toHaveBeenCalled();
  });

  it('skips a concurrent claim without publishing', async () => {
    const { dispatcher, repository, publishProcessing } = setup();
    repository.claimOutbox.mockRejectedValue(
      new ProcessingError('CONCURRENT_CHANGE'),
    );
    await expect(dispatcher.dispatchOnce()).resolves.toBe(0);
    expect(publishProcessing).not.toHaveBeenCalled();
  });

  it('rejects a mismatched committed envelope before publishing', async () => {
    const { dispatcher, repository, publishProcessing } = setup();
    repository.claimOutbox.mockResolvedValue({
      ...row,
      payload: { ...message, messageId: message.jobId },
    });
    await dispatcher.dispatchOnce();
    expect(publishProcessing).not.toHaveBeenCalled();
    expect(repository.recordOutboxFailure).toHaveBeenCalledWith(
      row.id,
      row.claimToken,
      now,
      'INVALID_OUTBOX_PAYLOAD',
      expect.any(Date),
    );
  });

  it('stops polling and drains the in-flight publication on shutdown', async () => {
    let confirm: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const { dispatcher, repository, publishProcessing } = setup(
      jest.fn().mockReturnValue(pending),
    );
    dispatcher.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishProcessing).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = dispatcher.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    confirm?.();
    await stopping;
    expect(repository.findPendingOutbox).toHaveBeenCalledTimes(1);
  });
});
