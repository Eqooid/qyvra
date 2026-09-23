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

describe('authenticated session management with PostgreSQL', () => {
  let app: INestApplication;
  let db: PrismaService;
  let server: Server;
  const users: string[] = [];
  it('documents cookie authentication, pagination and revocation routes', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const document = response.body as {
      paths: Record<
        string,
        {
          get?: { security: unknown; parameters: { name: string }[] };
          delete?: { security: unknown };
        }
      >;
    };
    expect(document.paths['/api/v1/me/sessions'].get?.security).toEqual([
      { session: [] },
    ]);
    expect(
      document.paths['/api/v1/me/sessions'].get?.parameters.map((p) => p.name),
    ).toEqual(expect.arrayContaining(['limit', 'cursor']));
    expect(
      document.paths['/api/v1/me/sessions/others'].delete?.security,
    ).toEqual([{ session: [] }]);
    expect(
      document.paths['/api/v1/me/sessions/{sessionId}'].delete?.security,
    ).toEqual([{ session: [] }]);
  });
  const makeSession = async (userId?: string) => {
    if (!userId) {
      const user = await db.client.user.create({
        data: { email: `${randomUUID()}@example.invalid` },
      });
      userId = user.id;
      users.push(userId);
    }
    const token = randomBytes(32).toString('base64url');
    const refresh = randomBytes(32).toString('base64url');
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const row = await db.client.authSession.create({
      data: {
        userId,
        tokenHash: digest(token),
        refreshTokenHash: digest(refresh),
        createdAt: new Date(Date.now() - 3600000),
        expiresAt: new Date(Date.now() + 3600000),
        refreshExpiresAt: new Date(Date.now() + 7200000),
      },
    });
    return {
      id: row.id,
      userId,
      token,
      refresh,
      cookie: `document_tracker_session=${token}`,
    };
  };
  const remove = (path: string, cookie: string) =>
    request(server)
      .delete(`/api/v1/me/sessions/${path}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1');
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    db = app.get(PrismaService);
    server = app.getHttpServer();
  });
  afterAll(async () => {
    try {
      if (db)
        await db.client.$transaction(async (tx) => {
          await tx.authSession.deleteMany({ where: { userId: { in: users } } });
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
    } finally {
      await app?.close();
    }
  });
  it('lists only active/renewable owned sessions, paginates, and identifies the actual current session', async () => {
    const current = await makeSession();
    const other = await makeSession(current.userId);
    const expired = await makeSession(current.userId);
    const revoked = await makeSession(current.userId);
    const foreign = await makeSession();
    await db.client.authSession.update({
      where: { id: other.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await db.client.authSession.update({
      where: { id: expired.id },
      data: {
        expiresAt: new Date(Date.now() - 2000),
        refreshExpiresAt: new Date(Date.now() - 1000),
      },
    });
    await db.client.authSession.update({
      where: { id: revoked.id },
      data: { revokedAt: new Date() },
    });
    const response = await request(server)
      .get('/api/v1/me/sessions')
      .set('Cookie', current.cookie)
      .set('userId', foreign.userId)
      .expect(200);
    const body = response.body as {
      data: {
        sessions: { id: string; isCurrent: boolean }[];
        nextCursor: string | null;
      };
    };
    expect(body.data.sessions.map((s) => s.id).sort()).toEqual(
      [current.id, other.id].sort(),
    );
    expect(body.data.sessions.find((s) => s.isCurrent)?.id).toBe(current.id);
    expect(Object.keys(body.data.sessions[0]).sort()).toEqual(
      [
        'id',
        'createdAt',
        'lastSeenAt',
        'expiresAt',
        'refreshExpiresAt',
        'isCurrent',
      ].sort(),
    );
    const first = await request(server)
      .get('/api/v1/me/sessions?limit=1')
      .set('Cookie', current.cookie)
      .expect(200);
    const page = first.body as {
      data: { sessions: { id: string }[]; nextCursor: string };
    };
    const second = await request(server)
      .get('/api/v1/me/sessions')
      .query({ limit: 1, cursor: page.data.nextCursor })
      .set('Cookie', current.cookie)
      .expect(200);
    expect(
      (second.body as { data: { sessions: { id: string }[] } }).data.sessions[0]
        .id,
    ).not.toBe(page.data.sessions[0].id);
    await request(server)
      .get('/api/v1/me/sessions')
      .query({ userId: foreign.userId })
      .set('Cookie', current.cookie)
      .expect(400);
  });
  it('makes foreign and missing sessions indistinguishable and preserves foreign access', async () => {
    const current = await makeSession();
    const foreign = await makeSession();
    for (const id of [foreign.id, randomUUID()]) {
      const response = await remove(id, current.cookie).expect(404);
      expect(response.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Not Found',
          details: {},
          traceId: response.headers['x-correlation-id'] as string,
        },
      });
    }
    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', foreign.cookie)
      .expect(200);
  });
  it('revokes one owned session idempotently and blocks its access and refresh', async () => {
    const current = await makeSession();
    const other = await makeSession(current.userId);
    await remove(other.id, current.cookie).expect(200);
    const first = await db.client.authSession.findUniqueOrThrow({
      where: { id: other.id },
    });
    await remove(other.id, current.cookie).expect(200);
    expect(
      (
        await db.client.authSession.findUniqueOrThrow({
          where: { id: other.id },
        })
      ).revokedAt,
    ).toEqual(first.revokedAt);
    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', other.cookie)
      .expect(401);
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('X-CSRF-Protection', '1')
      .set('Cookie', `document_tracker_refresh=${other.refresh}`)
      .expect(401);
  });
  it('revokes all other owned sessions but preserves the current and foreign sessions', async () => {
    const current = await makeSession();
    const other = await makeSession(current.userId);
    const foreign = await makeSession();
    const response = await remove('others', current.cookie)
      .set('sessionId', other.id)
      .expect(200);
    expect(
      (response.body as { data: { revokedCount: number } }).data.revokedCount,
    ).toBe(1);
    const repeated = await remove('others', current.cookie).expect(200);
    expect(
      (repeated.body as { data: { revokedCount: number } }).data.revokedCount,
    ).toBe(0);
    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', current.cookie)
      .expect(200);
    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', foreign.cookie)
      .expect(200);
    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', other.cookie)
      .expect(401);
  });
  it('clears cookies when revoking the authenticated session', async () => {
    const current = await makeSession();
    const response = await remove(current.id, current.cookie).expect(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.length).toBe(2);
    expect(cookies.every((cookie) => cookie.split(';')[0].endsWith('='))).toBe(
      true,
    );
    await request(server)
      .get('/api/v1/me/sessions')
      .set('Cookie', current.cookie)
      .expect(401);
  });
  it('requires authentication, valid parameters and CSRF protection', async () => {
    const current = await makeSession();
    await request(server).get('/api/v1/me/sessions').expect(401);
    await remove('others', '').expect(401);
    await request(server)
      .delete('/api/v1/me/sessions/others')
      .set('Cookie', current.cookie)
      .expect(403);
    await remove('others', current.cookie)
      .set('Origin', 'https://untrusted.example.invalid')
      .expect(403);
    await remove('not-a-uuid', current.cookie).expect(400);
    await remove('others', current.cookie)
      .send({ userId: current.userId })
      .expect(400);
    await request(server)
      .get('/api/v1/me/sessions?limit=101')
      .set('Cookie', current.cookie)
      .expect(400);
    expect(
      (
        await db.client.authSession.findUniqueOrThrow({
          where: { id: current.id },
        })
      ).revokedAt,
    ).toBeNull();
  });
});
