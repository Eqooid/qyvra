import {
  BadRequestException,
  PayloadTooLargeException,
  RequestTimeoutException,
  UnsupportedMediaTypeException,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import * as Busboy from 'busboy';
import { Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { Storage, originalDocumentKey } from '@brainless/storage';
import { UpdateDocumentDto } from './documents.dto';
import { ApiConfiguration } from '../../configuration/settings';

export interface UploadedFile {
  key: string;
  filename: string;
  mime: string;
  size: number;
  checksum: string;
  dto: UpdateDocumentDto;
}

/** @description Normalizes only the display filename. Paths never become storage keys. */
export function displayFilename(raw: string): string {
  if (
    typeof raw !== 'string' ||
    raw.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(raw)
  )
    throw new BadRequestException('Invalid filename');
  const name = raw
    .normalize('NFKC')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.trim();
  if (!name || name.length > 255 || name === '.' || name === '..')
    throw new BadRequestException('Invalid filename');
  return name;
}

/** @description Streams multipart input after authentication, bounding file bytes, fields, total bytes and receive time. */
export async function receiveUpload(
  request: Request,
  storage: Storage,
  ids: { userId: string; documentId: string; versionId: string },
  policy: ApiConfiguration['upload'],
  onKey: (key: string) => void,
  fileOnly = false,
): Promise<UploadedFile> {
  if (!request.is('multipart/form-data'))
    throw new UnsupportedMediaTypeException('Expected multipart/form-data');
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      preservePath: true,
      defParamCharset: 'utf8',
      fileHwm: 65536,
      limits: {
        files: 1,
        fields: 9,
        parts: 11,
        fieldSize: 8192,
        fileSize: policy.maxBytes + 1,
      },
    });
  } catch {
    throw new BadRequestException('Invalid multipart body');
  }
  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let failure: Error | undefined;
  let fileWork: Promise<void> | undefined;
  let result: Omit<UploadedFile, 'dto'> | undefined;
  let current: Readable | undefined;
  let total = 0;
  const fail = (error: Error) => {
    failure ??= error;
    request.unpipe(limiter);
    limiter.unpipe(parser);
    current?.destroy(error);
    parser.destroy(error);
    request.resume();
  };
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > policy.maxBytes + 65536)
        callback(new PayloadTooLargeException());
      else callback(null, chunk);
    },
  });
  limiter.on('error', fail);
  const timeout = setTimeout(
    () => fail(new RequestTimeoutException('Upload timed out')),
    policy.timeoutMs,
  );
  const aborted = () => fail(new BadRequestException('Upload interrupted'));
  request.on('aborted', aborted);
  request.on('error', aborted);
  parser.on('filesLimit', () =>
    fail(new BadRequestException('Exactly one file is required')),
  );
  parser.on('fieldsLimit', () =>
    fail(new BadRequestException('Too many metadata fields')),
  );
  parser.on('partsLimit', () =>
    fail(new BadRequestException('Too many multipart parts')),
  );
  parser.on('field', (name, value, info) => {
    if (
      fileOnly ||
      info.valueTruncated ||
      name.length > 64 ||
      Object.prototype.hasOwnProperty.call(fields, name) ||
      ![
        'title',
        'description',
        'documentType',
        'issuer',
        'referenceNumber',
        'documentDate',
        'expirationDate',
        'categoryId',
        'tagIds',
      ].includes(name)
    )
      return fail(new BadRequestException('Invalid metadata fields'));
    fields[name] = value;
  });
  parser.on('file', (name, file, info) => {
    current = file;
    file.on('error', () => {
      /* File errors are propagated by fileWork and parser completion. */
    });
    file.on('limit', () => fail(new PayloadTooLargeException()));
    if (name !== 'file' || fileWork) {
      file.resume();
      fail(new BadRequestException('Exactly one file is required'));
      return;
    }
    fileWork = (async () => {
      const filename = displayFilename(info.filename);
      const iterator = file[Symbol.asyncIterator]();
      const initial: Buffer[] = [];
      let bytes = 0;
      while (bytes < 8) {
        const next = await iterator.next();
        if (next.done) break;
        const chunk = Buffer.from(next.value as Uint8Array);
        initial.push(chunk);
        bytes += chunk.length;
      }
      const head = Buffer.concat(initial).subarray(0, 8);
      if (!bytes) throw new BadRequestException('Empty file');
      const kind = head.subarray(0, 5).equals(Buffer.from('%PDF-'))
        ? ['pdf', 'application/pdf']
        : head.equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          ? ['png', 'image/png']
          : head[0] === 255 && head[1] === 216 && head[2] === 255
            ? ['jpg', 'image/jpeg']
            : undefined;
      const extension = filename.split('.').pop()?.toLowerCase();
      if (
        !kind ||
        info.mimeType !== kind[1] ||
        !(kind[0] === 'jpg' ? ['jpg', 'jpeg'] : [kind[0]]).includes(
          extension ?? '',
        )
      )
        throw new UnsupportedMediaTypeException(
          'File type mismatch or unsupported file',
        );
      const key = originalDocumentKey(
        ids.userId,
        ids.documentId,
        ids.versionId,
        kind[0],
      );
      onKey(key);
      let size = 0;
      const hash = createHash('sha256');
      const source = Readable.from(
        (async function* () {
          for (const chunk of initial) {
            size += chunk.length;
            hash.update(chunk);
            yield chunk;
          }
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            const chunk = Buffer.from(next.value as Uint8Array);
            size += chunk.length;
            if (size > policy.maxBytes) {
              failure = new PayloadTooLargeException();
              throw failure;
            }
            hash.update(chunk);
            yield chunk;
          }
          if (size > policy.maxBytes || file.truncated) {
            failure = new PayloadTooLargeException();
            throw failure;
          }
        })(),
        { objectMode: false, highWaterMark: 65536 },
      );
      await storage.save(key, source);
      result = {
        key,
        filename,
        mime: kind[1],
        size,
        checksum: hash.digest('hex'),
      };
    })().catch((error: unknown) => {
      fail(
        error instanceof Error
          ? error
          : new BadRequestException('Upload failed'),
      );
    });
  });
  const parsed = finished(parser, { cleanup: true }).catch(() => {
    failure ??= new BadRequestException('Incomplete multipart body');
  });
  request.pipe(limiter).pipe(parser);
  try {
    await parsed;
    await fileWork;
    if (failure) throw failure;
    if (!result) throw new BadRequestException('Exactly one file is required');
    // Version uploads reuse file validation but never accept logical document metadata.
    if (fileOnly) return { ...result, dto: {} };
    const values: Record<string, unknown> = { ...fields };
    if (fields.tagIds !== undefined) {
      try {
        values.tagIds = JSON.parse(fields.tagIds) as unknown;
      } catch {
        throw new BadRequestException('tagIds must be a JSON UUID array');
      }
    }
    const dto = (await new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }).transform(values, {
      type: 'body',
      metatype: UpdateDocumentDto,
    })) as UpdateDocumentDto;
    if (!dto.title) throw new BadRequestException('Title is required');
    if (
      dto.documentDate &&
      dto.expirationDate &&
      dto.expirationDate < dto.documentDate
    )
      throw new BadRequestException('Invalid date order');
    return { ...result, dto: { ...dto, title: dto.title } };
  } finally {
    clearTimeout(timeout);
    request.off('aborted', aborted);
    request.off('error', aborted);
    request.unpipe(limiter);
    limiter.destroy();
  }
}
