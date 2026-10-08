import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export { Prisma, PrismaClient } from './generated/prisma/client';
export type {
  AiProcessingRun,
  ExtractedText,
  ChunkSet,
  DocumentChunk,
  EmbeddingProfile,
  ChunkEmbedding,
  VersionVectorIndex,
  VersionAiState,
  VersionReadyIndex,
  AiServingProfile,
} from './generated/prisma/client';
export {
  aiRunStatuses,
  vectorIndexStatuses,
  aiStagePrerequisites,
  embeddingProfileFingerprint,
} from './ai';
export type {
  AiRunStatus,
  VectorIndexStatus,
  SourcePageSpan,
  EmbeddingProfileIdentity,
  AiStageType,
} from './ai';
export {
  createStoredFileVerificationIntent,
  createProcessingOutboxIntent,
  processingJobStatuses,
  processingJobTypes,
  processingOutboxStatuses,
} from './processing';
export { ProcessingRepository } from './processing-repository';
export {
  ProcessingError,
  assertJobTransition,
  retryDelayMs,
} from './processing-rules';
export type { ProcessingErrorCode } from './processing-rules';
export type {
  NewStoredFileVerification,
  ProcessingJobStatus,
  ProcessingJobType,
  ProcessingOutboxStatus,
  ProcessingMessageV1,
  ProcessingMessageV2,
  ProcessingMessage,
} from './processing';

export interface DatabaseOptions {
  readonly url: string;
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly poolSize: number;
}

export function createPrismaClient(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.url,
    max: options.poolSize,
    connectionTimeoutMillis: options.connectTimeoutMs,
    query_timeout: options.queryTimeoutMs,
    statement_timeout: options.queryTimeoutMs,
    idleTimeoutMillis: 10000,
  });
  return new PrismaClient({ adapter, log: [] });
}

export type { AiRunRequest, StageCommit } from './processing-pipeline';
export type { AiProcessingStart } from './ai-scheduling';
