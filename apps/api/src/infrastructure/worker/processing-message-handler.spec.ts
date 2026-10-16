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
    cancelObsoleteSearchJob: jest.fn().mockResolvedValue(false),
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
  it('rejects mismatched v3 lineage and dead-letters unavailable search handlers without claiming work', async () => {
    const { repository, handler } = setup();
    const search = {
      ...message,
      schemaVersion: 3 as const,
      jobType: 'INDEX_SEARCH' as const,
      searchProjectionId: '66666666-6666-5666-8666-666666666666',
      indexGenerationId: '77777777-7777-4777-8777-777777777777',
      revision: 1,
    };
    const row = {
      ...job,
      jobType: search.jobType,
      searchProjectionId: search.searchProjectionId,
      searchProjection: {
        indexGenerationId: search.indexGenerationId,
        revision: 1,
      },
    };
    repository.findById.mockResolvedValue(row);
    expect(await handler.handle(search, false)).toBe('dead-letter');
    expect(repository.claim).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    repository.cancelObsoleteSearchJob.mockResolvedValueOnce(true);
    expect(await handler.handle(search, true)).toBe('ack');
    repository.cancelObsoleteSearchJob.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    expect(await handler.handle(search, true)).toBe('retry');
    repository.cancelObsoleteSearchJob.mockClear();
    for (const altered of [
      { revision: 2 },
      { indexGenerationId: message.jobId },
      { searchProjectionId: message.jobId },
    ])
      expect(await handler.handle({ ...search, ...altered }, false)).toBe(
        'dead-letter',
      );
    expect(repository.cancelObsoleteSearchJob).not.toHaveBeenCalled();
  });
  it('persists unavailable AI handler failure and acknowledges only after the write', async () => {
    const { repository, handler } = setup();
    const ai = {
      ...message,
      schemaVersion: 2 as const,
      jobType: 'EXTRACT_TEXT' as const,
    };
    repository.findById.mockResolvedValue({ ...job, jobType: ai.jobType });
    expect(await handler.handle(ai, false)).toBe('ack');
    expect(repository.fail).toHaveBeenCalledWith(
      job.id,
      'lease',
      now,
      'HANDLER_NOT_IMPLEMENTED',
      false,
    );
    expect(repository.complete).not.toHaveBeenCalled();
    repository.fail.mockRejectedValue(new Error('database unavailable'));
    expect(await handler.handle(ai, true)).toBe('retry');
  });

  it('passes a stage publication callback to the fenced repository completion', async () => {
    const commit = jest.fn();
    const execute = jest.fn().mockResolvedValue({ kind: 'success', commit });
    const { repository, handler } = setup([
      { jobType: 'EXTRACT_TEXT', execute },
    ]);
    const ai = {
      ...message,
      schemaVersion: 2 as const,
      jobType: 'EXTRACT_TEXT' as const,
    };
    repository.findById.mockResolvedValue({ ...job, jobType: ai.jobType });
    expect(await handler.handle(ai, false)).toBe('ack');
    expect(repository.complete).toHaveBeenCalledWith(
      job.id,
      'lease',
      now,
      commit,
    );
    expect(commit).not.toHaveBeenCalled();
  });

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
