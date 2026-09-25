import { isUUID } from 'class-validator';
import { InvalidDocumentMetadata } from './document-lifecycle';

/**
 * @author Cristono Wijaya
 * @description Represents a cursor used for document pagination, including the document ID, creation timestamp, and sort order.
 * @tags Documents
 */
export const documentSorts = [
  '-createdAt',
  'createdAt',
  '-updatedAt',
  'title',
  '-title',
  '-fileSize',
] as const;
export type DocumentSort = (typeof documentSorts)[number];
type CreatedCursor = {
  id: string;
  createdAt: string;
  sort: '-createdAt' | 'createdAt';
};
type ValueCursor = {
  id: string;
  value: string | number | null;
  sort: Exclude<DocumentSort, '-createdAt' | 'createdAt'>;
};
export type DocumentCursor = CreatedCursor | ValueCursor;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  !value.startsWith('0000') &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(new Date(value).getTime()) &&
  new Date(value).toISOString() === value;

/**
 * @author Cristono Wijaya
 * @description Encodes a cursor value for document pagination, including the document ID, creation timestamp, and sort order.
 * @param row - An object containing the document's ID and creation timestamp.
 * @param sort - The sort order associated with the cursor.
 * @returns A base64url-encoded string representing the cursor value.
 * @throws InvalidDocumentMetadata - Throws an error if the cursor cannot be encoded properly.
 * @tags Documents
 */
export function documentCursor(
  row: {
    id: string;
    createdAt: Date;
    sortValue?: Date | string | number | null;
  },
  sort: DocumentSort,
): string {
  const value =
    row.sortValue instanceof Date ? row.sortValue.toISOString() : row.sortValue;
  if (sort !== '-createdAt' && sort !== 'createdAt' && value === undefined)
    throw new InvalidDocumentMetadata();
  return Buffer.from(
    JSON.stringify(
      sort === '-createdAt' || sort === 'createdAt'
        ? { id: row.id, createdAt: row.createdAt.toISOString(), sort }
        : { id: row.id, sort, value },
    ),
  ).toString('base64url');
}

/**
 * @author Cristono Wijaya
 * @description Decodes and validates a cursor value for document pagination.
 * @param value - The base64url-encoded cursor string to be parsed.
 * @param sort - The expected sort order associated with the cursor.
 * @returns A DocumentCursor object containing the parsed id, createdAt, and sort values.
 * @throws InvalidDocumentMetadata - Throws an error if the cursor is invalid or does not match the expected format.
 * @tags Documents
 */
export function parseDocumentCursor(
  value: string,
  sort: DocumentSort,
): DocumentCursor {
  try {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (
      bytes.toString('base64url') !== value ||
      !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
    )
      throw new Error();
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error();
    const row = parsed as Record<string, unknown>;
    if (typeof row.id !== 'string' || !isUUID(row.id) || row.sort !== sort)
      throw new Error();
    if (sort === '-createdAt' || sort === 'createdAt') {
      if (
        Object.keys(row).sort().join(',') !== 'createdAt,id,sort' ||
        !timestamp(row.createdAt)
      )
        throw new Error();
      return { id: row.id, createdAt: row.createdAt, sort };
    }
    if (Object.keys(row).sort().join(',') !== 'id,sort,value')
      throw new Error();
    if (sort === '-updatedAt' && !timestamp(row.value)) throw new Error();
    if (
      (sort === 'title' || sort === '-title') &&
      (typeof row.value !== 'string' ||
        row.value.length < 1 ||
        row.value.length > 300 ||
        /[\u0000-\u001f\u007f]/.test(row.value))
    )
      throw new Error();
    if (
      sort === '-fileSize' &&
      row.value !== null &&
      (typeof row.value !== 'number' ||
        !Number.isSafeInteger(row.value) ||
        row.value < 1 ||
        row.value > 209715200)
    )
      throw new Error();
    return { id: row.id, value: row.value as string | number | null, sort };
  } catch {
    throw new InvalidDocumentMetadata();
  }
}
