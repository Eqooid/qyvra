/**
 * @author Cristono Wijaya
 * @description Central lifecycle vocabulary; PostgreSQL stores strings, not enums.
 * @tags Documents
 */
export const documentStatuses = [
  'UPLOADED',
  'PROCESSING',
  'READY',
  'PARTIALLY_READY',
  'FAILED',
  'ARCHIVED',
  'DELETING',
] as const;
export class DocumentNotFound extends Error {}
export class InvalidDocumentMetadata extends Error {}
export class DocumentStateConflict extends Error {}
export type DocumentAction = 'archive' | 'restore' | 'delete';
export type LifecycleState = {
  status: string;
  isArchived: boolean;
  deletedAt: Date | null;
};

/**
 * @author Cristono Wijaya
 * @description Computes idempotent lifecycle changes without implying successful file processing.
 * @param current - Locked stored state.
 * @param action - Authorized lifecycle action.
 * @param now - Shared transaction timestamp.
 * @returns Only changed fields; empty changes preserve update/revocation timestamps.
 * @tags Documents
 */
export function transitionDocument(
  current: LifecycleState,
  action: DocumentAction,
  now: Date,
): Partial<LifecycleState> {
  if (action === 'archive' && current.deletedAt) throw new DocumentNotFound();
  if (
    !documentStatuses.some((status) => status === current.status) ||
    current.status === 'PROCESSING' ||
    current.status === 'DELETING' ||
    current.isArchived !== (current.status === 'ARCHIVED')
  )
    throw new DocumentStateConflict();
  if (action === 'archive')
    return current.isArchived ? {} : { status: 'ARCHIVED', isArchived: true };
  if (action === 'delete') return current.deletedAt ? {} : { deletedAt: now };
  return current.deletedAt || current.isArchived
    ? { status: 'UPLOADED', isArchived: false, deletedAt: null }
    : {};
}
