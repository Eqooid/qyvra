import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { SessionLifecycleService } from '../src/modules/auth/session-lifecycle.service';
import { databaseStub } from './database.stub';

describe('refresh and logout HTTP contracts', () => {
  let app: INestApplication;
  let server: Server;
  const lifecycle = { refresh: jest.fn(), logout: jest.fn() };
  const token = randomBytes(32).toString('base64url');
  const origin = 'https://frontend.example.invalid';
  const logs: string[] = [];
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost/test',
      CORS_ORIGINS: origin,
      COOKIE_DOMAIN: 'example.invalid',
      COOKIE_PATH: '/api/v1',
      COOKIE_SAME_SITE: 'none',
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue(databaseStub())
      .overrideProvider(SessionLifecycleService)
      .useValue(lifecycle)
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    logs.length = 0;
  });
  afterAll(async () => {
    await app?.close();
  });
  const call = (path: string) =>
    request(server)
      .post(`/api/v1/auth/${path}`)
      .set('X-CSRF-Protection', '1')
      .set('Origin', origin);
  const assertCleared = (response: request.Response) => {
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.length).toBe(2);
    for (const [index, cookie] of cookies.entries()) {
      const attributes = cookie.split('; ').slice(1);
      expect(attributes).toEqual(
        expect.arrayContaining([
          'HttpOnly',
          'Secure',
          'SameSite=None',
          'Domain=example.invalid',
          `Path=${index === 0 ? '/api/v1' : '/api/v1/auth'}`,
        ]),
      );
      expect(attributes.some((value) => value.startsWith('Max-Age='))).toBe(
        false,
      );
      const expires =
        attributes.find((value) => value.startsWith('Expires='))?.slice(8) ??
        '';
      expect(new Date(expires).getTime()).toBeLessThan(Date.now());
      expect(cookie.split(';')[0].endsWith('=')).toBe(true);
    }
  };
  it('rotates cookies without returning or logging token values', async () => {
    const next = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60000);
    lifecycle.refresh.mockResolvedValue({
      token: next,
      refreshToken: token,
      expiresAt,
      refreshExpiresAt: new Date(Date.now() + 120000),
    });
    const response = await call('refresh')
      .set('Cookie', `document_tracker_refresh=${token}`)
      .expect(200);
    expect(response.body).toEqual({
      data: { expiresAt: expiresAt.toISOString() },
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    expect((response.headers['set-cookie'] as unknown as string[]).length).toBe(
      2,
    );
    expect(logs.join('').includes(token) || logs.join('').includes(next)).toBe(
      false,
    );
  });
  it('clears cookies on invalid refresh with the standard unauthorized envelope', async () => {
    lifecycle.refresh.mockResolvedValue(null);
    const response = await call('refresh')
      .set('Cookie', `document_tracker_refresh=${token}`)
      .expect(401);
    expect(response.body).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
        details: {},
        traceId: response.headers['x-correlation-id'] as string,
      },
    });
    assertCleared(response);
  });
  it.each(['refresh', 'logout'])(
    'requires CSRF protection for %s before database access',
    async (path) => {
      await request(server).post(`/api/v1/auth/${path}`).expect(403);
      await call(path)
        .set('Origin', 'https://untrusted.example.invalid')
        .expect(403);
      expect(lifecycle.refresh).not.toHaveBeenCalled();
      expect(lifecycle.logout).not.toHaveBeenCalled();
    },
  );
  it('clears matching cookies and uses an idempotent success envelope for logout', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await call('logout').expect(200);
      expect(response.body).toEqual({
        data: { loggedOut: true },
        meta: { requestId: response.headers['x-correlation-id'] as string },
      });
      assertCleared(response);
    }
  });
  it('rejects body tokens and user IDs', async () => {
    await call('refresh').send({ refreshToken: token }).expect(400);
    await call('logout').query({ userId: 'untrusted' }).expect(400);
    expect(lifecycle.refresh).not.toHaveBeenCalled();
    expect(lifecycle.logout).not.toHaveBeenCalled();
  });
  it('documents refresh-cookie authentication and idempotent logout', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const document = response.body as {
      paths: Record<
        string,
        { post: { security?: unknown; responses: Record<string, unknown> } }
      >;
    };
    expect(document.paths['/api/v1/auth/refresh'].post.security).toEqual([
      { refresh: [] },
    ]);
    expect(
      document.paths['/api/v1/auth/logout'].post.responses['200'],
    ).toBeDefined();
  });
});
