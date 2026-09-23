import { validateEnvironment } from './environment';
import { storageTestRoot } from '../../test/configuration.fixture';
import { resolve } from 'node:path';

const base = {
  DATABASE_URL: 'postgresql://localhost/configuration_test',
  LOCAL_STORAGE_ROOT: storageTestRoot,
};

describe('environment configuration', () => {
  it('requires a dedicated storage root and rejects unsupported providers without echoing paths', () => {
    expect(() =>
      validateEnvironment({ ...base, LOCAL_STORAGE_ROOT: undefined }),
    ).toThrow('LOCAL_STORAGE_ROOT');
    expect(() =>
      validateEnvironment({ ...base, STORAGE_PROVIDER: 's3' }),
    ).toThrow('STORAGE_PROVIDER');
    for (const root of [
      '',
      '.',
      '../files',
      resolve(__dirname, '../..'),
      resolve(__dirname, '../../../../apps/web/public'),
      '/unsafe/../path',
    ]) {
      expect(() =>
        validateEnvironment({ ...base, LOCAL_STORAGE_ROOT: root }),
      ).toThrow('LOCAL_STORAGE_ROOT');
    }
    for (const mode of ['development', 'test', 'production'])
      expect(validateEnvironment({ ...base, NODE_ENV: mode }).storage).toEqual({
        provider: 'local',
        localRoot: storageTestRoot,
      });
  });
  it.each([
    'HTTP_BODY_LIMIT_BYTES',
    'AUTH_RATE_WINDOW_SECONDS',
    'AUTH_REGISTER_RATE_LIMIT',
    'AUTH_LOGIN_RATE_LIMIT',
    'AUTH_REFRESH_RATE_LIMIT',
    'AUTH_GLOBAL_RATE_LIMIT',
  ])('rejects disabled or unbounded security setting %s', (key) => {
    for (const value of ['0', '-1', '1.5', '999999999', 'invalid']) {
      expect(() => validateEnvironment({ ...base, [key]: value })).toThrow(key);
    }
  });
  it('requires HTTPS browser origins in production but supports local HTTP in development', () => {
    expect(() =>
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'http://frontend.example',
      }),
    ).toThrow('CORS_ORIGINS');
    expect(
      validateEnvironment({ ...base, CORS_ORIGINS: 'http://localhost:3000' })
        .cookie.secure,
    ).toBe(false);
    expect(
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://frontend.example',
        CORS_CREDENTIALS: 'true',
      }).cookie,
    ).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      domain: undefined,
    });
  });
  it('defaults to a non-frontend port and disabled CORS', () => {
    expect(validateEnvironment(base)).toMatchObject({
      application: { environment: 'development', name: 'Brainless API' },
      http: { port: 3001, host: '0.0.0.0' },
      cors: { origins: [], credentials: false },
      authentication: {
        sessionTtlSeconds: 604800,
        loginMaxAttempts: 5,
        loginWindowSeconds: 900,
      },
      cookie: {
        secure: false,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAgeMs: 604800000,
      },
    });
  });
  it('parses explicit settings and deduplicates origins', () => {
    expect(
      validateEnvironment({
        ...base,
        PORT: '4000',
        CORS_ORIGINS:
          'https://one.example, http://localhost:4567,https://one.example',
        CORS_CREDENTIALS: 'true',
      }),
    ).toMatchObject({
      http: { port: 4000 },
      cors: {
        origins: ['https://one.example', 'http://localhost:4567'],
        credentials: true,
      },
    });
  });
  it.each(['', '0', '65536', '-1', '1.5', '1e3', 'abc', 3000])(
    'rejects invalid PORT %p',
    (PORT) => {
      expect(() => validateEnvironment({ PORT })).toThrow('PORT');
    },
  );
  it.each(['yes', '1', '', 'TRUE', true])(
    'rejects invalid credentials flag %p',
    (CORS_CREDENTIALS) => {
      expect(() => validateEnvironment({ CORS_CREDENTIALS })).toThrow(
        'CORS_CREDENTIALS',
      );
    },
  );
  it.each([
    '*',
    'null',
    'not-a-url',
    'ftp://example.com',
    'https://example.com/',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com#fragment',
    'https://user:secret@example.com',
    'https://example.com,',
    'https://*.example.com',
    123,
  ])('rejects invalid origin %p without exposing its value', (CORS_ORIGINS) => {
    expect(() => validateEnvironment({ CORS_ORIGINS })).toThrow('CORS_ORIGINS');
    try {
      validateEnvironment({ CORS_ORIGINS });
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
});

describe('full typed settings', () => {
  it('uses bounded PostgreSQL defaults and accepts explicit limits', () => {
    expect(validateEnvironment(base).database).toEqual({
      url: base.DATABASE_URL,
      connectTimeoutMs: 500,
      queryTimeoutMs: 500,
      poolSize: 5,
    });
    expect(
      validateEnvironment({
        ...base,
        DATABASE_CONNECT_TIMEOUT_MS: '100',
        DATABASE_QUERY_TIMEOUT_MS: '200',
        DATABASE_POOL_SIZE: '2',
      }).database,
    ).toMatchObject({
      connectTimeoutMs: 100,
      queryTimeoutMs: 200,
      poolSize: 2,
    });
  });

  it.each([
    ['DATABASE_CONNECT_TIMEOUT_MS', '0'],
    ['DATABASE_CONNECT_TIMEOUT_MS', '1001'],
    ['DATABASE_QUERY_TIMEOUT_MS', 'infinite'],
    ['DATABASE_QUERY_TIMEOUT_MS', '1001'],
    ['DATABASE_POOL_SIZE', '0'],
    ['DATABASE_POOL_SIZE', '21'],
    ['DATABASE_URL', 'postgresql://localhost/test?statement_timeout=0'],
    ['DATABASE_URL', 'postgresql://localhost/test?query_timeout=0'],
    ['DATABASE_URL', 'postgresql://localhost/test?options=unsafe'],
  ])('rejects invalid PostgreSQL setting %s', (key, value) => {
    expect(() => validateEnvironment({ ...base, [key]: value })).toThrow(key);
  });
  it.each(['development', 'test', 'production'])(
    'supports %s with environment-specific cookie defaults',
    (NODE_ENV) => {
      const config = validateEnvironment({ ...base, NODE_ENV });
      expect(config.application.environment).toBe(NODE_ENV);
      expect(config.cookie.secure).toBe(NODE_ENV === 'production');
      expect(config.database.url).toBe(base.DATABASE_URL);
      expect(Object.isFrozen(config.cookie)).toBe(true);
    },
  );

  it('parses authentication, cookie, and HTTP overrides', () => {
    const config = validateEnvironment({
      ...base,
      APP_NAME: 'Test API',
      HTTP_HOST: '::1',
      AUTH_SESSION_TTL_SECONDS: '60',
      AUTH_LOGIN_MAX_ATTEMPTS: '10',
      AUTH_LOGIN_WINDOW_SECONDS: '120',
      COOKIE_NAME: '__Host-session',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'none',
    });
    expect(config.application.name).toBe('Test API');
    expect(config.http.host).toBe('::1');
    expect(config.authentication).toEqual({
      globalRateLimit: 300,
      loginRateLimit: 30,
      rateWindowSeconds: 60,
      refreshRateLimit: 60,
      registerRateLimit: 10,
      refreshTtlSeconds: 2592000,
      loginLockoutSeconds: 900,
      passwordMinLength: 15,
      passwordMaxLength: 128,
      sessionTtlSeconds: 60,
      loginMaxAttempts: 10,
      loginWindowSeconds: 120,
    });
    expect(config.cookie).toEqual({
      refreshName: 'document_tracker_refresh',
      domain: undefined,
      refreshPath: '/api/v1/auth',
      name: '__Host-session',
      secure: true,
      sameSite: 'none',
      httpOnly: true,
      path: '/',
      maxAgeMs: 60000,
    });
  });

  it.each(['development', 'test', 'production'])(
    'requires DATABASE_URL even in %s',
    (NODE_ENV) => {
      expect(() => validateEnvironment({ NODE_ENV })).toThrow('DATABASE_URL');
    },
  );

  it.each([
    ['NODE_ENV', 'staging'],
    ['NODE_ENV', ''],
    ['HTTP_HOST', 'http://localhost'],
    ['APP_NAME', ''],
    ['APP_NAME', 'x'.repeat(101)],
    ['DATABASE_URL', ''],
    ['DATABASE_URL', '<database-url>'],
    ['DATABASE_URL', 'mysql://localhost/test'],
    ['DATABASE_URL', 'postgresql://localhost'],
    ['DATABASE_URL', 'postgresql://localhost/test#fragment'],
    ['DATABASE_URL', 'postgresql://localhost:99999/test'],
    ['AUTH_SESSION_TTL_SECONDS', '0'],
    ['AUTH_SESSION_TTL_SECONDS', '2592001'],
    ['AUTH_LOGIN_MAX_ATTEMPTS', '1.5'],
    ['AUTH_LOGIN_MAX_ATTEMPTS', '101'],
    ['AUTH_LOGIN_WINDOW_SECONDS', '-1'],
    ['AUTH_LOGIN_WINDOW_SECONDS', '86401'],
    ['COOKIE_NAME', 'invalid;cookie'],
    ['COOKIE_SECURE', 'yes'],
    ['COOKIE_SAME_SITE', 'invalid'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => validateEnvironment({ ...base, [key]: value })).toThrow(key);
  });

  it.each([
    { NODE_ENV: 'production', COOKIE_SECURE: 'false' },
    { COOKIE_SAME_SITE: 'none', COOKIE_SECURE: 'false' },
    { COOKIE_NAME: '__Host-session', COOKIE_SECURE: 'false' },
    { COOKIE_NAME: '__Secure-session', COOKIE_SECURE: 'false' },
  ])('rejects unsafe cookie combinations %p', (overrides) => {
    expect(() => validateEnvironment({ ...base, ...overrides })).toThrow(
      'COOKIE_SECURE',
    );
  });

  it('does not echo connection credentials in validation errors', () => {
    const credential = 'synthetic-sensitive-value';
    try {
      validateEnvironment({
        DATABASE_URL: `mysql://user:${credential}@localhost/test`,
      });
      throw new Error('Expected configuration failure');
    } catch (error) {
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).not.toContain(credential);
    }
  });
});
