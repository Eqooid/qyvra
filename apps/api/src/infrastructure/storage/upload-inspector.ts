import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Storage, StorageError } from '@qyvra/storage';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { imageReader as sharp } from './image-reader';
import { ConfigurationService } from '../../configuration/configuration.module';

/** @author Cristono Wijaya
 * @description Inspects private staged objects without buffering the file or extracting document content.
 * @tags Upload Validation
 */
@Injectable()
export class UploadInspector {
  constructor(private readonly configuration: ConfigurationService) {}
  private command(args: string[]): Promise<{ code: number; text: string }> {
    return new Promise((done, reject) => {
      execFile(
        this.configuration.upload.qpdfPath,
        args,
        {
          timeout: this.configuration.upload.inspectionTimeoutMs,
          maxBuffer: 65536,
          windowsHide: true,
          killSignal: 'SIGKILL',
        },
        (error, stdout) => {
          if (error && (error.code === 'ENOENT' || error.code === 'EACCES'))
            return reject(
              new ServiceUnavailableException('File inspection unavailable'),
            );
          if (error && (error.killed || typeof error.code !== 'number'))
            return reject(new BadRequestException('File inspection failed'));
          done({ code: error ? Number(error.code) : 0, text: stdout });
        },
      );
    });
  }
  async inspect(
    storage: Storage,
    key: string,
    mime: string,
  ): Promise<number | null> {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'qyvra-inspect-'));
      const file = join(directory, 'input');
      await pipeline(
        await storage.open(key),
        createWriteStream(file, { flags: 'wx', mode: 0o600 }),
      );
      if (mime === 'application/pdf') {
        const encrypted = await this.command(['--is-encrypted', file]);
        if (encrypted.code === 0)
          throw new BadRequestException('Encrypted PDFs are not supported');
        const check = await this.command([
          '--suppress-recovery',
          '--check',
          '--decode-level=none',
          file,
        ]);
        if (check.code !== 0) throw new BadRequestException('Malformed PDF');
        const pages = await this.command([
          '--suppress-recovery',
          '--show-npages',
          file,
        ]);
        const count = Number(pages.text.trim());
        if (
          pages.code !== 0 ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > this.configuration.upload.maxPages
        )
          throw new BadRequestException('Invalid PDF page count');
        return count;
      }
      const meta = await sharp(file, {
        failOn: 'warning',
        limitInputPixels: this.configuration.upload.maxPixels,
      }).metadata();
      if (
        !meta.width ||
        !meta.height ||
        meta.width * meta.height > this.configuration.upload.maxPixels ||
        !['jpeg', 'png'].includes(meta.format ?? '')
      )
        throw new BadRequestException('Invalid image');
      const handle = await open(file, 'r');
      try {
        const stat = await handle.stat();
        const length = mime === 'image/png' ? 12 : 2;
        const tail = Buffer.alloc(length);
        if (stat.size < length)
          throw new BadRequestException('Empty or truncated file');
        await handle.read(tail, 0, length, stat.size - length);
        const expected =
          mime === 'image/png'
            ? Buffer.from('0000000049454e44ae426082', 'hex')
            : Buffer.from('ffd9', 'hex');
        if (!tail.equals(expected))
          throw new BadRequestException('Truncated image');
      } finally {
        await handle.close();
      }
      return null;
    } catch (error) {
      if (error instanceof StorageError)
        throw new ServiceUnavailableException('File inspection unavailable');
      if (
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      throw new BadRequestException('File inspection failed');
    } finally {
      if (directory) {
        if (
          dirname(resolve(directory)) !== resolve(tmpdir()) ||
          !basename(directory).startsWith('qyvra-inspect-')
        )
          throw new ServiceUnavailableException('Inspection cleanup failed');
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          throw new ServiceUnavailableException('Inspection cleanup failed');
        }
      }
    }
  }
}
