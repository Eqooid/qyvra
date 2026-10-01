import type { ProcessingJobStatus } from './processing';

export type ProcessingErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_JOB_TYPE'
  | 'DUPLICATE_JOB'
  | 'INVALID_TRANSITION'
  | 'CONCURRENT_CHANGE'
  | 'INELIGIBLE_DOCUMENT';

export class ProcessingError extends Error {
  constructor(readonly code: ProcessingErrorCode) {
    super(code);
    this.name = 'ProcessingError';
  }
}

const nextStates: Record<ProcessingJobStatus, readonly ProcessingJobStatus[]> =
  {
    PENDING: ['QUEUED', 'PROCESSING', 'CANCELLED'],
    QUEUED: ['PROCESSING', 'CANCELLED'],
    PROCESSING: ['COMPLETED', 'RETRYING', 'FAILED', 'CANCELLED'],
    RETRYING: ['QUEUED', 'PROCESSING', 'FAILED', 'CANCELLED'],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
  };

export function assertJobTransition(
  from: ProcessingJobStatus,
  to: ProcessingJobStatus,
): void {
  if (!nextStates[from].includes(to))
    throw new ProcessingError('INVALID_TRANSITION');
}

/** A deterministic 0–20% jitter keeps retries testable and disperses workers. */
export function retryDelayMs(jobId: string, attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new ProcessingError('INVALID_INPUT');
  const base = Math.min(300_000, 5_000 * 2 ** Math.min(attempt - 1, 16));
  let hash = attempt;
  for (const char of jobId)
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return Math.min(300_000, base + Math.floor((base * (hash % 21)) / 100));
}

export function assertFailureCode(code: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code))
    throw new ProcessingError('INVALID_INPUT');
}

export function assertPositiveDuration(milliseconds: number): void {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 3_600_000
  )
    throw new ProcessingError('INVALID_INPUT');
}
