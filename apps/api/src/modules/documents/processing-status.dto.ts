import { processingJobTypes } from '@qyvra/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ProcessingProgress,
  processingStages,
} from '../../infrastructure/progress/processing-progress';

export const publicProcessingStates = [
  'PENDING',
  'QUEUED',
  'PROCESSING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type PublicProcessingState = (typeof publicProcessingStates)[number];
export type PublicFailureCode =
  | 'FILE_INTEGRITY_FAILED'
  | 'STORED_FILE_MISSING'
  | 'TEMPORARY_PROCESSING_ERROR'
  | 'PROCESSING_ERROR';

export class ProcessingProgressView implements ProcessingProgress {
  @ApiProperty({ minimum: 1 })
  attempt!: number;

  @ApiProperty({ minimum: 0, maximum: 99 })
  percent!: number;

  @ApiProperty({ enum: processingStages })
  stage!: ProcessingProgress['stage'];

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class ProcessingJobStatusView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: processingJobTypes })
  jobType!: string;

  @ApiProperty({ enum: publicProcessingStates })
  status!: PublicProcessingState;

  @ApiProperty({ minimum: 0 })
  attempts!: number;

  @ApiProperty({ minimum: 1 })
  maxAttempts!: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  nextRetryAt!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  startedAt!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;

  @ApiPropertyOptional({
    enum: [
      'FILE_INTEGRITY_FAILED',
      'STORED_FILE_MISSING',
      'TEMPORARY_PROCESSING_ERROR',
      'PROCESSING_ERROR',
    ],
    nullable: true,
  })
  failureCode!: PublicFailureCode | null;

  @ApiPropertyOptional({ type: ProcessingProgressView, nullable: true })
  progress!: ProcessingProgressView | null;
}

export class PipelineStageView {
  @ApiProperty({ enum: processingJobTypes })
  jobType!: string;
  @ApiProperty({ enum: [...publicProcessingStates, 'NOT_SCHEDULED'] })
  status!: string;
}
export class ProcessingPipelineView {
  @ApiProperty({ format: 'uuid' })
  runId!: string;
  @ApiProperty({ minimum: 1 })
  generation!: number;
  @ApiProperty({
    enum: ['BUILDING', 'READY', 'FAILED', 'CANCELLED', 'SUPERSEDED'],
  })
  status!: string;
  @ApiProperty({ type: String, nullable: true })
  currentStage!: string | null;
  @ApiProperty({ type: [PipelineStageView] })
  stages!: PipelineStageView[];
}

export class ProcessingStatusView {
  @ApiProperty({
    enum: ['READY', 'PROCESSING', 'FAILED', 'UNAVAILABLE', 'UNSUPPORTED'],
    description:
      'Owned current-version readiness for the configured serving embedding profile; READY requires an authoritative active index pointer.',
  })
  aiReadiness!: string;
  @ApiPropertyOptional({ type: ProcessingPipelineView })
  pipeline?: ProcessingPipelineView;
  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ format: 'uuid' })
  documentVersionId!: string;

  @ApiProperty({ type: [ProcessingJobStatusView] })
  jobs!: ProcessingJobStatusView[];
}
