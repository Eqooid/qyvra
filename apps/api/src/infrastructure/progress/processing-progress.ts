export const PROCESSING_PROGRESS = Symbol('PROCESSING_PROGRESS');

export const processingStages = [
  'PREPARING',
  'READING',
  'VERIFYING',
  'FINALIZING',
  'EXTRACTING',
  'CHUNKING',
  'EMBEDDING',
  'INDEXING',
  'CLEANING',
] as const;

export type ProcessingStage = (typeof processingStages)[number];

/** Disposable observation of one claimed attempt, never a job-state authority. */
export interface ProcessingProgress {
  readonly attempt: number;
  readonly percent: number;
  readonly stage: ProcessingStage;
  readonly updatedAt: string;
}

export interface ProcessingProgressStore {
  report(
    jobId: string,
    attempt: number,
    percent: number,
    stage: ProcessingStage,
  ): Promise<void>;
  read(jobId: string, attempt: number): Promise<ProcessingProgress | null>;
  clear(jobId: string, attempt: number): Promise<void>;
}
