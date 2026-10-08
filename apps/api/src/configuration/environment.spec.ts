import { validateEnvironment } from './environment';
import { storageTestRoot } from '../../test/configuration.fixture';
import { resolve } from 'node:path';

const base = {
  DATABASE_URL: 'postgresql://localhost/configuration_test',
  LOCAL_STORAGE_ROOT: storageTestRoot,
};

describe('environment configuration', () => {
  it('keeps RAG opt-in and validates its independent generation/budget configuration', () => {
    expect(validateEnvironment(base).rag.enabled).toBe(false);
    expect(() => validateEnvironment({ ...base, RAG_ENABLED: 'true' })).toThrow(
      'RAG_ENABLED',
    );
    const enabled = {
      ...base,
      RAG_ENABLED: 'true',
      SEMANTIC_SEARCH_ENABLED: 'true',
      SEMANTIC_SEARCH_MIN_SCORE: '0.8',
      EMBEDDING_ENABLED: 'true',
      EMBEDDING_ENDPOINT: 'https://embedding.example/embeddings',
      EMBEDDING_PROFILE_FINGERPRINT: 'a'.repeat(64),
      VECTOR_INDEX_ENABLED: 'true',
      QDRANT_URL: 'http://127.0.0.1:6333',
      GENERATION_ENDPOINT: 'https://generation.example/chat/completions',
      GENERATION_MODEL: 'separate-generation-model',
    };
    expect(validateEnvironment(enabled).generation.model).toBe(
      'separate-generation-model',
    );
    for (const [key, value] of [
      ['SEMANTIC_SEARCH_MIN_SCORE', ''],
      ['GENERATION_MODEL', ''],
      ['GENERATION_ENDPOINT', 'http://untrusted.example/chat'],
      ['GENERATION_ENDPOINT', 'https://example/chat?secret=x'],
      ['GENERATION_PROVIDER', 'unknown'],
      ['GENERATION_TEMPERATURE', 'NaN'],
      ['GENERATION_OUTPUT_TOKEN_FIELD', 'bad'],
      ['RAG_CONTEXT_TOKENS', '2048'],
      ['RAG_CONCURRENCY', '0'],
      ['RAG_TIMEOUT_MS', '120001'],
    ])
      expect(() => validateEnvironment({ ...enabled, [key]: value })).toThrow();
  });
  it('keeps search opt-in, requires both adapters and validates bounded policies and calibrated scores', () => {
    expect(validateEnvironment(base).semanticSearch.enabled).toBe(false);
    expect(validateEnvironment(base).semanticSearch.minScore).toBeUndefined();
    expect(() =>
      validateEnvironment({ ...base, SEMANTIC_SEARCH_ENABLED: 'true' }),
    ).toThrow('SEMANTIC_SEARCH_ENABLED');
    for (const value of ['NaN', 'Infinity', '1.01', '-1.01', ' '])
      expect(() =>
        validateEnvironment({ ...base, SEMANTIC_SEARCH_MIN_SCORE: value }),
      ).toThrow('SEMANTIC_SEARCH_MIN_SCORE');
    expect(
      validateEnvironment({ ...base, SEMANTIC_SEARCH_MIN_SCORE: '0.65' })
        .semanticSearch.minScore,
    ).toBe(0.65);
    for (const [name, value] of [
      ['SEMANTIC_SEARCH_MAX_MANIFESTS', '2001'],
      ['SEMANTIC_SEARCH_CONCURRENCY', '0'],
      ['SEMANTIC_SEARCH_TIMEOUT_MS', '60001'],
      ['SEMANTIC_SEARCH_USER_PER_MINUTE', '0'],
    ])
      expect(() => validateEnvironment({ ...base, [name]: value })).toThrow(
        name,
      );
  });
  it('lets query serving retain its exact old profile while ingestion enrolls a replacement', () => {
    const configured = {
      ...base,
      SEMANTIC_SEARCH_ENABLED: 'true',
      EMBEDDING_ENABLED: 'true',
      EMBEDDING_ENDPOINT: 'https://provider.example.invalid/embeddings',
      EMBEDDING_PROFILE_FINGERPRINT: 'a'.repeat(64),
      VECTOR_INDEX_ENABLED: 'true',
      QDRANT_URL: 'http://qdrant:6333',
      AI_INGESTION_ENABLED: 'true',
      AI_INGESTION_PROFILE_FINGERPRINT: 'b'.repeat(64),
    };
    expect(validateEnvironment(configured).embedding.profileFingerprint).toBe(
      'a'.repeat(64),
    );
    expect(() =>
      validateEnvironment({ ...configured, SEMANTIC_SEARCH_ENABLED: 'false' }),
    ).toThrow('AI_INGESTION_PROFILE_FINGERPRINT');
  });
  it('keeps automatic ingestion opt-in and validates its nonsecret profile identity', () => {
    expect(validateEnvironment(base).aiIngestion.enabled).toBe(false);
    expect(() =>
      validateEnvironment({ ...base, AI_INGESTION_ENABLED: 'true' }),
    ).toThrow('AI_INGESTION_PROFILE_FINGERPRINT');
    expect(() =>
      validateEnvironment({
        ...base,
        AI_INGESTION_ENABLED: 'true',
        AI_INGESTION_PROFILE_FINGERPRINT: 'invalid',
      }),
    ).toThrow('AI_INGESTION_PROFILE_FINGERPRINT');
    expect(
      validateEnvironment({
        ...base,
        AI_INGESTION_ENABLED: 'true',
        AI_INGESTION_PROFILE_FINGERPRINT: 'a'.repeat(64),
      }).aiIngestion.enabled,
    ).toBe(true);
    expect(() =>
      validateEnvironment({
        ...base,
        AI_INGESTION_ENABLED: 'true',
        AI_INGESTION_PROFILE_FINGERPRINT: 'a'.repeat(64),
        EMBEDDING_ENABLED: 'true',
        EMBEDDING_PROFILE_FINGERPRINT: 'b'.repeat(64),
        EMBEDDING_ENDPOINT: 'https://provider.example.invalid/v1/embeddings',
      }),
    ).toThrow('AI_INGESTION_PROFILE_FINGERPRINT');
  });
  it('validates private Qdrant origins, batch bounds and lease timeout budget', () => {
    expect(validateEnvironment(base).vectorIndex.enabled).toBe(false);
    const configured = {
      ...base,
      VECTOR_INDEX_ENABLED: 'true',
      QDRANT_URL: 'http://qdrant:6333',
    };
    expect(validateEnvironment(configured).vectorIndex).toMatchObject({
      enabled: true,
      batchSize: 64,
      timeoutMs: 10000,
    });
    for (const [key, value] of [
      ['QDRANT_URL', 'https://user:secret@qdrant:6333'],
      ['QDRANT_URL', 'http://qdrant/path'],
      ['QDRANT_URL', 'http://qdrant/?key=secret'],
      ['QDRANT_TIMEOUT_MS', '60001'],
      ['VECTOR_INDEX_BATCH_SIZE', '257'],
    ])
      expect(() =>
        validateEnvironment({ ...configured, [key]: value }),
      ).toThrow(key);
  });
  it('disables embeddings by default and validates private operational configuration', () => {
    expect(validateEnvironment(base).embedding.enabled).toBe(false);
    const configured = {
      ...base,
      EMBEDDING_ENABLED: 'true',
      EMBEDDING_ENDPOINT: 'https://provider.example.invalid/v1/embeddings',
      EMBEDDING_PROFILE_FINGERPRINT: 'a'.repeat(64),
      EMBEDDING_API_KEY: 'test-only-key',
    };
    expect(validateEnvironment(configured).embedding.batchSize).toBe(32);
    for (const [key, value] of [
      ['EMBEDDING_ENDPOINT', 'http://provider.example.invalid/v1/embeddings'],
      [
        'EMBEDDING_ENDPOINT',
        'https://user:secret@provider.example.invalid/v1/embeddings',
      ],
      [
        'EMBEDDING_ENDPOINT',
        'https://provider.example.invalid/v1/embeddings?key=secret',
      ],
      ['EMBEDDING_PROFILE_FINGERPRINT', 'invalid'],
      ['EMBEDDING_BATCH_SIZE', '0'],
      ['EMBEDDING_MAX_INPUT_TOKENS', '8193'],
      ['EMBEDDING_MAX_BATCH_TOKENS', '1'],
      ['EMBEDDING_TIMEOUT_MS', '60001'],
    ])
      expect(() =>
        validateEnvironment({ ...configured, [key]: value }),
      ).toThrow(key);
    expect(
      validateEnvironment({
        ...configured,
        EMBEDDING_ENDPOINT: 'http://local:8080/v1/embeddings',
        EMBEDDING_ALLOW_HTTP: 'true',
      }).embedding.enabled,
    ).toBe(true);
  });
  it('validates token chunk defaults, zero overlap, output bounds and lease budget', () => {
    expect(validateEnvironment(base).chunking).toEqual({
      chunkSize: 512,
      chunkOverlap: 64,
      maxChunks: 10000,
      maxOutputBytes: 40000000,
      timeoutMs: 30000,
    });
    expect(
      validateEnvironment({ ...base, CHUNK_OVERLAP_TOKENS: '0' }).chunking
        .chunkOverlap,
    ).toBe(0);
    for (const [key, value] of [
      ['CHUNK_SIZE_TOKENS', '0'],
      ['CHUNK_SIZE_TOKENS', '16385'],
      ['CHUNK_OVERLAP_TOKENS', '-1'],
      ['CHUNK_OVERLAP_TOKENS', '512'],
      ['CHUNK_MAX_COUNT', '100001'],
      ['CHUNK_MAX_OUTPUT_BYTES', '100000001'],
      ['CHUNK_TIMEOUT_MS', '90001'],
    ])
      expect(() => validateEnvironment({ ...base, [key]: value })).toThrow(key);
  });
  it('bounds PDF extraction against durable schema ceilings and the job lease', () => {
    expect(validateEnvironment(base).extraction).toEqual({
      maxBytes: 52428800,
      maxPages: 500,
      maxCharacters: 5000000,
      maxTextBytes: 20000000,
      timeoutMs: 30000,
      heapMb: 256,
    });
    expect(
      validateEnvironment({ ...base, UPLOAD_MAX_PAGES: '25' }).extraction
        .maxPages,
    ).toBe(25);
    for (const [key, value] of [
      ['PDF_EXTRACTION_MAX_BYTES', '209715201'],
      ['PDF_EXTRACTION_MAX_PAGES', '2001'],
      ['PDF_EXTRACTION_MAX_CHARACTERS', '5000001'],
      ['PDF_EXTRACTION_MAX_TEXT_BYTES', '20000001'],
      ['PDF_EXTRACTION_TIMEOUT_MS', '90001'],
      ['PDF_EXTRACTION_HEAP_MB', '1025'],
    ])
      expect(() => validateEnvironment({ ...base, [key]: value })).toThrow(key);
    expect(() =>
      validateEnvironment({
        ...base,
        WORKER_JOB_LEASE_MS: '1000',
        PDF_EXTRACTION_TIMEOUT_MS: '751',
      }),
    ).toThrow('PDF_EXTRACTION_TIMEOUT_MS');
  });
  it('validates optional disposable Redis progress settings without echoing credentials', () => {
    expect(validateEnvironment(base).progress).toEqual({
      url: undefined,
      ttlSeconds: 180,
      connectTimeoutMs: 500,
      commandTimeoutMs: 500,
    });
    expect(
      validateEnvironment({ ...base, REDIS_URL: 'redis://localhost:6379/2' })
        .progress.url,
    ).toBe('redis://localhost:6379/2');
    for (const value of [
      'http://localhost',
      'redis://localhost/?secret=1',
      'redis://localhost/#secret',
    ])
      expect(() => validateEnvironment({ ...base, REDIS_URL: value })).toThrow(
        'REDIS_URL',
      );
    for (const key of [
      'PROCESSING_PROGRESS_TTL_SECONDS',
      'REDIS_CONNECT_TIMEOUT_MS',
      'REDIS_COMMAND_TIMEOUT_MS',
    ])
      expect(() => validateEnvironment({ ...base, [key]: '0' })).toThrow(key);
  });
  it('validates bounded worker prefetch, lease, reconnect, and shutdown settings', () => {
    expect(validateEnvironment({ ...base }).worker).toEqual({
      prefetch: 2,
      jobLeaseMs: 120000,
      reconnectDelayMs: 1000,
      shutdownTimeoutMs: 30000,
    });
    for (const key of [
      'WORKER_PREFETCH',
      'WORKER_JOB_LEASE_MS',
      'WORKER_RECONNECT_DELAY_MS',
      'WORKER_SHUTDOWN_TIMEOUT_MS',
    ])
      expect(() => validateEnvironment({ ...base, [key]: '0' })).toThrow(key);
    expect(() =>
      validateEnvironment({ ...base, WORKER_PREFETCH: '17' }),
    ).toThrow('WORKER_PREFETCH');
  });
  it('validates bounded outbox polling, batch, and lease settings', () => {
    expect(validateEnvironment({ ...base }).outbox).toEqual({
      pollIntervalMs: 1000,
      batchSize: 10,
      leaseMs: 120000,
    });
    for (const key of [
      'OUTBOX_POLL_INTERVAL_MS',
      'OUTBOX_BATCH_SIZE',
      'OUTBOX_LEASE_MS',
    ]) {
      expect(() => validateEnvironment({ ...base, [key]: '0' })).toThrow(key);
      expect(() => validateEnvironment({ ...base, [key]: '-1' })).toThrow(key);
    }
    expect(() =>
      validateEnvironment({ ...base, OUTBOX_BATCH_SIZE: '101' }),
    ).toThrow('OUTBOX_BATCH_SIZE');
    expect(() =>
      validateEnvironment({ ...base, OUTBOX_LEASE_MS: '15000' }),
    ).toThrow('OUTBOX_LEASE_MS');
  });
  it('validates bounded processing recovery polling and batches', () => {
    expect(validateEnvironment({ ...base }).processingRecovery).toEqual({
      pollIntervalMs: 5000,
      batchSize: 10,
    });
    for (const key of [
      'PROCESSING_RECOVERY_POLL_INTERVAL_MS',
      'PROCESSING_RECOVERY_BATCH_SIZE',
    ])
      expect(() => validateEnvironment({ ...base, [key]: '0' })).toThrow(key);
    expect(() =>
      validateEnvironment({ ...base, PROCESSING_RECOVERY_BATCH_SIZE: '101' }),
    ).toThrow('PROCESSING_RECOVERY_BATCH_SIZE');
  });
  it('validates optional RabbitMQ URL and bounded transport timeouts', () => {
    const configuration = validateEnvironment({
      ...base,
      RABBITMQ_URL: 'amqp://user:password@localhost:5672/',
      RABBITMQ_CONNECT_TIMEOUT_MS: '250',
      RABBITMQ_CONFIRM_TIMEOUT_MS: '500',
    });
    expect(configuration.messaging).toEqual({
      url: 'amqp://user:password@localhost:5672/',
      connectTimeoutMs: 250,
      confirmTimeoutMs: 500,
    });
    for (const value of [
      'http://example.com',
      'amqp://localhost',
      'amqp://user:password@localhost/?secret=1',
    ])
      expect(() =>
        validateEnvironment({ ...base, RABBITMQ_URL: value }),
      ).toThrow('RABBITMQ_URL');
    expect(() =>
      validateEnvironment({ ...base, RABBITMQ_CONFIRM_TIMEOUT_MS: '0' }),
    ).toThrow('RABBITMQ_CONFIRM_TIMEOUT_MS');
  });
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
      application: { environment: 'development', name: 'QYVRA API' },
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
