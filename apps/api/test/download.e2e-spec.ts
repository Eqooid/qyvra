import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { STORAGE, StorageError } from '@brainless/storage';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment } from './configuration.fixture';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { databaseStub } from './database.stub';

describe('Current document download HTTP contract', () => {
  let app: INestApplication, server: Server;
  const owner = randomUUID(),
    documentId = randomUUID();
  const cookie = `document_tracker_session=${randomBytes(32).toString('base64url')}`;
  const authSession = { findUnique: jest.fn(), updateMany: jest.fn() };
  const findFirst = jest.fn(),
    open = jest.fn(),
    metadata = jest.fn();
  const logs: string[] = [];
  const version = {
    versionNumber: 1,
    storageKey: 'private/server/key',
    originalFilename: 'résumé.pdf',
    mimeType: 'application/pdf',
    fileSize: 4,
  };
  const get = (id: string = documentId) =>
    request(server)
      .get(`/api/v1/documents/${id}/download`)
      .set('Cookie', cookie);
  beforeAll(async () => {
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/test',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue({ ...databaseStub(), authSession, document: { findFirst } })
      .overrideProvider(STORAGE)
      .useValue({ open, metadata })
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = module.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    logs.length = 0;
    authSession.findUnique.mockResolvedValue({
      id: randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastSeenAt: new Date(),
      user: { id: owner, deletedAt: null },
    });
    findFirst.mockResolvedValue({ versions: [version] });
    metadata.mockResolvedValue({ size: 4 });
    open.mockImplementation(async () => Readable.from([Buffer.from('file')]));
  });
  afterAll(async () => app.close());
  it('requires authentication before querying documents or storage', async () => {
    await request(server)
      .get(`/api/v1/documents/${documentId}/download`)
      .expect(401);
    expect(findFirst).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it('rejects invalid UUID and all query/body inputs', async () => {
    await get('bad').expect(400);
    for (const field of [
      'storageKey',
      'path',
      'userId',
      'versionId',
      'versionNumber',
    ])
      await get()
        .query({ [field]: 'untrusted' })
        .expect(400);
    await get().send({ userId: randomUUID() }).expect(400);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(['application/pdf', 'image/jpeg', 'image/png'])(
    'streams trusted %s without JSON wrapping or sensitive headers',
    async (mimeType) => {
      findFirst.mockResolvedValue({ versions: [{ ...version, mimeType }] });
      const correlation = randomUUID();
      const result = await get()
        .set('X-Correlation-Id', correlation)
        .set('Range', 'bytes=0-1')
        .expect(200);
      expect(result.headers['content-type']).toBe(mimeType);
      expect(result.headers['content-length']).toBe('4');
      expect(result.body).toEqual(Buffer.from('file'));
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      expect(result.headers['content-disposition']).toContain(
        "filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
      );
      expect(JSON.stringify(result.headers)).not.toMatch(
        /private\/server|storageKey/,
      );
      expect(
        logs.some(
          (line) =>
            line.includes('download.completed') && line.includes(correlation),
        ),
      ).toBe(true);
    },
  );
  it('sanitizes malicious filenames', async () => {
    findFirst.mockResolvedValue({
      versions: [
        { ...version, originalFilename: '..\\bad"\r\nX-Injected: yes.pdf' },
      ],
    });
    const result = await get().expect(200);
    expect(result.headers['x-injected']).toBeUndefined();
    expect(result.headers['content-disposition']).not.toMatch(/[\r\n]/);
  });
  it('returns standard not-found/conflict errors without touching storage', async () => {
    findFirst.mockResolvedValue(null);
    const missing = await get().expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    findFirst.mockResolvedValue({ versions: [] });
    await get().expect(409);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(['NOT_FOUND', 'UNAVAILABLE'] as const)(
    'maps storage %s to sanitized 503, not document 404',
    async (code) => {
      metadata.mockRejectedValue(new StorageError(code));
      const result = await get().expect(503);
      expect(result.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(result.headers['content-disposition']).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toMatch(
        /server\/key|storageKey|filesystem/,
      );
    },
  );
  it('maps first read failures before binary headers', async () => {
    open.mockResolvedValue(
      new Readable({
        read() {
          this.destroy(new Error('C:\\private\\upload'));
        },
      }),
    );
    const result = await get().expect(503);
    expect(result.headers['content-type']).toContain('application/json');
    expect(JSON.stringify(result.body)).not.toContain('private');
  });
  it('documents binary media and errors without exposing stored keys', async () => {
    const result = await request(server).get('/api/v1/docs-json').expect(200);
    const operation =
      result.body.paths['/api/v1/documents/{documentId}/download'].get;
    expect(
      operation.responses['200'].content['application/pdf'].schema.format,
    ).toBe('binary');
    expect(operation.responses['503']).toBeDefined();
    expect(operation.security).toEqual([{ session: [] }]);
  });
});
