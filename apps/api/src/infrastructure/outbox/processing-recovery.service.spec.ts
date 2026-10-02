import { ProcessingError, type ProcessingRepository } from '@qyvra/database';
import { ProcessingRecovery } from './processing-recovery.service';

const now = new Date('2026-09-29T10:00:00.000Z');
const settings = { pollIntervalMs: 1000, batchSize: 2 };

function setup() {
  const repository = {
    findStaleProcessing: jest.fn().mockResolvedValue([]),
    findRetryEligible: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    recoverInterrupted: jest.fn(),
    scheduleRetryDispatch: jest.fn(),
  };
  return {
    repository,
    recovery: new ProcessingRecovery(
      repository as unknown as ProcessingRepository,
      settings,
      () => now,
    ),
  };
}

describe('processing recovery coordinator', () => {
  it('uses bounded PostgreSQL candidate queries and durable repository operations', async () => {
    const { repository, recovery } = setup();
    repository.findStaleProcessing.mockResolvedValue(['stale-job']);
    repository.findRetryEligible.mockResolvedValue(['due-job']);
    repository.findById.mockResolvedValue({
      status: 'PROCESSING',
      leaseToken: 'lease',
    });
    repository.recoverInterrupted.mockResolvedValue({
      attempts: 1,
      status: 'RETRYING',
    });
    repository.scheduleRetryDispatch.mockResolvedValue({
      id: 'outbox',
      dispatchSequence: 2,
    });
    expect(await recovery.runOnce()).toEqual({ recovered: 1, scheduled: 1 });
    expect(repository.findStaleProcessing).toHaveBeenCalledWith(now, 2);
    expect(repository.recoverInterrupted).toHaveBeenCalledWith(
      'stale-job',
      'lease',
      now,
    );
    expect(repository.findRetryEligible).toHaveBeenCalledWith(now, 2);
    expect(repository.scheduleRetryDispatch).toHaveBeenCalledWith(
      'due-job',
      now,
    );
  });

  it('ignores candidates lost to another coordinator without changing attempts', async () => {
    const { repository, recovery } = setup();
    repository.findStaleProcessing.mockResolvedValue(['stale-job']);
    repository.findRetryEligible.mockResolvedValue(['due-job']);
    repository.findById.mockResolvedValue({
      status: 'PROCESSING',
      leaseToken: 'lease',
    });
    repository.recoverInterrupted.mockRejectedValue(
      new ProcessingError('CONCURRENT_CHANGE'),
    );
    repository.scheduleRetryDispatch.mockRejectedValue(
      new ProcessingError('INVALID_TRANSITION'),
    );
    expect(await recovery.runOnce()).toEqual({ recovered: 0, scheduled: 0 });
  });

  it('surfaces database errors so the poll loop can retry later', async () => {
    const { repository, recovery } = setup();
    repository.findRetryEligible.mockRejectedValue(new Error('database down'));
    await expect(recovery.runOnce()).rejects.toThrow('database down');
  });
});
