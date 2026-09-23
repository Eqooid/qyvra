import { StorageError } from './storage';

/** @author Cristono Wijaya
 * @description Portable ASCII keys avoid path decoding, Windows aliases, alternate streams and traversal.
 * @tags Storage
 */
export function validateStorageKey(key: string): string {
  if (typeof key !== 'string' || key.length > 512 || !key.length)
    throw new StorageError('INVALID_KEY');
  const parts = key.split('/');
  if (
    parts.length > 16 ||
    parts.some(
      (part) =>
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(part) ||
        part.endsWith('.') ||
        part.includes('..') ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(part),
    )
  )
    throw new StorageError('INVALID_KEY');
  return key;
}

/** @description Uses trusted internal UUIDs and a validated extension, never the original display filename. */
export function originalDocumentKey(
  userId: string,
  documentId: string,
  versionId: string,
  extension: string,
): string {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    ![userId, documentId, versionId].every(
      (id) => typeof id === 'string' && uuid.test(id),
    ) ||
    typeof extension !== 'string' ||
    !/^[a-z0-9]{1,10}$/.test(extension)
  )
    throw new StorageError('INVALID_KEY');
  return validateStorageKey(
    `documents/${userId.toLowerCase()}/${documentId.toLowerCase()}/${versionId.toLowerCase()}/original.${extension}`,
  );
}
