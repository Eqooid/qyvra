import type { Readable } from 'node:stream';

/** @author Cristono Wijaya
 * @description Shared runtime DI token; consumers use the Storage contract, never a local adapter class.
 * @tags Storage
 */
export const STORAGE = Symbol('brainless.storage');

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

/** @description Streaming, private object operations. Keys are server-generated references, not authorization. */
export interface Storage {
  /** @description Consumes a binary stream with backpressure; atomically creates a new object, never overwrites. */
  save(key: string, source: Readable): Promise<StoredObject>;
  /** @description Returns a stream owned by the caller, which must consume or destroy it. */
  open(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  metadata(key: string): Promise<StoredObject>;
  /** @description Returns true when removed, false when already absent. No directory or recursive deletion. */
  delete(key: string): Promise<boolean>;
}

const messages = {
  NOT_FOUND: 'Stored object not found.',
  INVALID_KEY: 'Invalid storage key.',
  ALREADY_EXISTS: 'Stored object already exists.',
  UNAVAILABLE: 'Storage unavailable.',
  READ_FAILED: 'Stored object read failed.',
  WRITE_FAILED: 'Stored object write failed.',
  DELETE_FAILED: 'Stored object deletion failed.',
} as const;
export type StorageErrorCode = keyof typeof messages;

/** @description Errors expose a stable code and fixed message only; no underlying error, key, root or path. */
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode) {
    super(messages[code]);
    this.name = 'StorageError';
  }
}
