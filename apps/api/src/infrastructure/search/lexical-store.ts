/** Internal contracts: SQL callers must authorize these exact immutable scopes. */
export const LEXICAL_STORE = Symbol('LEXICAL_STORE');
export type SearchIndexKind = 'metadata' | 'pages';
export interface SearchGenerationTarget {
  id: string;
  generation: number;
  fingerprint: string;
}
export interface SearchProjectionScope {
  documentId: string;
  documentVersionId: string;
  projectionId: string;
  revision: number;
}
export interface SearchRecordBase extends SearchProjectionScope {
  userId: string;
  indexGenerationId: string;
  sourceHash: string;
}
export interface SearchMetadataRecord extends SearchRecordBase {
  kind: 'metadata';
  title: string;
  description?: string;
  issuer?: string;
  referenceNumber?: string;
  filename: string;
  mimeType: string;
  documentType: string;
  status: string;
  categoryId?: string;
  tagIds: string[];
  documentDate?: string;
  expirationDate?: string;
  createdAt: string;
  updatedAt: string;
  fileSize: number;
}
export interface SearchPageRecord extends SearchRecordBase {
  kind: 'page';
  pageNumber: number;
  segment: number;
  startOffset: number;
  endOffset: number;
  text: string;
}
export type SearchRecord = SearchMetadataRecord | SearchPageRecord;
export interface LexicalQuery {
  userId: string;
  scopes: readonly SearchProjectionScope[];
  text: string;
  mode: 'terms' | 'phrase' | 'prefix';
  limit: number;
  /** Exact record restriction for optional page enrichment; never changes cached ranks. */
  recordIds?: readonly string[];
}
export type SearchHighlightField =
  'title' | 'description' | 'issuer' | 'referenceNumber' | 'filename' | 'text';
export interface HighlightRange {
  start: number;
  end: number;
}
export interface LexicalHighlightHint {
  field: SearchHighlightField;
  text: string;
  ranges: HighlightRange[];
}
export interface LexicalHit {
  id: string;
  score: number;
  record: SearchRecord;
  highlights?: LexicalHighlightHint[];
}
export type SearchFailureCode =
  | 'SEARCH_NOT_CONFIGURED'
  | 'SEARCH_AUTH_FAILED'
  | 'SEARCH_TLS_FAILED'
  | 'SEARCH_UNAVAILABLE'
  | 'SEARCH_TIMEOUT'
  | 'SEARCH_CANCELLED'
  | 'SEARCH_INDEX_MISSING'
  | 'SEARCH_INDEX_INCOMPATIBLE'
  | 'SEARCH_CONTRACT_INVALID'
  | 'SEARCH_CONFLICT'
  | 'SEARCH_RATE_LIMITED'
  | 'SEARCH_CAPACITY';
export class SearchStoreFailure extends Error {
  readonly retryable: boolean;
  constructor(readonly code: SearchFailureCode) {
    super(code);
    this.name = 'SearchStoreFailure';
    this.retryable = [
      'SEARCH_UNAVAILABLE',
      'SEARCH_TIMEOUT',
      'SEARCH_RATE_LIMITED',
      'SEARCH_CAPACITY',
    ].includes(code);
  }
}
export interface LexicalStore {
  /** Operator-only owner-filtered identity scan. No body/title is returned. */
  scan?(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    userId: string,
    after: readonly (string | number)[] | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{
    records: {
      id: string;
      userId: string;
      documentId: string;
      documentVersionId: string;
      projectionId: string;
      revision: number;
      sourceHash: string;
    }[];
    next: (string | number)[] | null;
  }>;
  availability(
    signal?: AbortSignal,
  ): Promise<{ available: true; version: string }>;
  inspect(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    signal?: AbortSignal,
  ): Promise<{ exists: boolean; compatible: boolean }>;
  createIndexes(
    target: SearchGenerationTarget,
    signal?: AbortSignal,
  ): Promise<void>;
  upsert(
    target: SearchGenerationTarget,
    records: readonly SearchRecord[],
    signal?: AbortSignal,
  ): Promise<void>;
  verify(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    userId: string,
    scope: SearchProjectionScope,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<SearchRecord[]>;
  /** Search-visible exact scope cardinality and exact expected sources; not realtime mget. */
  verifyPublication(
    target: SearchGenerationTarget,
    userId: string,
    scope: SearchProjectionScope,
    records: readonly SearchRecord[],
    signal?: AbortSignal,
  ): Promise<void>;
  remove(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    userId: string,
    scope: SearchProjectionScope,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>;
  query(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    query: LexicalQuery,
    signal?: AbortSignal,
  ): Promise<LexicalHit[]>;
  close(): Promise<void>;
}
