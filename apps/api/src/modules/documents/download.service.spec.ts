import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Storage } from '@brainless/storage';
import { Readable, Writable } from 'node:stream';
import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { DownloadService } from './download.service';
import { attachmentDisposition } from './download-filename';
import { PrismaService } from '../../database/prisma.service';
import { StructuredLogger } from '../../common/structured-logger';

class Sink extends Writable {
  headers: Record<string, string | number> = {};
  headersSent = false;
  bytes = 0;
  largest = 0;
  constructor(private readonly interrupt = false) {
    super({ highWaterMark: 65536 });
  }
  setHeader(name: string, value: string | number) {
    this.headers[name] = value;
  }
  flushHeaders() {
    this.headersSent = true;
  }
  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.bytes += chunk.length;
    this.largest = Math.max(this.largest, chunk.length);
    if (this.interrupt) this.destroy();
    setImmediate(callback);
  }
}
describe('Secure download service', () => {
  const userId = randomUUID(),
    documentId = randomUUID();
  const version = {
    versionNumber: 1,
    storageKey: 'private/key',
    originalFilename: 'original.pdf',
    mimeType: 'application/pdf',
    fileSize: 4,
  };
  const findFirst = jest.fn(),
    open = jest.fn(),
    metadata = jest.fn(),
    event = jest.fn();
  const service = new DownloadService(
    { client: { document: { findFirst } } } as unknown as PrismaService,
    { open, metadata } as unknown as Storage,
    { event } as unknown as StructuredLogger,
  );
  const send = (sink = new Sink()) =>
    service.send(userId, documentId, sink as unknown as Response);
  beforeEach(() => {
    jest.resetAllMocks();
    findFirst.mockResolvedValue({ versions: [version] });
    open.mockImplementation(async () => Readable.from([Buffer.from('file')]));
    metadata.mockResolvedValue({ size: 4 });
  });
  it('filters ownership/visibility and deterministically selects highest version before opening storage', async () => {
    const sink = new Sink();
    await send(sink);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: documentId,
          userId,
          deletedAt: null,
          status: { not: 'DELETING' },
        },
        select: {
          versions: expect.objectContaining({
            orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
            take: 2,
          }),
        },
      }),
    );
    expect(sink.headers).toMatchObject({
      'Content-Type': 'application/pdf',
      'Content-Length': 4,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'none',
    });
    expect(sink.bytes).toBe(4);
    expect(event).toHaveBeenCalledWith('info', 'download.completed', {
      documentId,
      bytes: 4,
    });
  });
  it('never opens storage for unavailable documents', async () => {
    findFirst.mockResolvedValue(null);
    await expect(send()).rejects.toBeInstanceOf(NotFoundException);
    expect(open).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
  });
  it.each([{ versions: [] }, { versions: [version, version] }])(
    'rejects absent or ambiguous versions without storage access: %j',
    async ({ versions }) => {
      findFirst.mockResolvedValue({ versions });
      await expect(send()).rejects.toBeInstanceOf(ConflictException);
      expect(open).not.toHaveBeenCalled();
    },
  );
  it.each([{ storageKey: '' }, { mimeType: 'text/html' }, { fileSize: -1 }])(
    'rejects inconsistent stored metadata: %j',
    async (override) => {
      findFirst.mockResolvedValue({ versions: [{ ...version, ...override }] });
      await expect(send()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(open).not.toHaveBeenCalled();
    },
  );
  it('maps object absence and provider details to unavailable before headers', async () => {
    metadata.mockRejectedValue(new Error('C:\\private\\secret'));
    const sink = new Sink();
    await expect(send(sink)).rejects.toThrow('Service Unavailable');
    expect(sink.headersSent).toBe(false);
    expect(JSON.stringify(event.mock.calls)).not.toContain('private');
  });
  it('rejects object size mismatch without opening the object', async () => {
    metadata.mockResolvedValue({ size: 1 });
    await expect(send()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(open).not.toHaveBeenCalled();
  });
  it('maps an initial read error before committing headers and closes the source', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('/private/path'));
      },
    });
    open.mockResolvedValue(source);
    const sink = new Sink();
    await expect(send(sink)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(sink.headersSent).toBe(false);
    expect(source.destroyed).toBe(true);
  });
  it('terminates a late failed read without success logging or a JSON response', async () => {
    const source = Readable.from(
      (async function* () {
        yield Buffer.from('fi');
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error('private read error');
      })(),
      { objectMode: false },
    );
    open.mockResolvedValue(source);
    const sink = new Sink();
    await send(sink);
    expect(sink.destroyed).toBe(true);
    expect(
      event.mock.calls.some((call) => call[1] === 'download.completed'),
    ).toBe(false);
    expect(event).toHaveBeenCalledWith('warn', 'download.interrupted', {
      documentId,
    });
  });
  it('streams 32 MiB with bounded chunks and backpressure', async () => {
    const block = Buffer.alloc(65536, 65);
    const count = 512;
    findFirst.mockResolvedValue({
      versions: [{ ...version, fileSize: block.length * count }],
    });
    metadata.mockResolvedValue({ size: block.length * count });
    let produced = 0;
    const sink = new Sink();
    open.mockResolvedValue(
      Readable.from(
        (async function* () {
          for (let i = 0; i < count; i++) {
            produced++;
            expect(produced * block.length - sink.bytes).toBeLessThanOrEqual(
              4 * block.length,
            );
            yield block;
          }
        })(),
        { objectMode: false, highWaterMark: 65536 },
      ),
    );
    await send(sink);
    expect(sink.bytes).toBe(33554432);
    expect(sink.largest).toBeLessThanOrEqual(131072);
  });
  it('closes the source on client disconnect', async () => {
    const source = Readable.from(
      (async function* () {
        for (let i = 0; i < 100; i++) {
          yield Buffer.alloc(65536);
          await new Promise((resolve) => setImmediate(resolve));
        }
      })(),
      { objectMode: false },
    );
    findFirst.mockResolvedValue({
      versions: [{ ...version, fileSize: 6553600 }],
    });
    metadata.mockResolvedValue({ size: 6553600 });
    open.mockResolvedValue(source);
    await send(new Sink(true));
    expect(source.destroyed).toBe(true);
    expect(
      event.mock.calls.some((call) => call[1] === 'download.completed'),
    ).toBe(false);
  });
  it('encodes Unicode, strips header injection/path fragments and supplies a fallback', () => {
    expect(attachmentDisposition('résumé.pdf')).toContain(
      "filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    );
    const malicious = attachmentDisposition('../../bad"\r\nX-Evil: yes.pdf');
    expect(malicious).not.toMatch(/[\r\n]/);
    expect(malicious).not.toContain('../');
    expect(malicious).toContain('attachment;');
    expect(attachmentDisposition('')).toContain('filename="document"');
    expect(() => attachmentDisposition('\ud800.pdf')).not.toThrow();
  });
});
