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
import { UploadService } from '../src/modules/documents/upload.service';
import { databaseStub } from './database.stub';
import { pdfFixture } from './upload.fixture';

// Real HTTP middleware, authentication and controller; full storage/SQL workflow is in upload.integration-spec.
describe('Upload HTTP security boundary', () => {
  let app: INestApplication, server: Server;
  const userId = randomUUID();
  const cookie = `document_tracker_session=${randomBytes(32).toString('base64url')}`;
  const authSession = { findUnique: jest.fn(), updateMany: jest.fn() };
  const service = { create: jest.fn() };
  const begin = () =>
    request(server)
      .post('/api/v1/documents')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1');
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
      .overrideProvider(UploadService)
      .useValue(service)
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
      user: {
        id: userId,
        email: 'owner@example.invalid',
        displayName: null,
        locale: 'en',
        timezone: 'UTC',
        deletedAt: null,
      },
    });
    service.create.mockImplementation(
      async (_owner, _key, incoming: NodeJS.ReadableStream) => {
        // Drain the fixture body as a real upload service would.
        for await (const chunk of incoming) void chunk;
        return {
          id: randomUUID(),
          status: 'UPLOADED',
          version: { versionNumber: 1, extractionStatus: 'PENDING' },
        };
      },
    );
  });
  afterAll(async () => app.close());
  it('uses the authenticated owner and standard envelope for multipart creation', async () => {
    const key = randomUUID();
    const result = await begin()
      .set('Idempotency-Key', key.toUpperCase())
      .set('userId', randomUUID())
      .field('title', 'Owned')
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(userId, key, expect.anything());
    expect(result.body.meta.requestId).toBe(result.headers['x-request-id']);
    expect(result.body.data.status).toBe('UPLOADED');
  });
  it.each(['missing', 'expired', 'revoked'] as const)(
    'rejects %s sessions before upload work',
    async (state) => {
      if (state === 'missing') authSession.findUnique.mockResolvedValue(null);
      else {
        const value = await authSession.findUnique();
        authSession.findUnique.mockResolvedValue({
          ...value,
          ...(state === 'expired'
            ? { expiresAt: new Date(0) }
            : { revokedAt: new Date() }),
        });
      }
      await begin()
        .set('Idempotency-Key', randomUUID())
        .attach('file', pdfFixture(), 'a.pdf')
        .expect(401);
      expect(service.create).not.toHaveBeenCalled();
    },
  );
  it('rejects absent/invalid idempotency keys and untrusted origins', async () => {
    await begin().attach('file', pdfFixture(), 'a.pdf').expect(400);
    await begin()
      .set('Idempotency-Key', 'invalid')
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(400);
    await begin()
      .set('Idempotency-Key', randomUUID())
      .set('Origin', 'https://untrusted.example')
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(403);
    expect(service.create).not.toHaveBeenCalled();
  });
  it('rejects ownership query injection and compressed multipart', async () => {
    await begin()
      .query({ userId: randomUUID() })
      .set('Idempotency-Key', randomUUID())
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(400);
    await begin()
      .set('Content-Encoding', 'gzip')
      .set('Idempotency-Key', randomUUID())
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(415);
    expect(service.create).not.toHaveBeenCalled();
  });
});
