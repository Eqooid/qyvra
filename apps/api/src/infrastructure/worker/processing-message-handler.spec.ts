import type { ProcessingMessageV1 } from '@qyvra/database';
import { ProcessingError, type ProcessingRepository } from '@qyvra/database';
import {
  ProcessingMessageHandler,
  type ProcessingJobHandler,
} from './processing-message-handler';
import type { ProcessingProgressStore } from '../progress/processing-progress';

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
const now = new Date('2026-01-01T00:01:00.000Z');
const job = {
  id: message.jobId,
  documentId: message.documentId,
  documentVersionId: message.documentVersionId,
  jobType: message.jobType,
  correlationId: message.correlationId,
  status: 'PENDING',
  attempts: 0,
  leaseToken: null,
  leaseExpiresAt: null,
};

function setup(handlers: ProcessingJobHandler[] = []) {
  const repository = {
    findById: jest.fn().mockResolvedValue(job),
    claim: jest.fn().mockResolvedValue({
      ...job,
      status: 'PROCESSING',
      attempts: 1,
      leaseToken: 'lease',
    }),
    complete: jest.fn().mockResolvedValue({ ...job, status: 'COMPLETED' }),
    fail: jest.fn().mockResolvedValue({ ...job, status: 'RETRYING' }),
    recoverInterrupted: jest
      .fn()
      .mockResolvedValue({ ...job, status: 'RETRYING' }),
  };
  return {
    repository,
    handler: new ProcessingMessageHandler(
      repository as unknown as ProcessingRepository,
      handlers,
      () => now,
      120000,
    ),
  };
}

describe('processing message boundary', () => {
  it('clears progress only after durable completion or retry and tolerates cleanup loss', async () => {
    const clear = jest.fn().mockRejectedValue(new Error('redis unavailable'));
    const execute = jest.fn().mockResolvedValue({ kind: 'success' });
    const { repository } = setup();
    const handler = new ProcessingMessageHandler(
      repository as unknown as ProcessingRepository,
      [{ jobType: 'VERIFY_STORED_FILE', execute }],
      () => now,
      120000,
      { clear } as unknown as ProcessingProgressStore,
    );
    expect(await handler.handle(message, false)).toBe('ack');
    expect(repository.complete).toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith(job.id, 1);
    execute.mockResolvedValue({
      kind: 'retryable',
      failureCode: 'STORAGE_READ_FAILED',
    });
    expect(await handler.handle(message, false)).toBe('ack');
    expect(repository.fail).toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it('does not claim real work while no production handler exists', async () => {
    const { handler, repository } = setup();
    expect(await handler.handle(message, false)).toBe('dead-letter');
    expect(repository.claim).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('rejects missing and mismatched jobs without inventing state', async () => {
    const { handler, repository } = setup();
    repository.findById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...job, documentId: message.jobId });
    expect(await handler.handle(message, false)).toBe('dead-letter');
    expect(await handler.handle(message, false)).toBe('dead-letter');
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('acks terminal duplicates without spending a claim', async () => {
    const { handler, repository } = setup();
    repository.findById.mockResolvedValue({
      ...job,
      status: 'COMPLETED',
      attempts: 1,
    });
    expect(await handler.handle(message, true)).toBe('ack');
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('claims and completes only through T03 after a test handler succeeds', async () => {
    const execute = jest.fn().mockResolvedValue({ kind: 'success' });
    const { handler, repository } = setup([
      { jobType: 'VERIFY_STORED_FILE', execute },
    ]);
    expect(await handler.handle(message, false)).toBe('ack');
    expect(repository.claim).toHaveBeenCalledWith(job.id, now, 120000);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, attempt: 1 }),
    );
    expect(repository.complete).toHaveBeenCalledWith(job.id, 'lease', now);
  });

  it('persists a retryable handler outcome before ack', async () => {
    const { handler, repository } = setup([
      {
        jobType: 'VERIFY_STORED_FILE',
        execute: async () => ({
          kind: 'retryable',
          failureCode: 'TEST_FAILURE',
        }),
      },
    ]);
    expect(await handler.handle(message, false)).toBe('ack');
    expect(repository.fail).toHaveBeenCalledWith(
      job.id,
      'lease',
      now,
      'TEST_FAILURE',
      true,
    );
  });

  it('holds a redelivered in-progress message and recovers an expired lease', async () => {
    const { handler, repository } = setup();
    repository.findById.mockResolvedValueOnce({
      ...job,
      status: 'PROCESSING',
      attempts: 1,
      leaseToken: 'lease',
      leaseExpiresAt: new Date(now.getTime() + 1000),
    });
    expect(await handler.handle(message, true)).toBe('retry');
    repository.findById.mockResolvedValueOnce({
      ...job,
      status: 'PROCESSING',
      attempts: 1,
      leaseToken: 'lease',
      leaseExpiresAt: new Date(now.getTime() - 1),
    });
    expect(await handler.handle(message, true)).toBe('ack');
    expect(repository.recoverInterrupted).toHaveBeenCalledWith(
      job.id,
      'lease',
      now,
    );
  });

  it('returns retry on competing claim until PostgreSQL gives a durable outcome', async () => {
    const execute = jest.fn();
    const { handler, repository } = setup([
      { jobType: 'VERIFY_STORED_FILE', execute },
    ]);
    repository.claim.mockRejectedValue(
      new ProcessingError('CONCURRENT_CHANGE'),
    );
    repository.findById
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({ ...job, status: 'PROCESSING', attempts: 1 });
    expect(await handler.handle(message, false)).toBe('retry');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate registrations at startup', () => {
    const testHandler: ProcessingJobHandler = {
      jobType: 'VERIFY_STORED_FILE',
      execute: async () => ({ kind: 'success' }),
    };
    expect(() => setup([testHandler, testHandler])).toThrow(
      'Duplicate processing handler registration.',
    );
  });
});
