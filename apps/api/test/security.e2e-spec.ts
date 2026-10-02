import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { LOG_SINK } from '../src/common/structured-logger';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { configureApplication } from '../src/configure-application';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { PasswordService } from '../src/modules/auth/password.service';
import { databaseStub } from './database.stub';

describe('HTTP security boundaries', () => {
  it('password changes share the login budget before authentication or Argon2 work', async () => {
    await start({ AUTH_LOGIN_RATE_LIMIT: '1' });
    await request(server).post('/api/v1/auth/login').send({}).expect(400);
    const result = await request(server)
      .patch('/api/v1/me/password')
      .send({})
      .expect(429);
    expect(Number(result.headers['retry-after'])).toBeGreaterThan(0);
    expect(passwords.verify).not.toHaveBeenCalled();
  });
  it('exposes the authentication retry delay to an allowed credentialed browser', async () => {
    await start({ AUTH_LOGIN_RATE_LIMIT: '1' });
    await request(server).post('/api/v1/auth/login').send({}).expect(400);
    const result = await request(server)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://frontend.example')
      .send({})
      .expect(429);
    expect(result.headers['access-control-allow-origin']).toBe(
      'https://frontend.example',
    );
    expect(result.headers['access-control-allow-credentials']).toBe('true');
    expect(
      result.headers['access-control-expose-headers']
        .toLowerCase()
        .split(',')
        .map((header: string) => header.trim()),
    ).toContain('retry-after');
    expect(Number(result.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('documents implemented routes and shared error envelopes without planned business endpoints', async () => {
    await start();
    const result = await request(server).get('/api/v1/docs-json').expect(200);
    expect(result.body.info.title).toBe('QYVRA API');
    expect(result.body.paths['/api/v1'].get.responses['200']).toBeDefined();
    expect(
      result.body.paths['/api/v1/auth/login'].post.responses['429'].content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/ErrorEnvelope');
    expect(
      result.body.paths['/api/v1/me/sessions/{sessionId}'].delete.responses[
        '403'
      ],
    ).toBeDefined();
    expect(result.body.paths['/api/v1/documents'].get).toBeDefined();
    expect(result.body.paths['/api/v1/documents'].post).toBeDefined();
    expect(result.body.paths['/api/v1/me/password'].patch.security).toEqual([
      { session: [] },
    ]);
  });
  let app: INestApplication;
  let server: Server;
  const logs: string[] = [];
  const passwords = { hash: jest.fn(), verify: jest.fn() };
  async function start(extra: Record<string, string> = {}) {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/security_test',
      AUTH_REGISTER_RATE_LIMIT: '2',
      AUTH_LOGIN_RATE_LIMIT: '2',
      AUTH_REFRESH_RATE_LIMIT: '2',
      HTTP_BODY_LIMIT_BYTES: '1024',
      CORS_ORIGINS: 'https://frontend.example',
      CORS_CREDENTIALS: 'true',
      ...extra,
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue(databaseStub())
      .overrideProvider(PasswordService)
      .useValue(passwords)
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  }
  beforeEach(() => {
    logs.length = 0;
    jest.clearAllMocks();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it.each(['register', 'login', 'refresh'])(
    'limits %s before validation, hashing and database work',
    async (endpoint) => {
      await start();
      for (let i = 0; i < 2; i++)
        await request(server).post(`/api/v1/auth/${endpoint}`).send({});
      const result = await request(server)
        .post(`/API/v1/auth/${endpoint}/?email=different`)
        .set('X-Forwarded-For', '192.0.2.123')
        .send({ password: 'private-test-secret' })
        .expect(429);
      expect(result.body).toEqual({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too Many Requests',
          details: {},
          traceId: result.headers['x-request-id'],
        },
      });
      expect(Number(result.headers['retry-after'])).toBeGreaterThan(0);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(passwords.hash).not.toHaveBeenCalled();
      expect(passwords.verify).not.toHaveBeenCalled();
      expect(logs.join('')).not.toContain('private-test-secret');
      await request(server).get('/api/v1/health/live').expect(200);
    },
  );
  it('enforces a combined global budget and resets after the window', async () => {
    await start({ AUTH_GLOBAL_RATE_LIMIT: '2', AUTH_RATE_WINDOW_SECONDS: '1' });
    await request(server).post('/api/v1/auth/register').send({}).expect(400);
    await request(server).post('/api/v1/auth/login').send({}).expect(400);
    await request(server).post('/api/v1/auth/refresh').send({}).expect(429);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 2000);
    await request(server).post('/api/v1/auth/login').send({}).expect(400);
  });
  it.each(['development', 'production'])(
    'applies safe headers in %s, including errors and Swagger',
    async (NODE_ENV) => {
      await start({ NODE_ENV });
      for (const path of ['/api/v1', '/api/v1/auth/me', '/api/v1/docs/']) {
        const result = await request(server).get(path);
        expect(result.headers['x-content-type-options']).toBe('nosniff');
        expect(result.headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(result.headers['referrer-policy']).toBe('no-referrer');
        expect(result.headers['x-powered-by']).toBeUndefined();
        expect(result.headers['content-security-policy']).toContain(
          "default-src 'self'",
        );
        expect(Boolean(result.headers['strict-transport-security'])).toBe(
          NODE_ENV === 'production',
        );
        expect(
          String(result.headers['content-security-policy']).includes(
            'upgrade-insecure-requests',
          ),
        ).toBe(NODE_ENV === 'production');
      }
    },
  );
  it('bounds bodies and sanitizes malformed JSON and unsupported encodings', async () => {
    await start();
    const result = await request(server)
      .post('/api/v1/auth/login')
      .send({ password: 'x'.repeat(2048) })
      .expect(413);
    expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    await request(server)
      .post('/api/v1/auth/register')
      .type('json')
      .send('{"password":"private-invalid-json"')
      .expect(400);
    await request(server)
      .post('/api/v1/other')
      .type('text')
      .send('private-text')
      .expect(415);
    await request(server)
      .post('/api/v1/other')
      .set('Content-Encoding', 'gzip')
      .type('json')
      .send('{}')
      .expect(415);
    expect(logs.join('')).not.toContain('private-');
  });
  it('bounds chunked JSON without a Content-Length header', async () => {
    await start();
    await app.listen(0, '127.0.0.1');
    const address = server.address() as AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/api/v1/auth/login',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (incoming) => {
          incoming.resume();
          incoming.on('end', () => resolve(incoming.statusCode));
        },
      );
      outgoing.on('error', reject);
      outgoing.write('{"password":"');
      outgoing.end('x'.repeat(2048) + '"}');
    });
    expect(status).toBe(413);
  });
  it('allows trusted credentialed preflight without spending the request budget', async () => {
    await start({ AUTH_GLOBAL_RATE_LIMIT: '1' });
    await request(server)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://frontend.example')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204)
      .expect('Access-Control-Allow-Credentials', 'true');
    await request(server).post('/api/v1/auth/login').send({}).expect(400);
    const denied = await request(server)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://untrusted.example')
      .send({})
      .expect(429);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
