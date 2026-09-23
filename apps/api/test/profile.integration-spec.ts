import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@brainless/database';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { PasswordService } from '../src/modules/auth/password.service';
import { RegistrationRepository } from '../src/modules/auth/registration.repository';

describe('profile and password persistence with PostgreSQL', () => {
  let app: INestApplication;
  let db: PrismaService;
  let passwords: PasswordService;
  let server: Server;
  const users: string[] = [];
  const logs: string[] = [];
  const original = 'original integration passphrase';
  const replacement = 'replacement integration passphrase';
  let initialHash: string;
  const session = async (userId: string) => {
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
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        refreshExpiresAt: new Date(Date.now() + 7200000),
      },
    });
    return {
      id: row.id,
      userId,
      cookie: `document_tracker_session=${token}`,
      refreshCookie: `document_tracker_refresh=${refresh}`,
    };
  };
  const account = async (local = true) => {
    const email = `${randomUUID()}@example.invalid`;
    const user = local
      ? await app.get(RegistrationRepository).create(email, initialHash)
      : await db.client.user.create({ data: { email } });
    users.push(user.id);
    return session(user.id);
  };
  const patch = (path: string, cookie: string, body: object) =>
    request(server)
      .patch(`/api/v1/${path}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .send(body);
  const me = (cookie: string) =>
    request(server).get('/api/v1/me').set('Cookie', cookie);
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      AUTH_LOGIN_RATE_LIMIT: '100',
      AUTH_GLOBAL_RATE_LIMIT: '1000',
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
    db = app.get(PrismaService);
    passwords = app.get(PasswordService);
    server = app.getHttpServer();
    initialHash = await passwords.hash(original);
  });
  afterAll(async () => {
    try {
      if (db)
        await db.client.$transaction(async (tx) => {
          const where = { userId: { in: users } };
          await tx.authSession.deleteMany({ where });
          await tx.localCredential.deleteMany({ where });
          await tx.userIdentity.deleteMany({ where });
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
    } finally {
      await app?.close();
    }
  });
  it('updates only the authenticated profile and returns exactly the safe projection', async () => {
    const owner = await account();
    const foreign = await account();
    const before = await db.client.user.findUniqueOrThrow({
      where: { id: foreign.userId },
    });
    const response = await patch('me', owner.cookie, {
      displayName: '  Updated Name  ',
      timezone: 'Asia/Bangkok',
      locale: 'en-US',
    })
      .set('userId', foreign.userId)
      .expect(200);
    expect(Object.keys(response.body.data).sort()).toEqual(
      ['id', 'email', 'displayName', 'timezone', 'locale'].sort(),
    );
    expect(response.body.data).toMatchObject({
      id: owner.userId,
      displayName: 'Updated Name',
      timezone: 'Asia/Bangkok',
      locale: 'en-US',
    });
    expect((await me(owner.cookie).expect(200)).body.data).toEqual(
      response.body.data,
    );
    await patch('me', owner.cookie, {
      displayName: 'Attack',
      userId: foreign.userId,
    }).expect(400);
    expect(
      await db.client.user.findUniqueOrThrow({ where: { id: foreign.userId } }),
    ).toEqual(before);
  });
  it('changes the Argon2id hash atomically, revokes other sessions and preserves current/foreign sessions', async () => {
    const owner = await account();
    const other = await session(owner.userId);
    const foreign = await account();
    const before = await db.client.localCredential.findUniqueOrThrow({
      where: { userId: owner.userId },
    });
    const response = await patch('me/password', owner.cookie, {
      currentPassword: original,
      newPassword: replacement,
    }).expect(200);
    expect(response.body.data).toEqual({ passwordChanged: true });
    const after = await db.client.localCredential.findUniqueOrThrow({
      where: { userId: owner.userId },
    });
    expect(after.passwordHash === before.passwordHash).toBe(false);
    expect(after.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await passwords.verify(replacement, after.passwordHash)).toBe(true);
    expect(await passwords.verify(original, after.passwordHash)).toBe(false);
    expect(after.passwordChangedAt.getTime()).toBeGreaterThanOrEqual(
      before.passwordChangedAt.getTime(),
    );
    await me(owner.cookie).expect(200);
    await me(foreign.cookie).expect(200);
    await me(other.cookie).expect(401);
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', other.refreshCookie)
      .set('X-CSRF-Protection', '1')
      .expect(401);
    const output = JSON.stringify(response.body) + logs.join('\n');
    for (const secret of [
      original,
      replacement,
      before.passwordHash,
      after.passwordHash,
    ])
      expect(output.includes(secret)).toBe(false);
  });
  it.each(['incorrect', 'weak', 'unsupported', 'non-local'])(
    'rejects %s password changes without changing credentials or other sessions',
    async (kind) => {
      const owner = await account(kind !== 'non-local');
      const other = await session(owner.userId);
      const before = await db.client.localCredential.findUnique({
        where: { userId: owner.userId },
      });
      const body = {
        currentPassword: kind === 'incorrect' ? 'incorrect password' : original,
        newPassword: kind === 'weak' ? 'weak' : replacement,
        ...(kind === 'unsupported' ? { userId: randomUUID() } : {}),
      };
      const response = await patch('me/password', owner.cookie, body).expect(
        kind === 'weak' || kind === 'unsupported' ? 400 : 401,
      );
      expect(response.body.error.details).toEqual({});
      const after = await db.client.localCredential.findUnique({
        where: { userId: owner.userId },
      });
      expect(after?.passwordHash === before?.passwordHash).toBe(true);
      await me(other.cookie).expect(200);
    },
  );
  it('rolls back the credential write if session revocation fails inside the real PostgreSQL transaction', async () => {
    const owner = await account();
    const other = await session(owner.userId);
    const transaction = db.client.$transaction.bind(db.client);
    const spy = jest.spyOn(db.client, '$transaction').mockImplementationOnce(((
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) =>
      transaction(async (tx) => {
        // Inject only the failure boundary; credential writes and rollback use PostgreSQL.
        tx.authSession.updateMany = jest
          .fn()
          .mockRejectedValue(new Error('simulated revocation failure'));
        return work(tx);
      })) as typeof db.client.$transaction);
    try {
      await patch('me/password', owner.cookie, {
        currentPassword: original,
        newPassword: replacement,
      }).expect(500);
    } finally {
      spy.mockRestore();
    }
    const credential = await db.client.localCredential.findUniqueOrThrow({
      where: { userId: owner.userId },
    });
    expect(credential.passwordHash === initialHash).toBe(true);
    await me(owner.cookie).expect(200);
    await me(other.cookie).expect(200);
  });
  it('logout-all revokes only owned sessions, clears cookies and is safe to repeat', async () => {
    const owner = await account();
    const other = await session(owner.userId);
    const foreign = await account();
    const logout = () =>
      request(server)
        .post('/api/v1/auth/logout-all')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Protection', '1')
        .set('userId', foreign.userId);
    const response = await logout().expect(200);
    expect(response.body.data).toEqual({ loggedOut: true });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies.every((cookie) => cookie.split(';')[0].endsWith('='))).toBe(
      true,
    );
    const revoked = await db.client.authSession.findMany({
      where: { userId: owner.userId },
      select: { id: true, revokedAt: true },
    });
    expect(revoked.every((row) => row.revokedAt !== null)).toBe(true);
    await logout().expect(401);
    expect(
      await db.client.authSession.findMany({
        where: { userId: owner.userId },
        select: { id: true, revokedAt: true },
      }),
    ).toEqual(revoked);
    await me(owner.cookie).expect(401);
    await me(other.cookie).expect(401);
    await me(foreign.cookie).expect(200);
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', owner.refreshCookie)
      .set('X-CSRF-Protection', '1')
      .expect(401);
  });
});
