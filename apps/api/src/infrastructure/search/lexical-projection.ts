import { createHash } from 'node:crypto';
import {
  searchRecordId,
  type DocumentVersion,
  type Document,
  type VersionSearchProjection,
} from '@qyvra/database';
import { canonicalJson } from '../extraction/pdf-extraction';
import type { CanonicalContent } from '../extraction/pdf-parser';
import {
  SearchStoreFailure,
  type SearchGenerationTarget,
  type SearchRecord,
  type SearchRecordBase,
} from './lexical-store';
import {
  contract,
  recordId,
  indexName,
  searchRecordSource,
  SEARCH_MAX_PROJECTION_RECORDS,
  SEARCH_MAX_SEGMENT_CHARACTERS,
} from './search-index';

/** Scalar offsets address the canonical artifact; no tokenizer/model/embedding limit. */
export function lexicalRecords(
  p: Pick<
    VersionSearchProjection,
    | 'userId'
    | 'documentId'
    | 'documentVersionId'
    | 'id'
    | 'revision'
    | 'indexGenerationId'
    | 'metadataHash'
  >,
  document: Pick<
    Document,
    | 'title'
    | 'description'
    | 'issuer'
    | 'referenceNumber'
    | 'categoryId'
    | 'documentDate'
    | 'expirationDate'
    | 'documentType'
    | 'status'
    | 'createdAt'
    | 'updatedAt'
  >,
  version: Pick<DocumentVersion, 'originalFilename' | 'mimeType' | 'fileSize'>,
  tagIds: string[],
  artifact?: CanonicalContent & { contentHash: string },
): SearchRecord[] {
  const base: SearchRecordBase = {
    userId: p.userId,
    documentId: p.documentId,
    documentVersionId: p.documentVersionId,
    projectionId: p.id,
    revision: p.revision,
    indexGenerationId: p.indexGenerationId,
    sourceHash: p.metadataHash,
  };
  const records: SearchRecord[] = [
    {
      ...base,
      kind: 'metadata',
      title: document.title,
      ...(document.description !== null
        ? { description: document.description }
        : {}),
      ...(document.issuer !== null ? { issuer: document.issuer } : {}),
      ...(document.referenceNumber !== null
        ? { referenceNumber: document.referenceNumber }
        : {}),
      ...(document.categoryId !== null
        ? { categoryId: document.categoryId }
        : {}),
      ...(document.documentDate
        ? { documentDate: document.documentDate.toISOString().slice(0, 10) }
        : {}),
      ...(document.expirationDate
        ? { expirationDate: document.expirationDate.toISOString().slice(0, 10) }
        : {}),
      filename: version.originalFilename,
      mimeType: version.mimeType,
      documentType: document.documentType,
      status: document.status,
      tagIds: [...tagIds].sort(),
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
      fileSize: version.fileSize,
    },
  ];
  if (!artifact) return records;
  if (
    createHash('sha256').update(artifact.text).digest('hex') !==
    artifact.contentHash
  )
    contract();
  const scalars = Array.from(artifact.text);
  if (
    scalars.length !== artifact.characterCount ||
    artifact.pageSpans.length !== artifact.pageCount
  )
    contract();
  let end = 0;
  for (const [ordinal, page] of artifact.pageSpans.entries()) {
    if (
      page.pageNumber !== ordinal + 1 ||
      !Number.isSafeInteger(page.startOffset) ||
      !Number.isSafeInteger(page.endOffset) ||
      page.startOffset !== end + (ordinal ? 2 : 0) ||
      page.endOffset < page.startOffset ||
      page.endOffset > scalars.length
    )
      contract();
    end = page.endOffset;
    for (
      let start = page.startOffset, segment = 0;
      start < end;
      start += SEARCH_MAX_SEGMENT_CHARACTERS, segment++
    ) {
      const stop = Math.min(end, start + SEARCH_MAX_SEGMENT_CHARACTERS);
      const text = scalars.slice(start, stop).join('');
      if (!text.trim()) continue;
      records.push({
        ...base,
        kind: 'page',
        sourceHash: artifact.contentHash,
        pageNumber: page.pageNumber,
        segment,
        startOffset: start,
        endOffset: stop,
        text,
      });
      if (records.length > SEARCH_MAX_PROJECTION_RECORDS) contract();
    }
  }
  if (end !== scalars.length || records.length === 1) contract();
  return records;
}

export function lexicalManifest(records: readonly SearchRecord[]) {
  return {
    expectedRecordIds: records.map((r) =>
      searchRecordId(
        r.projectionId,
        r.kind === 'metadata'
          ? { kind: 'metadata' }
          : { kind: 'page', pageNumber: r.pageNumber, segment: r.segment },
      ),
    ),
    expectedRecordCount: records.length,
    recordsHash: createHash('sha256')
      .update(canonicalJson(records))
      .digest('hex'),
  };
}

/** Account for actual UTF-8 source/action bytes, not just record count. */
export function lexicalBatches(
  records: readonly SearchRecord[],
  target: SearchGenerationTarget,
  prefix: string,
  maxCount: number,
  maxBytes: number,
): SearchRecord[][] {
  const batches: SearchRecord[][] = [];
  let batch: SearchRecord[] = [],
    bytes = 2;
  for (const record of records) {
    const action = {
      index: {
        _index: indexName(
          prefix,
          target,
          record.kind === 'metadata' ? 'metadata' : 'pages',
        ),
        _id: recordId(record),
      },
    };
    const size =
      Buffer.byteLength(JSON.stringify(action)) +
      Buffer.byteLength(JSON.stringify(searchRecordSource(record))) +
      4;
    if (size + 2 > maxBytes) throw new SearchStoreFailure('SEARCH_CAPACITY');
    if (
      batch.length &&
      (batch.length === maxCount || bytes + size > maxBytes)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    batch.push(record);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
