import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { LoginRepository } from '../src/modules/auth/login.repository';
import { LOG_SINK } from '../src/common/structured-logger';

describe('local login with real PostgreSQL', () => {
  let app: INestApplication;
  let database: PrismaService;
  let server: Server;
  const emails: string[] = [];
  const logs: string[] = [];
  const password = 'a sufficiently long login passphrase';
  const config = () =>
    validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      AUTH_LOGIN_MAX_ATTEMPTS: '3',
      AUTH_LOGIN_WINDOW_SECONDS: '60',
      AUTH_LOGIN_LOCKOUT_SECONDS: '60',
      AUTH_SESSION_TTL_SECONDS: '120',
      AUTH_REFRESH_TTL_SECONDS: '300',
    });
  const email = () => {
    const value = `${randomUUID()}@example.invalid`;
    emails.push(value);
    return value;
  };
  const register = async () => {
    const address = email();
    await request(server)
      .post('/api/v1/auth/register')
      .send({ email: address, password })
      .expect(201);
    return address;
  };
  const login = (address: string, suppliedPassword = password) =>
    request(server)
      .post('/api/v1/auth/login')
      .send({ email: address, password: suppliedPassword });
  const cookies = (response: request.Response) =>
    (response.headers['set-cookie'] as unknown as string[]).map(
      (value) => value.split(';')[0].split('=')[1],
    );

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config())
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config());
    await app.init();
    database = app.get(PrismaService);
    server = app.getHttpServer();
  });
  afterAll(async () => {
    try {
      if (database)
        await database.client.$transaction(async (tx) => {
          await tx.authSession.deleteMany({
            where: { user: { email: { in: emails } } },
          });
          await tx.localCredential.deleteMany({
            where: { user: { email: { in: emails } } },
          });
          await tx.userIdentity.deleteMany({
            where: { user: { email: { in: emails } } },
          });
          await tx.user.deleteMany({ where: { email: { in: emails } } });
        });
    } finally {
      await app?.close();
    }
  });

  it('persists hashes, expiration and login metadata without leaking secrets', async () => {
    const address = await register();
    const before = Date.now();
    const response = await login(` ${address.toUpperCase()} `)
      .set('Cookie', 'document_tracker_session=untrusted')
      .expect(200);
    const [token, refreshToken] = cookies(response);
    const user = await database.client.user.findUniqueOrThrow({
      where: { email: address },
      include: { sessions: true, localCredentials: true },
    });
    expect(user.sessions).toHaveLength(1);
    const session = user.sessions[0];
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    expect(session.tokenHash === digest(token)).toBe(true);
    expect(session.refreshTokenHash === digest(refreshToken)).toBe(true);
    expect(token === refreshToken || token === 'untrusted').toBe(false);
    expect(Buffer.from(token, 'base64url').length).toBe(32);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(
      120000,
    );
    expect(
      (session.refreshExpiresAt?.getTime() ?? 0) - session.createdAt.getTime(),
    ).toBe(300000);
    expect(session.authenticationMethod).toBe('LOCAL_PASSWORD');
    expect(user.lastLoginAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(session.revokedAt).toBeNull();
    expect(response.body).toEqual({
      data: {
        user: { id: user.id, email: address },
        expiresAt: session.expiresAt.toISOString(),
      },
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    const second = await login(address).expect(200);
    expect(cookies(second)[0] === token).toBe(false);
    for (const secret of [
      password,
      token,
      refreshToken,
      session.tokenHash,
      session.refreshTokenHash,
      user.localCredentials?.passwordHash,
    ]) {
      expect(typeof secret === 'string' && logs.join('').includes(secret)).toBe(
        false,
      );
    }
  });

  it('uses the same generic response for wrong, unknown, deleted and external-only accounts', async () => {
    const address = await register();
    const wrong = await login(address, 'incorrect').expect(401);
    const unknown = await login(email()).expect(401);
    await database.client.user.update({
      where: { email: address },
      data: { deletedAt: new Date() },
    });
    const deleted = await login(address).expect(401);
    const externalEmail = email();
    await database.client.user.create({ data: { email: externalEmail } });
    const external = await login(externalEmail).expect(401);
    for (const response of [wrong, unknown, deleted, external]) {
      expect(response.body).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
          details: {},
          traceId: response.headers['x-correlation-id'] as string,
        },
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(
      await database.client.authSession.count({
        where: { user: { email: address } },
      }),
    ).toBe(0);
  });

  it('tracks concurrent failures, locks correct passwords, and recovers after expiry', async () => {
    const address = await register();
    const responses = await Promise.all([
      login(address, 'incorrect'),
      login(address, 'incorrect'),
      login(address, 'incorrect'),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401]);
    const user = await database.client.user.findUniqueOrThrow({
      where: { email: address },
      include: { localCredentials: true },
    });
    expect(user.localCredentials?.failedLoginAttempts).toBe(3);
    expect(user.localCredentials?.lockedUntil?.getTime()).toBeGreaterThan(
      Date.now(),
    );
    const locked = await login(address).expect(401);
    expect(locked.headers['set-cookie']).toBeUndefined();
    const credential = await database.client.localCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(credential.failedLoginAttempts).toBe(3);
    expect(credential.lockedUntil).toEqual(user.localCredentials?.lockedUntil);
    await database.client.localCredential.update({
      where: { userId: user.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    await login(address).expect(200);
    const cleared = await database.client.localCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(cleared.failedLoginAttempts).toBe(0);
    expect(cleared.lastFailedLoginAt).toBeNull();
    expect(cleared.lockedUntil).toBeNull();
  });

  it('resets failures after the configured idle window', async () => {
    const address = await register();
    const user = await database.client.user.findUniqueOrThrow({
      where: { email: address },
    });
    await database.client.localCredential.update({
      where: { userId: user.id },
      data: {
        failedLoginAttempts: 2,
        lastFailedLoginAt: new Date(Date.now() - 61000),
      },
    });
    await login(address, 'incorrect').expect(401);
    const credential = await database.client.localCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(credential.failedLoginAttempts).toBe(1);
    expect(credential.lockedUntil).toBeNull();
    expect(
      (await database.client.user.findUniqueOrThrow({ where: { id: user.id } }))
        .lastLoginAt,
    ).toBeNull();
  });

  it('rejects stale password verification and leaves no partial state on session insert failure', async () => {
    const address = await register();
    await login(address).expect(200);
    const user = await database.client.user.findUniqueOrThrow({
      where: { email: address },
      include: { sessions: true },
    });
    const repository = app.get(LoginRepository);
    const snapshot = await repository.find(address);
    if (!snapshot) throw new Error('Missing test account');
    const hashes = {
      tokenHash: user.sessions[0].tokenHash,
      refreshTokenHash: user.sessions[0].refreshTokenHash ?? '',
    };
    await expect(
      repository.complete(
        { ...snapshot, passwordHash: 'stale' },
        true,
        hashes,
        config().authentication,
      ),
    ).resolves.toBeNull();
    await expect(
      repository.complete(snapshot, true, hashes, config().authentication),
    ).rejects.toThrow('Login persistence failed.');
    expect(
      await database.client.authSession.count({ where: { userId: user.id } }),
    ).toBe(1);
    expect(
      (await database.client.user.findUniqueOrThrow({ where: { id: user.id } }))
        .lastLoginAt,
    ).toEqual(user.lastLoginAt);
  });
});
