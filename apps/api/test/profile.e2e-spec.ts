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
import { ProfileService } from '../src/modules/auth/profile.service';
import { InvalidCredentials } from '../src/modules/auth/login.service';
import { InvalidRegistration } from '../src/modules/auth/registration.errors';
import { databaseStub } from './database.stub';

describe('profile and logout-all HTTP contracts', () => {
  let app: INestApplication;
  let server: Server;
  const token = randomBytes(32).toString('base64url');
  const cookie = `custom_session=${token}`;
  const profile = {
    id: '873f92ec-55bb-4d06-8ff6-bf3f26a819ef',
    email: 'person@example.invalid',
    displayName: 'Person',
    locale: 'en',
    timezone: 'UTC',
  };
  const authSession = { findUnique: jest.fn(), updateMany: jest.fn() };
  const profiles = {
    update: jest.fn(),
    changePassword: jest.fn(),
    logoutAll: jest.fn(),
  };
  const logs: string[] = [];
  const patch = (path: string, body: object) =>
    request(server)
      .patch(`/api/v1/${path}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .send(body);
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/test',
      COOKIE_NAME: 'custom_session',
      CORS_ORIGINS: 'https://frontend.example',
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue({ ...databaseStub(), authSession })
      .overrideProvider(ProfileService)
      .useValue(profiles)
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    logs.length = 0;
    authSession.findUnique.mockResolvedValue({
      id: 'current-session',
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastSeenAt: new Date(),
      user: { ...profile, deletedAt: null },
    });
    profiles.update.mockResolvedValue(profile);
    profiles.changePassword.mockResolvedValue(undefined);
    profiles.logoutAll.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await app?.close();
  });
  it('GET /me preserves the safe /auth/me profile without accepting a supplied owner', async () => {
    const response = await request(server)
      .get('/api/v1/me?userId=foreign')
      .set('Cookie', cookie)
      .set('userId', 'foreign')
      .expect(200);
    expect(response.body).toEqual({
      data: profile,
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('trims the display name and passes only validated changes and trusted ownership', async () => {
    const response = await patch('me', {
      displayName: '  Person  ',
      timezone: 'Asia/Bangkok',
      locale: 'en-US',
    })
      .set('userId', 'foreign')
      .expect(200);
    expect(response.body.data).toEqual(profile);
    expect(profiles.update).toHaveBeenCalledWith(
      { user: profile, sessionId: 'current-session' },
      { displayName: 'Person', timezone: 'Asia/Bangkok', locale: 'en-US' },
    );
  });
  it.each([
    {},
    { displayName: '' },
    { displayName: '  ' },
    { displayName: 'a'.repeat(101) },
    { displayName: 'bad\u0000name' },
    { displayName: null },
    { displayName: 42 },
    { timezone: 'Mars/Olympus' },
    { timezone: '+07:00' },
    { timezone: null },
    { timezone: 42 },
    { locale: 'invalid_locale' },
    { locale: 'en-us' },
    { locale: null },
    { locale: 42 },
    { locale: 'a'.repeat(36) },
    { userId: 'foreign' },
    { displayName: 'Name', email: 'foreign@example.invalid' },
  ])('rejects invalid or unsupported profile input %#', async (body) => {
    const response = await patch('me', body).expect(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(profiles.update).not.toHaveBeenCalled();
  });
  it.each(['get', 'patch', 'password', 'logout-all'])(
    'requires authentication for %s',
    async (kind) => {
      if (kind === 'get') await request(server).get('/api/v1/me').expect(401);
      if (kind === 'patch')
        await request(server)
          .patch('/api/v1/me')
          .send({ displayName: 'Name' })
          .expect(401);
      if (kind === 'password')
        await request(server)
          .patch('/api/v1/me/password')
          .send({ currentPassword: 'old', newPassword: 'new' })
          .expect(401);
      if (kind === 'logout-all')
        await request(server).post('/api/v1/auth/logout-all').expect(401);
      expect(profiles.update).not.toHaveBeenCalled();
      expect(profiles.changePassword).not.toHaveBeenCalled();
      expect(profiles.logoutAll).not.toHaveBeenCalled();
    },
  );
  it('requires CSRF, trusted browser origin and no query parameters for mutations', async () => {
    await request(server)
      .patch('/api/v1/me')
      .set('Cookie', cookie)
      .send({ displayName: 'Name' })
      .expect(403);
    await patch('me', { displayName: 'Name' })
      .set('Origin', 'https://untrusted.example')
      .expect(403);
    await patch('me?userId=foreign', { displayName: 'Name' }).expect(400);
    await patch('me/password', { currentPassword: 'old', newPassword: 'new' })
      .set('Origin', 'https://untrusted.example')
      .expect(403);
    await request(server)
      .post('/api/v1/auth/logout-all')
      .set('Cookie', cookie)
      .expect(403);
    await request(server)
      .post('/api/v1/auth/logout-all')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .send({ userId: 'foreign' })
      .expect(400);
    expect(profiles.update).not.toHaveBeenCalled();
    expect(profiles.changePassword).not.toHaveBeenCalled();
    expect(profiles.logoutAll).not.toHaveBeenCalled();
  });
  it('acknowledges password changes without exposing or logging either password', async () => {
    const currentPassword = 'private current test password';
    const newPassword = 'private replacement test password';
    const response = await patch('me/password', {
      currentPassword,
      newPassword,
    }).expect(200);
    expect(response.body).toEqual({
      data: { passwordChanged: true },
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    expect(profiles.changePassword).toHaveBeenCalledWith(
      { user: profile, sessionId: 'current-session' },
      currentPassword,
      newPassword,
    );
    for (const secret of [currentPassword, newPassword, token])
      expect(logs.join('\n')).not.toContain(secret);
  });
  it('maps incorrect current passwords to a generic 401 and policy failures to 400', async () => {
    profiles.changePassword.mockRejectedValueOnce(new InvalidCredentials());
    const invalid = await patch('me/password', {
      currentPassword: 'wrong',
      newPassword: 'replacement',
    }).expect(401);
    expect(invalid.body.error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Unauthorized',
      details: {},
    });
    profiles.changePassword.mockRejectedValueOnce(new InvalidRegistration());
    await patch('me/password', {
      currentPassword: 'current',
      newPassword: 'weak',
    }).expect(400);
  });
  it.each([
    {},
    { currentPassword: '', newPassword: 'new' },
    { currentPassword: 'current', newPassword: null },
    { currentPassword: 'current', newPassword: 'new', userId: 'foreign' },
  ])('rejects invalid password DTO %#', async (body) => {
    await patch('me/password', body).expect(400);
    expect(profiles.changePassword).not.toHaveBeenCalled();
  });
  it('clears matching cookies after logout-all; revoked-cookie retries cannot act again', async () => {
    const response = await request(server)
      .post('/api/v1/auth/logout-all')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .set('userId', 'foreign')
      .expect(200);
    expect(response.body.data).toEqual({ loggedOut: true });
    expect(profiles.logoutAll).toHaveBeenCalledWith({
      user: profile,
      sessionId: 'current-session',
    });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('custom_session=;');
    for (const cleared of cookies) {
      expect(cleared).toContain('HttpOnly');
      expect(cleared).toContain('SameSite=Lax');
      expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
    }
    authSession.findUnique.mockResolvedValue(null);
    await request(server)
      .post('/api/v1/auth/logout-all')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .expect(401);
    expect(profiles.logoutAll).toHaveBeenCalledTimes(1);
  });
  it('documents all routes with cookie authentication and standard envelopes', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const document = response.body as {
      paths: Record<
        string,
        Record<
          string,
          { security: unknown; responses: Record<string, unknown> }
        >
      >;
    };
    for (const [path, method] of [
      ['/me', 'get'],
      ['/me', 'patch'],
      ['/me/password', 'patch'],
      ['/auth/logout-all', 'post'],
    ]) {
      expect(document.paths[`/api/v1${path}`][method].security).toEqual([
        { session: [] },
      ]);
      expect(
        document.paths[`/api/v1${path}`][method].responses['200'],
      ).toBeDefined();
      expect(
        document.paths[`/api/v1${path}`][method].responses['401'],
      ).toBeDefined();
    }
  });
});
