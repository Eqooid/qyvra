import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';

describe('session authentication with PostgreSQL', () => {
  let app: INestApplication;
  let database: PrismaService;
  let server: Server;
  const ids: string[] = [];
  const logs: string[] = [];
  const digest = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const create = async () => {
    const user = await database.client.user.create({
      data: {
        email: `${randomUUID()}@example.invalid`,
        displayName: 'Test user',
      },
    });
    ids.push(user.id);
    const token = randomBytes(32).toString('base64url');
    const refresh = randomBytes(32).toString('base64url');
    const session = await database.client.authSession.create({
      data: {
        userId: user.id,
        tokenHash: digest(token),
        refreshTokenHash: digest(refresh),
        createdAt: new Date(Date.now() - 3600000),
        expiresAt: new Date(Date.now() + 3600000),
        refreshExpiresAt: new Date(Date.now() + 7200000),
      },
    });
    return { user, token, refresh, session };
  };
  const me = (token: string) =>
    request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', `document_tracker_session=${token}`);
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    database = app.get(PrismaService);
    server = app.getHttpServer();
  });
  afterAll(async () => {
    try {
      if (database)
        await database.client.$transaction(async (tx) => {
          await tx.authSession.deleteMany({ where: { userId: { in: ids } } });
          await tx.localCredential.deleteMany({
            where: { userId: { in: ids } },
          });
          await tx.userIdentity.deleteMany({ where: { userId: { in: ids } } });
          await tx.user.deleteMany({ where: { id: { in: ids } } });
        });
    } finally {
      await app?.close();
    }
  });

  it('returns the session owner and throttles activity writes without extending expiry', async () => {
    const { user, token, session } = await create();
    const response = await me(token).expect(200);
    expect(response.body).toEqual({
      data: {
        id: user.id,
        email: user.email,
        displayName: 'Test user',
        locale: 'en',
        timezone: 'UTC',
      },
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    const first = await database.client.authSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(first.lastSeenAt).toBeInstanceOf(Date);
    await Promise.all([
      me(token).expect(200),
      me(token).expect(200),
      me(token).expect(200),
    ]);
    const next = await database.client.authSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(next.lastSeenAt).toEqual(first.lastSeenAt);
    expect(next.updatedAt).toEqual(first.updatedAt);
    expect(next.expiresAt).toEqual(session.expiresAt);
    await database.client.authSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(Date.now() - 61000) },
    });
    await me(token).expect(200);
    const refreshed = await database.client.authSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(refreshed.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(
      first.lastSeenAt?.getTime() ?? 0,
    );
    expect(
      logs.join('').includes(token) ||
        logs.join('').includes(session.tokenHash),
    ).toBe(false);
  });

  it.each(['expired', 'revoked', 'deleted'])(
    'rejects %s sessions without recording activity',
    async (state) => {
      const { token, user, session } = await create();
      if (state === 'expired')
        await database.client.authSession.update({
          where: { id: session.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      if (state === 'revoked')
        await database.client.authSession.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });
      if (state === 'deleted')
        await database.client.user.update({
          where: { id: user.id },
          data: { deletedAt: new Date() },
        });
      const response = await me(token).expect(401);
      expect(response.body).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
          details: {},
          traceId: response.headers['x-correlation-id'] as string,
        },
      });
      expect(
        (
          await database.client.authSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).lastSeenAt,
      ).toBeNull();
    },
  );

  it('rejects missing, malformed, unknown and refresh tokens', async () => {
    const { refresh } = await create();
    await request(server).get('/api/v1/auth/me').expect(401);
    await me('invalid').expect(401);
    await me(randomBytes(32).toString('base64url')).expect(401);
    await me(refresh).expect(401);
  });

  it('cannot impersonate another database user by supplying their ID', async () => {
    const first = await create();
    const second = await create();
    const response = await request(server)
      .get('/api/v1/auth/me')
      .query({ userId: second.user.id })
      .set('userId', second.user.id)
      .set('Cookie', `document_tracker_session=${first.token}`)
      .send({ userId: second.user.id })
      .expect(200);
    expect((response.body as { data: { id: string } }).data.id).toBe(
      first.user.id,
    );
    expect(
      (
        await database.client.authSession.findUniqueOrThrow({
          where: { id: second.session.id },
        })
      ).lastSeenAt,
    ).toBeNull();
    await request(server)
      .get('/api/v1/auth/me')
      .query({ userId: second.user.id })
      .expect(401);
  });

  it('accepts a session issued by the real login flow', async () => {
    const email = `${randomUUID()}@example.invalid`;
    const password = 'a sufficiently long test password';
    await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);
    const user = await database.client.user.findUniqueOrThrow({
      where: { email },
    });
    ids.push(user.id);
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const cookie = cookies
      .find((value) => value.startsWith('document_tracker_session='))
      ?.split(';')[0];
    if (!cookie) throw new Error('Expected session cookie');
    const response = await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(200);
    expect((response.body as { data: { id: string } }).data.id).toBe(user.id);
  });
});
