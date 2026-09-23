import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { STORAGE, Storage } from '@brainless/storage';
import { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PrismaService } from '../../database/prisma.service';
import { StructuredLogger } from '../../common/structured-logger';
import { attachmentDisposition } from './download-filename';

/** @description Authorizes current-version downloads before storage access and owns the entire stream lifecycle. */
@Injectable()
export class DownloadService {
  constructor(
    private readonly database: PrismaService,
    @Inject(STORAGE) private readonly storage: Storage,
    private readonly logger: StructuredLogger,
  ) {}

  /** @description Selects the highest immutable version; never falls back to an older object. */
  async send(
    userId: string,
    documentId: string,
    response: Response,
  ): Promise<void> {
    const abort = new AbortController();
    let source: Readable | undefined;
    const disconnect = () => {
      if (!response.writableFinished) {
        abort.abort();
        source?.destroy();
      }
    };
    response.once('close', disconnect);
    try {
      const document = await this.database.client.document.findFirst({
        where: {
          id: documentId,
          userId,
          deletedAt: null,
          status: { not: 'DELETING' },
        },
        select: {
          versions: {
            orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
            take: 2,
            select: {
              versionNumber: true,
              storageKey: true,
              originalFilename: true,
              mimeType: true,
              fileSize: true,
            },
          },
        },
      });
      if (!document) throw new NotFoundException();
      const version = document.versions[0];
      if (
        !version ||
        document.versions[1]?.versionNumber === version.versionNumber
      )
        throw new ConflictException('Current version unavailable');
      if (
        !version.storageKey ||
        !['application/pdf', 'image/jpeg', 'image/png'].includes(
          version.mimeType,
        ) ||
        !Number.isSafeInteger(version.fileSize) ||
        version.fileSize <= 0
      )
        throw new ServiceUnavailableException();
      if (response.destroyed) return;
      // Metadata is internal consistency evidence only; no provider fields become response headers.
      const metadata = await this.storage.metadata(version.storageKey);
      if (metadata.size !== version.fileSize)
        throw new ServiceUnavailableException();
      source = await this.storage.open(version.storageKey);
      if (abort.signal.aborted || response.destroyed) {
        source.destroy();
        return;
      }
      const iterator = source[Symbol.asyncIterator]();
      // Await the first read before committing binary headers, allowing safe JSON errors on early failures.
      const first = await iterator.next();
      if (
        first.done ||
        !Buffer.isBuffer(first.value) ||
        first.value.length > version.fileSize
      )
        throw new ServiceUnavailableException();
      const initial: Buffer = first.value;
      const body = Readable.from(
        (async function* () {
          let bytes = initial.length;
          yield initial;
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            if (!Buffer.isBuffer(next.value))
              throw new Error('Invalid download stream');
            bytes += next.value.length;
            if (bytes > version.fileSize)
              throw new Error('Download size mismatch');
            yield next.value;
          }
          if (bytes !== version.fileSize)
            throw new Error('Download size mismatch');
        })(),
        { objectMode: false, highWaterMark: 65536 },
      );
      if (abort.signal.aborted) {
        body.destroy();
        return;
      }
      response.setHeader('Content-Type', version.mimeType);
      response.setHeader('Content-Length', version.fileSize);
      response.setHeader(
        'Content-Disposition',
        attachmentDisposition(version.originalFilename),
      );
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Accept-Ranges', 'none');
      response.flushHeaders();
      await pipeline(body, response, { signal: abort.signal });
      this.logger.event('info', 'download.completed', {
        documentId,
        bytes: version.fileSize,
      });
    } catch (error) {
      if (abort.signal.aborted || response.destroyed || response.headersSent) {
        this.logger.event('warn', 'download.interrupted', { documentId });
        response.destroy();
        return;
      }
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      )
        throw error;
      this.logger.event('error', 'download.unavailable', { documentId });
      throw new ServiceUnavailableException();
    } finally {
      source?.destroy();
      response.off('close', disconnect);
    }
  }
}
