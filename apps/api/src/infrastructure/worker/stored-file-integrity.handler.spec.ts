import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PrismaClient } from '@qyvra/database';
import { Storage, StorageError } from '@qyvra/storage';
import { StoredFileIntegrityHandler } from './stored-file-integrity.handler';
import type { ProcessingProgressStore } from '../progress/processing-progress';

const userId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
const leaseToken = '55555555-5555-4555-8555-555555555555';
const key = `documents/${userId}/${documentId}/${versionId}/original.pdf`;
const contents = Buffer.from('private test bytes');
const checksumSha256 = createHash('sha256').update(contents).digest('hex');
const input = {
  jobId,
  documentId,
  documentVersionId: versionId,
  leaseToken,
  attempt: 1,
};

function setup(file: Buffer = contents) {
  const row = {
    documentId,
    documentVersionId: versionId,
    userId,
    jobType: 'VERIFY_STORED_FILE',
    status: 'PROCESSING',
    leaseToken,
    attempts: 1,
    document: {
      userId,
      deletedAt: null as Date | null,
      isArchived: false,
      status: 'UPLOADED',
    },
    version: {
      documentId,
      userId,
      storageKey: key,
      fileSize: contents.length,
      checksumSha256,
    },
  };
  const findUnique = jest.fn().mockResolvedValue(row);
  const open = jest.fn().mockImplementation(async () => Readable.from([file]));
  const db = { processingJob: { findUnique } } as unknown as PrismaClient;
  const storage = { open } as unknown as Storage;
  return {
    row,
    db,
    storage,
    findUnique,
    open,
    handler: new StoredFileIntegrityHandler(db, storage, 1000),
  };
}

describe('stored-file integrity handler', () => {
  it('reports throttled streaming progress and ignores unavailable Redis writes', async () => {
    const file = Buffer.alloc(1024 * 1024, 7);
    const { row, db, storage, open } = setup();
    row.version.fileSize = file.length;
    row.version.checksumSha256 = createHash('sha256')
      .update(file)
      .digest('hex');
    open.mockImplementation(async () =>
      Readable.from(
        (function* () {
          for (let offset = 0; offset < file.length; offset += 4096)
            yield file.subarray(offset, offset + 4096);
        })(),
      ),
    );
    const report = jest.fn().mockRejectedValue(new Error('redis unavailable'));
    const handler = new StoredFileIntegrityHandler(db, storage, 1000, {
      report,
    } as unknown as ProcessingProgressStore);
    expect(await handler.execute(input)).toEqual({ kind: 'success' });
    expect(report).toHaveBeenCalledWith(jobId, 1, 0, 'PREPARING');
    expect(report).toHaveBeenCalledWith(jobId, 1, 99, 'FINALIZING');
    expect(report.mock.calls.length).toBeLessThan(30);
  });
  it('streams and verifies size and SHA-256 without modifying metadata', async () => {
    const { handler, row, open } = setup();
    expect(await handler.execute(input)).toEqual({ kind: 'success' });
    expect(open).toHaveBeenCalledWith(key);
    expect(row.version.checksumSha256).toBe(checksumSha256);
  });

  it('classifies same-size corruption and short/long streams as terminal', async () => {
    const corrupted = setup(Buffer.from('Private test bytes'));
    expect(await corrupted.handler.execute(input)).toEqual({
      kind: 'terminal',
      failureCode: 'FILE_CHECKSUM_MISMATCH',
    });
    expect(await setup(contents.subarray(0, 3)).handler.execute(input)).toEqual(
      { kind: 'terminal', failureCode: 'FILE_SIZE_MISMATCH' },
    );
    expect(
      await setup(Buffer.concat([contents, Buffer.from('x')])).handler.execute(
        input,
      ),
    ).toEqual({ kind: 'terminal', failureCode: 'FILE_SIZE_MISMATCH' });
  });

  it('distinguishes missing bytes from transient storage/read errors', async () => {
    const missing = setup();
    missing.open.mockRejectedValue(new StorageError('NOT_FOUND'));
    expect(await missing.handler.execute(input)).toEqual({
      kind: 'terminal',
      failureCode: 'FILE_NOT_FOUND',
    });
    const unavailable = setup();
    unavailable.open.mockRejectedValue(new StorageError('UNAVAILABLE'));
    expect(await unavailable.handler.execute(input)).toEqual({
      kind: 'retryable',
      failureCode: 'STORAGE_READ_FAILED',
    });
    const interrupted = setup();
    interrupted.open.mockResolvedValue(
      Readable.from(
        (async function* () {
          yield contents.subarray(0, 2);
          throw new StorageError('READ_FAILED');
        })(),
      ),
    );
    expect(await interrupted.handler.execute(input)).toEqual({
      kind: 'retryable',
      failureCode: 'STORAGE_READ_FAILED',
    });
  });

  it('stops a stalled read before the processing lease expires', async () => {
    const test = setup();
    const stalled = new Readable({ read() {} });
    test.open.mockResolvedValue(stalled);
    const handler = new StoredFileIntegrityHandler(test.db, test.storage, 20);
    expect(await handler.execute(input)).toEqual({
      kind: 'retryable',
      failureCode: 'STORAGE_READ_FAILED',
    });
    expect(stalled.destroyed).toBe(true);
  });

  it('rejects invalid or cross-version metadata before opening private storage', async () => {
    const test = setup();
    test.row.version.checksumSha256 = 'invalid';
    expect(await test.handler.execute(input)).toEqual({
      kind: 'terminal',
      failureCode: 'INTEGRITY_METADATA_INVALID',
    });
    expect(test.open).not.toHaveBeenCalled();
    test.row.version.checksumSha256 = checksumSha256;
    test.row.version.storageKey = `documents/${userId}/${documentId}/${jobId}/original.pdf`;
    expect(await test.handler.execute(input)).toEqual({
      kind: 'terminal',
      failureCode: 'INTEGRITY_METADATA_INVALID',
    });
    expect(test.open).not.toHaveBeenCalled();
  });

  it('does not access files for an archived or soft-deleted document', async () => {
    const test = setup();
    test.row.document.isArchived = true;
    expect(await test.handler.execute(input)).toEqual({
      kind: 'terminal',
      failureCode: 'DOCUMENT_INELIGIBLE',
    });
    test.row.document.isArchived = false;
    test.row.document.deletedAt = new Date();
    expect(await test.handler.execute(input)).toEqual({
      kind: 'terminal',
      failureCode: 'DOCUMENT_INELIGIBLE',
    });
    expect(test.open).not.toHaveBeenCalled();
  });

  it('streams large content in bounded chunks', async () => {
    const chunk = Buffer.alloc(64 * 1024, 17);
    const test = setup();
    test.row.version.fileSize = chunk.length * 256;
    const hash = createHash('sha256');
    for (let i = 0; i < 256; i++) hash.update(chunk);
    test.row.version.checksumSha256 = hash.digest('hex');
    test.open.mockResolvedValue(
      Readable.from(
        (function* () {
          for (let i = 0; i < 256; i++) yield chunk;
        })(),
      ),
    );
    expect(await test.handler.execute(input)).toEqual({ kind: 'success' });
  });
});
