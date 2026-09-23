import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { databaseStub } from './database.stub';

describe('current-user HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  const token = randomBytes(32).toString('base64url');
  const authSession = {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
  };
  const profile = {
    id: '873f92ec-55bb-4d06-8ff6-bf3f26a819ef',
    email: 'person@example.invalid',
    displayName: 'Person',
    locale: 'en',
    timezone: 'UTC',
  };
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/test',
      COOKIE_NAME: 'custom_session',
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue({ ...databaseStub(), authSession })
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    authSession.findUnique.mockResolvedValue({
      id: 'session',
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastSeenAt: new Date(),
      user: { ...profile, deletedAt: null },
    });
  });
  afterAll(async () => {
    await app?.close();
  });
  it('returns only the authenticated public profile despite supplied userId values', async () => {
    const response = await request(server)
      .get('/api/v1/auth/me?userId=another-user')
      .set('Cookie', `custom_session=${token}`)
      .set('userId', 'another-user')
      .send({ userId: 'another-user' })
      .expect(200);
    expect(response.body).toEqual({
      data: profile,
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each(['missing', 'invalid', 'duplicate', 'refresh-only', 'bearer-only'])(
    'rejects %s credentials without querying PostgreSQL',
    async (kind) => {
      const call = request(server).get('/api/v1/auth/me?userId=untrusted');
      if (kind === 'invalid') call.set('Cookie', 'custom_session=invalid');
      if (kind === 'duplicate')
        call.set('Cookie', `custom_session=${token}; custom_session=${token}`);
      if (kind === 'refresh-only')
        call.set('Cookie', `document_tracker_refresh=${token}`);
      if (kind === 'bearer-only') call.set('Authorization', `Bearer ${token}`);
      const response = await call.expect(401);
      expect(response.body).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
          details: {},
          traceId: response.headers['x-correlation-id'] as string,
        },
      });
      expect(authSession.findUnique).not.toHaveBeenCalled();
    },
  );
  it('documents the configured cookie scheme only on the protected route', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const document = response.body as {
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<
        string,
        { get?: { security: unknown }; post?: { security?: unknown } }
      >;
    };
    expect(document.components.securitySchemes.session).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'custom_session',
    });
    expect(document.paths['/api/v1/auth/me'].get?.security).toEqual([
      { session: [] },
    ]);
    expect(document.paths['/api/v1/auth/login'].post?.security).toBeUndefined();
  });
});
