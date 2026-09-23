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
import {
  InvalidCredentials,
  LoginService,
} from '../src/modules/auth/login.service';
import { databaseStub } from './database.stub';

describe.each(['test', 'production'])('login HTTP in %s', (environment) => {
  let app: INestApplication;
  let server: Server;
  const login = { login: jest.fn() };
  const logs: string[] = [];
  const password = 'a sufficiently long password';
  const origin = 'https://frontend.example.invalid';
  const config = validateEnvironment({
    NODE_ENV: environment,
    DATABASE_URL: 'postgresql://localhost/test',
    CORS_ORIGINS: origin,
    ...(environment === 'production'
      ? {
          COOKIE_DOMAIN: 'example.invalid',
          COOKIE_PATH: '/api/v1',
          COOKIE_SAME_SITE: 'none',
        }
      : {}),
  });
  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue(databaseStub())
      .overrideProvider(LoginService)
      .useValue(login)
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    login.login.mockReset();
    logs.length = 0;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('sets two scoped HttpOnly cookies and returns only public data', async () => {
    const token = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60000);
    const refreshExpiresAt = new Date(Date.now() + 120000);
    const user = {
      id: 'ae4c1c59-b77b-4c23-a05f-a2492d7c7e12',
      email: 'person@example.invalid',
    };
    login.login.mockResolvedValue({
      user,
      token,
      refreshToken,
      expiresAt,
      refreshExpiresAt,
    });
    const response = await request(server)
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ email: ' Person@Example.Invalid ', password })
      .expect(200);
    expect(response.body).toEqual({
      data: { user, expiresAt: expiresAt.toISOString() },
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.length).toBe(2);
    for (const [index, cookie] of cookies.entries()) {
      // Assertions exclude token values, including when the test fails.
      const attributes = cookie.split('; ').slice(1);
      expect(attributes).toContain('HttpOnly');
      expect(attributes.includes('Secure')).toBe(environment === 'production');
      expect(attributes).toContain(
        `SameSite=${environment === 'production' ? 'None' : 'Lax'}`,
      );
      expect(attributes).toContain(
        `Path=${index === 0 ? config.cookie.path : config.cookie.refreshPath}`,
      );
      expect(attributes.includes('Domain=example.invalid')).toBe(
        environment === 'production',
      );
      const maxAge = Number(
        attributes.find((a) => a.startsWith('Max-Age='))?.split('=')[1],
      );
      expect(maxAge).toBeGreaterThan(index === 0 ? 55 : 115);
      expect(maxAge).toBeLessThanOrEqual(index === 0 ? 60 : 120);
      expect(attributes.some((a) => a.startsWith('Expires='))).toBe(true);
    }
    expect(
      logs.join('').includes(password) ||
        logs.join('').includes(token) ||
        logs.join('').includes(refreshToken),
    ).toBe(false);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns a generic 401 and no cookies', async () => {
    login.login.mockRejectedValue(new InvalidCredentials());
    const response = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'person@example.invalid', password })
      .expect(401);
    expect(response.body).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
        details: {},
        traceId: response.headers['x-correlation-id'] as string,
      },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  it.each([
    { email: 'invalid', password },
    { email: 'person@example.invalid', password: 5 },
    { email: 'person@example.invalid', password, userId: 'untrusted' },
  ])('rejects invalid DTO %#', async (body) => {
    await request(server).post('/api/v1/auth/login').send(body).expect(400);
    expect(login.login).not.toHaveBeenCalled();
  });
  it('rejects an untrusted Origin before verifying credentials', async () => {
    await request(server)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://untrusted.example.invalid')
      .send({ email: 'person@example.invalid', password })
      .expect(403);
    expect(login.login).not.toHaveBeenCalled();
  });
  it('documents login without token examples', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const document = response.body as {
      paths: Record<string, { post: { responses: Record<string, unknown> } }>;
    };
    expect(
      Object.keys(document.paths['/api/v1/auth/login'].post.responses),
    ).toEqual(expect.arrayContaining(['200', '401']));
  });
});
