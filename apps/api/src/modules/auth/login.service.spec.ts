import { ConfigurationService } from '../../configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from '../../../test/configuration.fixture';
import { PasswordService } from './password.service';
import { LoginRepository } from './login.repository';
import { InvalidCredentials, LoginService } from './login.service';
import { createHash } from 'node:crypto';

describe('login service', () => {
  const configuration = new ConfigurationService(
    validateEnvironment({ DATABASE_URL: 'postgresql://localhost/test' }),
  );
  const passwords = { verify: jest.fn() };
  const repository = { find: jest.fn(), complete: jest.fn() };
  const service = new LoginService(
    passwords as unknown as PasswordService,
    repository as unknown as LoginRepository,
    configuration,
  );
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('performs dummy verification for an unknown account without persistence', async () => {
    repository.find.mockResolvedValue(undefined);
    passwords.verify.mockResolvedValue(false);
    await expect(
      service.login(' Nobody@Example.Invalid ', 'incorrect'),
    ).rejects.toBeInstanceOf(InvalidCredentials);
    expect(repository.find).toHaveBeenCalledWith('nobody@example.invalid');
    expect(passwords.verify).toHaveBeenCalledWith('incorrect', undefined);
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('generates independent 256-bit tokens and persists only SHA-256 hashes', async () => {
    repository.find.mockResolvedValue({
      userId: 'id',
      passwordHash: 'synthetic',
    });
    passwords.verify.mockResolvedValue(true);
    repository.complete.mockResolvedValue({
      user: { id: 'id', email: 'person@example.invalid' },
      expiresAt: new Date(),
      refreshExpiresAt: new Date(),
    });
    const first = await service.login('person@example.invalid', 'password');
    const second = await service.login('person@example.invalid', 'password');
    expect(Buffer.from(first.token, 'base64url').length).toBe(32);
    expect(
      first.token === first.refreshToken || first.token === second.token,
    ).toBe(false);
    const hashes = repository.complete.mock.calls[0]?.[2] as {
      tokenHash: string;
      refreshTokenHash: string;
    };
    expect(
      hashes.tokenHash ===
        createHash('sha256').update(first.token).digest('hex'),
    ).toBe(true);
    expect(
      hashes.refreshTokenHash ===
        createHash('sha256').update(first.refreshToken).digest('hex'),
    ).toBe(true);
    expect(JSON.stringify(hashes).includes(first.token)).toBe(false);
  });

  it('records failed verification and treats lockout like invalid credentials', async () => {
    repository.find.mockResolvedValue({
      userId: 'id',
      passwordHash: 'synthetic',
    });
    passwords.verify.mockResolvedValue(false);
    repository.complete.mockResolvedValue(null);
    await expect(
      service.login('person@example.invalid', 'incorrect'),
    ).rejects.toBeInstanceOf(InvalidCredentials);
    expect(repository.complete.mock.calls[0]?.[1]).toBe(false);
    passwords.verify.mockResolvedValue(true);
    await expect(
      service.login('person@example.invalid', 'correct'),
    ).rejects.toBeInstanceOf(InvalidCredentials);
  });

  it('verifies existing passwords independently of registration policy', async () => {
    const original = new PasswordService(configuration);
    const digest = await original.hash('a sufficiently long password');
    const stricter = new PasswordService(
      new ConfigurationService(
        validateEnvironment({
          DATABASE_URL: 'postgresql://localhost/test',
          AUTH_PASSWORD_MIN_LENGTH: '64',
        }),
      ),
    );
    expect(await stricter.verify('a sufficiently long password', digest)).toBe(
      true,
    );
    expect(await stricter.verify('incorrect', digest)).toBe(false);
    expect(await stricter.verify('incorrect')).toBe(false);
    await expect(stricter.verify('incorrect', 'malformed')).rejects.toThrow(
      'Password verification failed.',
    );
  });
});

describe('login configuration', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/test' };
  it.each([
    { AUTH_REFRESH_TTL_SECONDS: '0' },
    { AUTH_REFRESH_TTL_SECONDS: '7776001' },
    { AUTH_REFRESH_TTL_SECONDS: '60', AUTH_SESSION_TTL_SECONDS: '120' },
    { AUTH_LOGIN_LOCKOUT_SECONDS: '0' },
    { COOKIE_REFRESH_NAME: 'document_tracker_session' },
    { COOKIE_REFRESH_NAME: '__Secure-refresh', COOKIE_SECURE: 'false' },
    { COOKIE_REFRESH_NAME: '__Host-refresh', COOKIE_SECURE: 'true' },
    {
      COOKIE_NAME: '__Host-session',
      COOKIE_SECURE: 'true',
      COOKIE_DOMAIN: 'example.invalid',
    },
    { COOKIE_DOMAIN: 'https://example.invalid' },
    { COOKIE_DOMAIN: 'example.invalid; HttpOnly' },
    { COOKIE_DOMAIN: '.example.invalid' },
    { COOKIE_DOMAIN: '127.0.0.1' },
    { COOKIE_PATH: '/unrelated' },
    { COOKIE_REFRESH_PATH: '/unrelated' },
  ])('fails fast for unsafe configuration %#', (env) => {
    expect(() => validateEnvironment({ ...base, ...env })).toThrow(
      'Invalid configuration',
    );
  });
  it('supports scoped production cookies and host-prefixed refresh cookies', () => {
    const config = validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      COOKIE_DOMAIN: 'example.invalid',
      COOKIE_PATH: '/api/v1',
      COOKIE_SAME_SITE: 'none',
    });
    expect(config.cookie).toMatchObject({
      domain: 'example.invalid',
      path: '/api/v1',
      secure: true,
      httpOnly: true,
      sameSite: 'none',
    });
    expect(
      validateEnvironment({
        ...base,
        COOKIE_REFRESH_NAME: '__Host-refresh',
        COOKIE_REFRESH_PATH: '/',
        COOKIE_SECURE: 'true',
      }).cookie.refreshPath,
    ).toBe('/');
  });
});
