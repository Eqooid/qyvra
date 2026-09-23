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

describe('session rotation and logout with PostgreSQL', () => {
  let app: INestApplication;
  let database: PrismaService;
  let server: Server;
  const ids: string[] = [];
  const logs: string[] = [];
  const digest = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const create = async () => {
    const user = await database.client.user.create({
      data: { email: `${randomUUID()}@example.invalid` },
    });
    ids.push(user.id);
    const token = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const session = await database.client.authSession.create({
      data: {
        userId: user.id,
        tokenHash: digest(token),
        refreshTokenHash: digest(refreshToken),
        createdAt: new Date(Date.now() - 3600000),
        expiresAt: new Date(Date.now() + 60000),
        refreshExpiresAt: new Date(Date.now() + 3600000),
      },
    });
    return { user, token, refreshToken, session };
  };
  const refresh = (token: string) =>
    request(server)
      .post('/api/v1/auth/refresh')
      .set('X-CSRF-Protection', '1')
      .set('Cookie', `document_tracker_refresh=${token}`);
  const logout = (cookie = '') =>
    request(server)
      .post('/api/v1/auth/logout')
      .set('X-CSRF-Protection', '1')
      .set('Cookie', cookie);
  const me = (token: string) =>
    request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', `document_tracker_session=${token}`);
  const tokens = (response: request.Response) => {
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const read = (name: string) =>
      cookies
        .find((value) => value.startsWith(name + '='))
        ?.split(';')[0]
        .split('=')[1] ?? '';
    return {
      token: read('document_tracker_session'),
      refreshToken: read('document_tracker_refresh'),
    };
  };
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
          await tx.user.deleteMany({ where: { id: { in: ids } } });
        });
    } finally {
      await app?.close();
    }
  });

  it('rotates both hashes, invalidates previous access, and retains the absolute deadline', async () => {
    const original = await create();
    const response = await refresh(original.refreshToken).expect(200);
    const next = tokens(response);
    const session = await database.client.authSession.findUniqueOrThrow({
      where: { id: original.session.id },
    });
    expect(
      next.token === original.token ||
        next.refreshToken === original.refreshToken,
    ).toBe(false);
    expect(session.tokenHash === digest(next.token)).toBe(true);
    expect(session.refreshTokenHash === digest(next.refreshToken)).toBe(true);
    expect(session.refreshExpiresAt).toEqual(original.session.refreshExpiresAt);
    expect(session.expiresAt.getTime()).toBeLessThanOrEqual(
      session.refreshExpiresAt?.getTime() ?? 0,
    );
    expect(
      await database.client.consumedRefreshToken.count({
        where: { sessionId: session.id },
      }),
    ).toBe(1);
    await me(original.token).expect(401);
    await me(next.token).expect(200);
    for (const secret of [
      original.refreshToken,
      next.refreshToken,
      next.token,
      session.tokenHash,
    ])
      expect(logs.join('').includes(secret)).toBe(false);
  });

  it('detects older-generation reuse and revokes the entire current session', async () => {
    const original = await create();
    const next = tokens(await refresh(original.refreshToken).expect(200));
    const latest = tokens(await refresh(next.refreshToken).expect(200));
    await refresh(original.refreshToken).expect(401);
    expect(
      (
        await database.client.authSession.findUniqueOrThrow({
          where: { id: original.session.id },
        })
      ).revokedAt,
    ).toBeInstanceOf(Date);
    await me(latest.token).expect(401);
    await refresh(latest.refreshToken).expect(401);
  });

  it('serializes concurrent reuse so only one rotation succeeds and the session is revoked', async () => {
    const original = await create();
    const responses = await Promise.all([
      refresh(original.refreshToken),
      refresh(original.refreshToken),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    const session = await database.client.authSession.findUniqueOrThrow({
      where: { id: original.session.id },
    });
    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(
      await database.client.consumedRefreshToken.count({
        where: { sessionId: session.id },
      }),
    ).toBe(1);
  });

  it.each(['expired', 'revoked', 'deleted'])(
    'rejects %s refresh state without rotation',
    async (state) => {
      const original = await create();
      if (state === 'expired')
        await database.client.authSession.update({
          where: { id: original.session.id },
          data: {
            expiresAt: new Date(Date.now() - 2000),
            refreshExpiresAt: new Date(Date.now() - 1000),
          },
        });
      if (state === 'revoked')
        await database.client.authSession.update({
          where: { id: original.session.id },
          data: { revokedAt: new Date() },
        });
      if (state === 'deleted')
        await database.client.user.update({
          where: { id: original.user.id },
          data: { deletedAt: new Date() },
        });
      const response = await refresh(original.refreshToken).expect(401);
      expect(response.body).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
          details: {},
          traceId: response.headers['x-correlation-id'] as string,
        },
      });
      expect(
        await database.client.consumedRefreshToken.count({
          where: { sessionId: original.session.id },
        }),
      ).toBe(0);
    },
  );

  it('allows expired access to refresh within its refresh deadline and rejects unknown tokens', async () => {
    const original = await create();
    await database.client.authSession.update({
      where: { id: original.session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await me(original.token).expect(401);
    await refresh(original.refreshToken).expect(200);
    await refresh(randomBytes(32).toString('base64url')).expect(401);
    await refresh('malformed').expect(401);
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('X-CSRF-Protection', '1')
      .expect(401);
  });

  it('revokes only the current session and keeps repeated logout successful', async () => {
    const original = await create();
    const unrelated = await create();
    const cookie = `document_tracker_session=${original.token}; document_tracker_refresh=${unrelated.refreshToken}`;
    await logout(cookie).expect(200);
    const first = await database.client.authSession.findUniqueOrThrow({
      where: { id: original.session.id },
    });
    expect(first.revokedAt).toBeInstanceOf(Date);
    await logout(cookie).expect(200);
    await logout().expect(200);
    await logout('document_tracker_session=invalid').expect(200);
    expect(
      (
        await database.client.authSession.findUniqueOrThrow({
          where: { id: original.session.id },
        })
      ).revokedAt,
    ).toEqual(first.revokedAt);
    await me(original.token).expect(401);
    await refresh(original.refreshToken).expect(401);
    await me(unrelated.token).expect(200);
  });

  it('logs out using a consumed refresh cookie after concurrent rotation', async () => {
    const original = await create();
    const next = tokens(await refresh(original.refreshToken).expect(200));
    await logout(`document_tracker_refresh=${original.refreshToken}`).expect(
      200,
    );
    await me(next.token).expect(401);
    await refresh(next.refreshToken).expect(401);
  });
});
