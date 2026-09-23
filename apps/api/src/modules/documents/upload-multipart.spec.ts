import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { Request } from 'express';
import { Storage } from '@brainless/storage';
import { displayFilename, receiveUpload } from './upload-multipart';
import { validateTestEnvironment } from '../../../test/configuration.fixture';

describe('Streaming multipart admission', () => {
  it.each([false, true])(
    'bounds buffering while incrementally hashing 16 MiB (file-only: %s)',
    async (fileOnly) => {
      const header = Buffer.from('%PDF-1.4\n'),
        block = Buffer.alloc(65536, 32);
      const expected = createHash('sha256').update(header);
      const count = 256;
      for (let i = 0; i < count; i++) expected.update(block);
      const req = Readable.from(
        (async function* () {
          yield Buffer.from(
            `--test\r\n${fileOnly ? '' : 'Content-Disposition: form-data; name="title"\r\n\r\nLarge\r\n--test\r\n'}Content-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          );
          yield header;
          for (let i = 0; i < count; i++) yield block;
          yield Buffer.from('\r\n--test--\r\n');
        })(),
        { objectMode: false, highWaterMark: 65536 },
      ) as unknown as Request;
      req.headers = { 'content-type': 'multipart/form-data; boundary=test' };
      req.is = () => 'multipart/form-data';
      let largest = 0,
        chunks = 0;
      const storage = {
        save: jest.fn(async (key: string, input: Readable) => {
          let size = 0;
          for await (const value of input) {
            const chunk = value as Buffer;
            size += chunk.length;
            largest = Math.max(largest, chunk.length);
            chunks++;
          }
          return { key, size, lastModified: new Date() };
        }),
      } as unknown as Storage;
      const policy = validateTestEnvironment({
        DATABASE_URL: 'postgresql://localhost/test',
      }).upload;
      const result = await receiveUpload(
        req,
        storage,
        {
          userId: randomUUID(),
          documentId: randomUUID(),
          versionId: randomUUID(),
        },
        policy,
        () => undefined,
        fileOnly,
      );
      expect(result.size).toBe(count * block.length + header.length);
      expect(result.checksum).toBe(expected.digest('hex'));
      expect(largest).toBeLessThanOrEqual(131072);
      expect(chunks).toBeGreaterThan(100);
    },
  );
  it('treats paths as display metadata and rejects empty/long/control filenames', () => {
    expect(displayFilename('..\\..\\folder/a.pdf')).toBe('a.pdf');
    expect(displayFilename('folder\uff0fa.pdf')).toBe('a.pdf');
    for (const name of ['', '..', 'a'.repeat(256), 'a\u0000.pdf'])
      expect(() => displayFilename(name)).toThrow();
  });
  it('validates all upload resource limits', () => {
    for (const key of [
      'UPLOAD_MAX_BYTES',
      'UPLOAD_MAX_PAGES',
      'UPLOAD_MAX_PIXELS',
      'UPLOAD_TIMEOUT_MS',
      'UPLOAD_INSPECTION_TIMEOUT_MS',
      'UPLOAD_CONCURRENCY',
    ])
      for (const value of ['0', '-1', '1.5', '99999999999'])
        expect(() =>
          validateTestEnvironment({
            DATABASE_URL: 'postgresql://localhost/test',
            [key]: value,
          }),
        ).toThrow(key);
  });
});
