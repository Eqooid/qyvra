import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment } from './configuration.fixture';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { PaginatedData } from '../src/common/paginated-data';
import { UploadService } from '../src/modules/documents/upload.service';
import { VersionsService } from '../src/modules/documents/versions.service';
import { databaseStub } from './database.stub';
import { pdfFixture } from './upload.fixture';

describe('Version endpoints HTTP boundary', () => {
  let app: INestApplication, server: Server;
  const owner = randomUUID(),
    documentId = randomUUID(),
    versionId = randomUUID();
  const cookie = `document_tracker_session=${randomBytes(32).toString('base64url')}`;
  const root = `/api/v1/documents/${documentId}/versions`;
  const authSession = { findUnique: jest.fn(), updateMany: jest.fn() };
  const versions = { list: jest.fn(), detail: jest.fn() },
    uploads = { create: jest.fn() };
  const view = {
    id: versionId,
    versionNumber: 2,
    originalFilename: 'fixture.pdf',
    mimeType: 'application/pdf',
    fileSize: 123,
    pageCount: 1,
    extractionStatus: 'PENDING',
    createdAt: new Date().toISOString(),
    isLatest: true,
  };
  const routes = [
    ['get', root],
    ['post', root],
    ['get', `${root}/${versionId}`],
  ] as const;
  beforeAll(async () => {
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/test',
      CORS_ORIGINS: 'https://frontend.example',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue({ ...databaseStub(), authSession })
      .overrideProvider(VersionsService)
      .useValue(versions)
      .overrideProvider(UploadService)
      .useValue(uploads)
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    authSession.findUnique.mockResolvedValue({
      id: randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastSeenAt: new Date(),
      user: { id: owner, email: 'owner@example.invalid', deletedAt: null },
    });
    versions.list.mockResolvedValue(new PaginatedData([view], null, false));
    versions.detail.mockResolvedValue(view);
    uploads.create.mockImplementation(
      async (_owner, _key, incoming: NodeJS.ReadableStream, id: string) => {
        for await (const chunk of incoming) void chunk;
        return { id, status: 'UPLOADED', version: view };
      },
    );
  });
  afterAll(async () => app.close());
  it.each(routes)('requires authentication for %s %s', async (method, path) => {
    await request(server)[method](path).expect(401);
    expect(versions.list).not.toHaveBeenCalled();
    expect(versions.detail).not.toHaveBeenCalled();
    expect(uploads.create).not.toHaveBeenCalled();
  });
  it('validates every UUID before invoking use cases', async () => {
    for (const path of ['/api/v1/documents/bad/versions', `${root}/bad`])
      await request(server).get(path).set('Cookie', cookie).expect(400);
    await request(server)
      .post('/api/v1/documents/not-a-uuid/versions')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .set('Idempotency-Key', randomUUID())
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(400);
    expect(versions.list).not.toHaveBeenCalled();
    expect(versions.detail).not.toHaveBeenCalled();
    expect(uploads.create).not.toHaveBeenCalled();
  });
  it('uses trusted owner, bounded pagination and standard envelopes', async () => {
    const result = await request(server)
      .get(root)
      .set('Cookie', cookie)
      .set('userId', randomUUID())
      .query({ limit: 2 })
      .expect(200);
    expect(versions.list).toHaveBeenCalledWith(
      owner,
      documentId,
      expect.objectContaining({ limit: 2, sort: '-versionNumber' }),
    );
    expect(result.body).toEqual({
      data: [view],
      meta: {
        requestId: result.headers['x-request-id'] as string,
        nextCursor: null,
        hasMore: false,
      },
    });
    await request(server)
      .get(`${root}/${versionId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(versions.detail).toHaveBeenCalledWith(owner, documentId, versionId);
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { cursor: 'bad' },
    { userId: randomUUID() },
    { versionNumber: 5 },
    { sort: 'storageKey' },
  ])('rejects unsupported history query %j', async (query) => {
    await request(server)
      .get(root)
      .set('Cookie', cookie)
      .query(query)
      .expect(400);
    expect(versions.list).not.toHaveBeenCalled();
  });
  it('rejects detail query input and read request bodies', async () => {
    await request(server)
      .get(`${root}/${versionId}`)
      .set('Cookie', cookie)
      .query({ storageKey: 'private' })
      .expect(400);
    await request(server)
      .get(root)
      .set('Cookie', cookie)
      .send({ userId: randomUUID() })
      .expect(400);
    expect(versions.detail).not.toHaveBeenCalled();
    expect(versions.list).not.toHaveBeenCalled();
  });
  it('requires CSRF, an allowed browser origin and a UUID idempotency key for append', async () => {
    await request(server)
      .post(root)
      .set('Cookie', cookie)
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(403);
    await request(server)
      .post(root)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(400);
    await request(server)
      .post(root)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .set('Origin', 'https://untrusted.example')
      .set('Idempotency-Key', randomUUID())
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(403);
    expect(uploads.create).not.toHaveBeenCalled();
  });
  it('invokes the shared upload pipeline with trusted owner and document scope', async () => {
    const key = randomUUID();
    const result = await request(server)
      .post(root)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .set('Idempotency-Key', key.toUpperCase())
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(201);
    expect(uploads.create).toHaveBeenCalledWith(
      owner,
      key,
      expect.anything(),
      documentId,
    );
    expect(result.body.data).toEqual({
      documentId,
      status: 'UPLOADED',
      version: view,
    });
  });
  it('documents all three endpoints and excludes unavailable chunks and historical download', async () => {
    const result = await request(server).get('/api/v1/docs-json').expect(200);
    const paths = result.body.paths;
    const collection = paths['/api/v1/documents/{documentId}/versions'];
    expect(collection.get).toBeDefined();
    expect(
      collection.post.requestBody.content['multipart/form-data'],
    ).toBeDefined();
    expect(collection.post.responses['409']).toBeDefined();
    expect(collection.post.responses['503']).toBeDefined();
    expect(
      paths['/api/v1/documents/{documentId}/versions/{versionId}'].get,
    ).toBeDefined();
    expect(
      paths['/api/v1/documents/{documentId}/versions/{versionId}/download'],
    ).toBeUndefined();
  });
});
