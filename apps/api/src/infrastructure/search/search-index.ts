import { createHash } from 'node:crypto';
import { searchRecordId, searchProjectionId } from '@qyvra/database';
import {
  SearchGenerationTarget,
  SearchIndexKind,
  SearchProjectionScope,
  SearchRecord,
  SearchStoreFailure,
} from './lexical-store';

export const SEARCH_SCHEMA_VERSION = 1;
export const SEARCH_MAPPING_VERSION = 'lexical-metadata-pages-v1';
export const SEARCH_ANALYZER_VERSION = 'unicode-standard-lower-v1';
export const SEARCH_SEGMENTATION_VERSION = 'scalar-8192-v1';
export const SEARCH_MAX_SEGMENT_CHARACTERS = 8192;
export const SEARCH_MAX_PROJECTION_RECORDS = 10000;
export function contract(): never {
  throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
}
export function uuid(value: string) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    contract();
}
export function positive(value: number, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) contract();
}
export function scopeValid(scope: SearchProjectionScope) {
  if (!scope || typeof scope !== 'object') contract();
  uuid(scope.documentId);
  uuid(scope.documentVersionId);
  uuid(scope.projectionId);
  positive(scope.revision);
}
export function targetValid(target: SearchGenerationTarget) {
  if (!target || typeof target !== 'object') contract();
  uuid(target.id);
  positive(target.generation);
  if (!/^[0-9a-f]{64}$/.test(target.fingerprint)) contract();
}
export function indexName(
  prefix: string,
  target: SearchGenerationTarget,
  kind: SearchIndexKind,
) {
  targetValid(target);
  if (
    !/^qyvra-search(?:-[a-z0-9]+)*$/.test(prefix) ||
    prefix.length > 40 ||
    !['metadata', 'pages'].includes(kind)
  )
    contract();
  return `${prefix}-s1-g${target.generation}-${target.fingerprint}-${kind}`;
}
/** Future SQL consumers must reject incompatible immutable names/versions, never rename them. */
export function targetFromGeneration(
  prefix: string,
  generation: SearchGenerationTarget & {
    metadataIndexName: string;
    pageIndexName: string;
    schemaVersion: number;
    mappingVersion: string;
    analyzerVersion: string;
    segmentationVersion: string;
  },
): SearchGenerationTarget {
  targetValid(generation);
  if (
    generation.schemaVersion !== SEARCH_SCHEMA_VERSION ||
    generation.mappingVersion !== SEARCH_MAPPING_VERSION ||
    generation.analyzerVersion !== SEARCH_ANALYZER_VERSION ||
    generation.segmentationVersion !== SEARCH_SEGMENTATION_VERSION ||
    generation.metadataIndexName !==
      indexName(prefix, generation, 'metadata') ||
    generation.pageIndexName !== indexName(prefix, generation, 'pages')
  )
    contract();
  return {
    id: generation.id,
    generation: generation.generation,
    fingerprint: generation.fingerprint,
  };
}
const keyword = { type: 'keyword', index: true, doc_values: true };
const text = { type: 'text', analyzer: 'qyvra_text', index_options: 'offsets' };
const common = {
  kind: keyword,
  userId: keyword,
  documentId: keyword,
  documentVersionId: keyword,
  projectionId: keyword,
  indexGenerationId: keyword,
  sourceHash: keyword,
  revision: { type: 'integer', coerce: false },
};
export function indexDefinition(
  target: SearchGenerationTarget,
  kind: SearchIndexKind,
) {
  targetValid(target);
  const properties =
    kind === 'metadata'
      ? {
          ...common,
          title: { ...text, copy_to: 'suggestText' },
          description: text,
          issuer: { ...text, copy_to: 'suggestText' },
          referenceNumber: { ...text, copy_to: 'suggestText' },
          referenceExact: { type: 'keyword', normalizer: 'qyvra_exact' },
          filename: { ...text, copy_to: 'suggestText' },
          suggestText: {
            type: 'search_as_you_type',
            analyzer: 'qyvra_text',
            max_shingle_size: 3,
          },
          mimeType: keyword,
          documentType: keyword,
          status: keyword,
          categoryId: keyword,
          tagIds: keyword,
          documentDate: { type: 'date', format: 'strict_date' },
          expirationDate: { type: 'date', format: 'strict_date' },
          createdAt: { type: 'date', format: 'strict_date_time' },
          updatedAt: { type: 'date', format: 'strict_date_time' },
          fileSize: { type: 'long', coerce: false },
        }
      : {
          ...common,
          pageNumber: { type: 'integer', coerce: false },
          segment: { type: 'integer', coerce: false },
          startOffset: { type: 'integer', coerce: false },
          endOffset: { type: 'integer', coerce: false },
          text,
        };
  const analysis = {
    analyzer: {
      qyvra_text: {
        type: 'custom',
        tokenizer: 'standard',
        filter: ['lowercase'],
      },
    },
    normalizer: { qyvra_exact: { type: 'custom', filter: ['lowercase'] } },
  };
  const mappingHash = createHash('sha256')
    .update(JSON.stringify({ properties, analysis, dynamic: 'strict' }))
    .digest('hex');
  return {
    settings: { number_of_shards: 1, number_of_replicas: 0, analysis },
    mappings: {
      dynamic: 'strict' as const,
      _source: { enabled: true },
      _meta: {
        contract: 'qyvra.lexical.v1',
        mappingVersion: SEARCH_MAPPING_VERSION,
        schemaVersion: 1,
        analyzerVersion: SEARCH_ANALYZER_VERSION,
        segmentationVersion: SEARCH_SEGMENTATION_VERSION,
        mappingHash,
        indexGenerationId: target.id,
        generationFingerprint: target.fingerprint,
        kind,
      },
      properties,
    },
  };
}
export function recordId(record: SearchRecord) {
  return searchRecordId(
    record.projectionId,
    record.kind === 'metadata'
      ? { kind: 'metadata' }
      : {
          kind: 'page',
          pageNumber: record.pageNumber,
          segment: record.segment,
        },
  );
}
export function recordValid(
  record: SearchRecord,
  target: SearchGenerationTarget,
) {
  if (!record || typeof record !== 'object') contract();
  targetValid(target);
  scopeValid(record);
  if (
    record.projectionId !==
    searchProjectionId(record.documentVersionId, target.id, record.revision)
  )
    contract();
  uuid(record.userId);
  uuid(record.indexGenerationId);
  if (
    record.indexGenerationId !== target.id ||
    !/^[0-9a-f]{64}$/.test(record.sourceHash)
  )
    contract();
  const fields = [
    'kind',
    'userId',
    'documentId',
    'documentVersionId',
    'projectionId',
    'revision',
    'indexGenerationId',
    'sourceHash',
  ];
  const string = (value: unknown, max: number, required = false) => {
    if (value === undefined && !required) return;
    if (
      typeof value !== 'string' ||
      value.length > max ||
      (required && !value.length) ||
      /\u0000/.test(value)
    )
      contract();
  };
  if (record.kind === 'metadata') {
    fields.push(
      'title',
      'description',
      'issuer',
      'referenceNumber',
      'filename',
      'mimeType',
      'documentType',
      'status',
      'categoryId',
      'tagIds',
      'documentDate',
      'expirationDate',
      'createdAt',
      'updatedAt',
      'fileSize',
    );
    string(record.title, 500, true);
    string(record.filename, 255, true);
    string(record.description, 10000);
    string(record.issuer, 500);
    string(record.referenceNumber, 500);
    for (const value of [record.mimeType, record.documentType, record.status])
      string(value, 100, true);
    if (record.categoryId !== undefined) uuid(record.categoryId);
    if (
      !Array.isArray(record.tagIds) ||
      record.tagIds.length > 100 ||
      new Set(record.tagIds).size !== record.tagIds.length
    )
      contract();
    record.tagIds.forEach(uuid);
    for (const value of [record.documentDate, record.expirationDate])
      if (
        value !== undefined &&
        (typeof value !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString().slice(0, 10) !== value)
      )
        contract();
    for (const value of [record.createdAt, record.updatedAt])
      if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value
      )
        contract();
    if (!Number.isSafeInteger(record.fileSize) || record.fileSize < 0)
      contract();
  } else if (record.kind === 'page') {
    fields.push('pageNumber', 'segment', 'startOffset', 'endOffset', 'text');
    positive(record.pageNumber);
    if (
      !Number.isSafeInteger(record.segment) ||
      record.segment < 0 ||
      record.segment > 2147483647
    )
      contract();
    if (
      !Number.isSafeInteger(record.startOffset) ||
      record.startOffset < 0 ||
      !Number.isSafeInteger(record.endOffset) ||
      record.endOffset <= record.startOffset ||
      record.endOffset > 2147483647
    )
      contract();
    string(record.text, SEARCH_MAX_SEGMENT_CHARACTERS * 2, true);
    const length = [...record.text].length;
    if (
      length > SEARCH_MAX_SEGMENT_CHARACTERS ||
      length !== record.endOffset - record.startOffset
    )
      contract();
  } else contract();
  if (Object.keys(record).some((key) => !fields.includes(key))) contract();
}

export function searchRecordSource(record: SearchRecord) {
  return record.kind === 'metadata'
    ? {
        ...record,
        ...(record.referenceNumber !== undefined
          ? {
              referenceExact: record.referenceNumber
                .normalize('NFKC')
                .trim()
                .toLowerCase(),
            }
          : {}),
      }
    : record;
}
