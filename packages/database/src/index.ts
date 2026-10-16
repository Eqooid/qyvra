import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export { Prisma, PrismaClient } from './generated/prisma/client';
export type {
  Document,
  DocumentVersion,
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
  legacyProcessingJobTypes,
  searchProcessingJobTypes,
  isSearchJobType,
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
  ProcessingMessageV3,
  SearchProcessingJobType,
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
    // Date parameters and versioned ISO envelopes must use the same UTC session.
    options: '-c timezone=UTC',
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
export { SearchPersistenceRepository } from './search-repository';
export {
  searchGenerationFingerprint,
  searchProjectionId,
  searchRecordId,
  searchGenerationStatuses,
  searchProjectionStatuses,
  searchTextCoverageStates,
} from './search';
export type { SearchGenerationIdentity, NewSearchJob } from './search';
export type {
  SearchIndexGeneration,
  DocumentSearchState,
  VersionSearchProjection,
  SearchProjectionChange,
} from './generated/prisma/client';

export { SearchEnrollmentRepository } from './search-enrollment';
export { SearchMaintenanceScheduler } from './search-maintenance';
export type { SearchMaintenanceOperation } from './generated/prisma/client';
export type { SearchEnrollmentPolicy } from './search-enrollment';
