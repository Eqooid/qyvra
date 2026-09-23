import { isUUID } from 'class-validator';
import { InvalidDocumentMetadata } from './document-lifecycle';

/**
 * @author Cristono Wijaya
 * @description Represents a cursor used for document pagination, including the document ID, creation timestamp, and sort order.
 * @tags Documents
 */
type DocumentCursor = { id: string; createdAt: string; sort: string };

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
  row: { id: string; createdAt: Date },
  sort: string,
): string {
  return Buffer.from(
    JSON.stringify({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      sort,
    }),
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
  sort: string,
): DocumentCursor {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'createdAt,id,sort'
    )
      throw new Error();
    const row = parsed as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      !isUUID(row.id) ||
      typeof row.createdAt !== 'string' ||
      row.createdAt.startsWith('0000') ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.createdAt) ||
      new Date(row.createdAt).toISOString() !== row.createdAt ||
      row.sort !== sort
    )
      throw new Error();
    return { id: row.id, createdAt: row.createdAt, sort };
  } catch {
    throw new InvalidDocumentMetadata();
  }
}
