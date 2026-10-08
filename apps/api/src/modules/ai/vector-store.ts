import { createHash } from 'node:crypto';
import { validVector } from './embedding-provider';

export interface VectorScope {
  collectionName: string;
  userId: string;
  documentId: string;
  documentVersionId: string;
  chunkSetId: string;
  indexManifestId: string;
  embeddingProfileId: string;
  embeddingProfileVersion: number;
}
export interface VectorPayload extends Omit<VectorScope, 'collectionName'> {
  chunkId: string;
  ordinal: number;
  payloadSchemaVersion: 1;
  pageNumbers: number[];
}
export interface VectorPoint {
  id: string;
  vector: number[];
  payload: VectorPayload;
}
/** Derived-index operations only. Authorization and activation remain in PostgreSQL. */
export interface VectorStore {
  ensureCollection(scope: VectorScope, dimensions: number): Promise<void>;
  upsert(scope: VectorScope, points: VectorPoint[]): Promise<void>;
  verify(scope: VectorScope, points: VectorPoint[]): Promise<boolean>;
  count(scope: VectorScope): Promise<number>;
  remove(scope: VectorScope): Promise<void>;
}
/** Read capability on the same Qyvra boundary; HTTP never bootstraps or repairs indexes. */
export interface VectorSearchRequest {
  userId: string;
  embeddingProfileId: string;
  embeddingProfileVersion: number;
  dimensions: number;
  manifestIds: readonly string[];
  vector: number[];
  limit: number;
  minScore?: number;
}
export interface VectorCandidate {
  chunkId: string;
  indexManifestId: string;
  documentId: string;
  documentVersionId: string;
  chunkSetId: string;
  score: number;
}
export interface VectorSearchStore {
  search(request: VectorSearchRequest): Promise<VectorCandidate[]>;
}
export class VectorStoreFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export function vectorCollectionName(profileId: string): string {
  return `qyvra_chunks_${profileId.replaceAll('-', '')}_v1`;
}
/** UUIDv5 namespace is Qyvra-owned; the manifest isolates replacement generations. */
export function vectorPointId(
  chunkId: string,
  profileId: string,
  manifestId: string,
): string {
  const namespace = Buffer.from('d580c8e7b8f55acf9fe562725451bdd9', 'hex');
  const bytes = createHash('sha1')
    .update(namespace)
    .update(
      JSON.stringify(['qyvra-vector-point/v1', chunkId, profileId, manifestId]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function validateScope(scope: VectorScope): void {
  const ids = [
    scope.userId,
    scope.documentId,
    scope.documentVersionId,
    scope.chunkSetId,
    scope.indexManifestId,
    scope.embeddingProfileId,
  ];
  if (
    !ids.every((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      ),
    ) ||
    scope.collectionName !== vectorCollectionName(scope.embeddingProfileId) ||
    !Number.isSafeInteger(scope.embeddingProfileVersion) ||
    scope.embeddingProfileVersion < 1
  )
    throw new VectorStoreFailure('VECTOR_SCOPE_INVALID');
}
export function validatePoints(
  scope: VectorScope,
  points: VectorPoint[],
  dimensions?: number,
): void {
  validateScope(scope);
  if (
    !points.length ||
    points.length > 256 ||
    new Set(points.map((p) => p.id)).size !== points.length
  )
    throw new VectorStoreFailure('VECTOR_POINTS_INVALID');
  for (const point of points) {
    const { collectionName: _collection, ...expected } = scope;
    void _collection;
    if (
      !point.payload ||
      Object.entries(expected).some(
        ([k, v]) => point.payload[k as keyof VectorPayload] !== v,
      ) ||
      point.id !==
        vectorPointId(
          point.payload.chunkId,
          scope.embeddingProfileId,
          scope.indexManifestId,
        ) ||
      point.payload.payloadSchemaVersion !== 1 ||
      !Number.isSafeInteger(point.payload.ordinal) ||
      point.payload.ordinal < 0 ||
      !validVector(point.vector, dimensions ?? point.vector.length) ||
      !Array.isArray(point.payload.pageNumbers) ||
      point.payload.pageNumbers.some(
        (n) => !Number.isSafeInteger(n) || n < 1,
      ) ||
      Object.keys(point.payload).sort().join(',') !==
        [
          ...Object.keys(expected),
          'chunkId',
          'ordinal',
          'payloadSchemaVersion',
          'pageNumbers',
        ]
          .sort()
          .join(',')
    )
      throw new VectorStoreFailure('VECTOR_POINTS_INVALID');
  }
}
