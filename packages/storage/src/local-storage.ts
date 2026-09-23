import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  Storage,
  StoredObject,
  StorageError,
  StorageErrorCode,
} from './storage';
import { validateStorageKey } from './storage-key';

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/** @description Validates an absolute dedicated root, without returning it in errors. Does not access disk. */
export function validateLocalStorageRoot(value: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    value !== value.trim() ||
    /[\u0000-\u001f<>]/.test(value) ||
    value.startsWith('\\\\') ||
    value.split(/[\\/]/).some((part) => part === '..') ||
    resolve(value) === parse(resolve(value)).root
  )
    throw new StorageError('UNAVAILABLE');
  return resolve(value);
}

/** @author Cristono Wijaya
 * @description Private local adapter. Storage directories must be writable only by trusted storage processes.
 * @tags Storage
 */
export class LocalFileStorage implements Storage {
  readonly #root: string;
  constructor(root: string) {
    this.#root = validateLocalStorageRoot(root);
  }

  /** @description Rejects symlinks at every existing ancestor; creates missing directories individually with private permissions. */
  private async directory(path: string, create: boolean): Promise<void> {
    const root = parse(path).root;
    let current = root;
    for (const segment of path.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (create) {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
        }
      }
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new StorageError('UNAVAILABLE');
    }
  }

  private path(key: string): string {
    const path = resolve(this.#root, validateStorageKey(key));
    const child = relative(this.#root, path);
    if (
      !child ||
      child.startsWith(`..${sep}`) ||
      child === '..' ||
      isAbsolute(child)
    )
      throw new StorageError('INVALID_KEY');
    return path;
  }

  /** @description Opens only regular non-symlink files. Inode comparison also detects replacement during open. */
  private async file(path: string): Promise<FileHandle> {
    await this.directory(dirname(path), false);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink())
      throw new StorageError('UNAVAILABLE');
    const handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const after = await handle.stat();
      if (
        !after.isFile() ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      )
        throw new StorageError('UNAVAILABLE');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async safe<T>(
    code: StorageErrorCode,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (hasCode(error, 'ENOENT')) throw new StorageError('NOT_FOUND');
      throw new StorageError(code);
    }
  }

  /** @description Streams into a private temporary file, then uses atomic hard-link publication to prevent concurrent overwrite. */
  async save(key: string, source: Readable): Promise<StoredObject> {
    // Observe failures while directory preparation is in progress; pipeline later propagates source.errored.
    let inputFailed = false;
    const observe = () => {
      inputFailed = true;
    };
    source.on('error', observe);
    try {
      return await this.safe('WRITE_FAILED', async () => {
        const target = this.path(key);
        try {
          await this.directory(dirname(target), true);
        } catch {
          throw new StorageError('UNAVAILABLE');
        }
        const temporary = join(dirname(target), `.pending-${randomUUID()}`);
        let created = false;
        let result: StoredObject;
        try {
          if (inputFailed) throw new StorageError('WRITE_FAILED');
          const handle = await open(temporary, 'wx', 0o600);
          created = true;
          await pipeline(source, handle.createWriteStream());
          const stat = await lstat(temporary);
          result = { key, size: stat.size, lastModified: stat.mtime };
          await this.directory(dirname(target), false);
          // rename() would replace an existing object. link() publishes atomically with EEXIST instead.
          try {
            await link(temporary, target);
          } catch (error) {
            if (hasCode(error, 'EEXIST'))
              throw new StorageError('ALREADY_EXISTS');
            throw new StorageError('WRITE_FAILED');
          }
        } catch (error) {
          if (error instanceof StorageError) throw error;
          throw new StorageError('WRITE_FAILED');
        } finally {
          if (created) {
            try {
              await unlink(temporary);
            } catch {
              throw new StorageError('WRITE_FAILED');
            }
          }
        }
        return result;
      });
    } finally {
      source.destroy();
    }
  }

  /** @description Pipes through a bounded stream to sanitize late read errors without losing backpressure. */
  async open(key: string): Promise<Readable> {
    return this.safe('READ_FAILED', async () => {
      const handle = await this.file(this.path(key));
      const source = handle.createReadStream();
      const output = new PassThrough({ highWaterMark: 64 * 1024 });
      source.on('error', () => output.destroy(new StorageError('READ_FAILED')));
      output.on('close', () => source.destroy());
      source.pipe(output);
      return output;
    });
  }

  async metadata(key: string): Promise<StoredObject> {
    return this.safe('READ_FAILED', async () => {
      const handle = await this.file(this.path(key));
      try {
        const stat = await handle.stat();
        return { key, size: stat.size, lastModified: stat.mtime };
      } finally {
        await handle.close();
      }
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.metadata(key);
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.code === 'NOT_FOUND')
        return false;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      return await this.safe('DELETE_FAILED', async () => {
        const path = this.path(key);
        const handle = await this.file(path);
        await handle.close();
        await unlink(path);
        return true;
      });
    } catch (error) {
      if (error instanceof StorageError && error.code === 'NOT_FOUND')
        return false;
      throw error;
    }
  }
}
