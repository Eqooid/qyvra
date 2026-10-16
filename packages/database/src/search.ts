import { createHash } from 'node:crypto';
import { ProcessingError } from './processing-rules';

export const searchGenerationStatuses = [
  'BUILDING',
  'SERVING',
  'RETIRED',
] as const;
export const searchProjectionStatuses = [
  'BUILDING',
  'READY',
  'REMOVAL_PENDING',
  'REMOVED',
  'FAILED',
] as const;
export const searchTextCoverageStates = [
  'NOT_REQUESTED',
  'PENDING',
  'READY',
  'UNSUPPORTED',
  'FAILED',
] as const;
export interface SearchGenerationIdentity {
  schemaVersion: number;
  mappingVersion: string;
  analyzerVersion: string;
  extractor: string;
  extractorVersion: string;
  normalizationVersion: string;
  segmentationVersion: string;
}
interface SearchJobIdentity {
  userId: string;
  documentId: string;
  documentVersionId: string;
  searchProjectionId: string;
  correlationId: string;
  maxAttempts: number;
}
export type NewSearchJob = SearchJobIdentity &
  (
    | {
        jobType: 'INDEX_SEARCH' | 'REMOVE_SEARCH_INDEX';
        predecessorJobId?: never;
      }
    | { jobType: 'EXTRACT_SEARCH_TEXT'; predecessorJobId: string }
  );
export function assertSearchUuid(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new ProcessingError('INVALID_INPUT');
}
export function assertSearchRevision(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647)
    throw new ProcessingError('INVALID_INPUT');
}
export function searchGenerationFingerprint(
  identity: SearchGenerationIdentity,
): string {
  assertSearchRevision(identity.schemaVersion);
  const values = [
    identity.mappingVersion,
    identity.analyzerVersion,
    identity.extractor,
    identity.extractorVersion,
    identity.normalizationVersion,
    identity.segmentationVersion,
  ];
  if (
    values.some(
      (value) =>
        typeof value !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value),
    )
  )
    throw new ProcessingError('INVALID_INPUT');
  return createHash('sha256')
    .update(
      JSON.stringify([
        'qyvra.search-generation.v1',
        identity.schemaVersion,
        ...values,
      ]),
    )
    .digest('hex');
}
/** UUIDv5 over a permanently fixed namespace; equivalent owned builds share identity. */
export function searchProjectionId(
  versionId: string,
  generationId: string,
  revision: number,
): string {
  assertSearchUuid(versionId);
  assertSearchUuid(generationId);
  assertSearchRevision(revision);
  const namespace = Buffer.from('4a03a0540f6f50e8a6cf5e2366f5d0ed', 'hex');
  const digest = createHash('sha1')
    .update(namespace)
    .update(
      JSON.stringify([
        versionId.toLowerCase(),
        generationId.toLowerCase(),
        revision,
      ]),
    )
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function searchRecordId(
  projectionId: string,
  source:
    | { kind: 'metadata' }
    | { kind: 'page'; pageNumber: number; segment: number },
): string {
  assertSearchUuid(projectionId);
  if (source.kind === 'metadata')
    return `${projectionId.toLowerCase()}:metadata`;
  if (
    source.kind !== 'page' ||
    !Number.isSafeInteger(source.pageNumber) ||
    source.pageNumber < 1 ||
    source.pageNumber > 2147483647 ||
    !Number.isSafeInteger(source.segment) ||
    source.segment < 0 ||
    source.segment > 2147483647
  )
    throw new ProcessingError('INVALID_INPUT');
  return `${projectionId.toLowerCase()}:page:${source.pageNumber}:${source.segment}`;
}
