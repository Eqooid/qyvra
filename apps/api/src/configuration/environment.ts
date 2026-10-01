import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { validateLocalStorageRoot } from '@brainless/storage';
import { ApiConfiguration } from './settings';

/**
 * @author Cristono Wijaya
 * @description Fails startup with the invalid setting name and validation rule, without exposing its value.
 * @tags Configuration
 * @param key - The environment variable name.
 * @param rule - The validation requirement to report without the supplied value.
 * @returns - Never returns; always throws a configuration error.
 * @throws Error - Reports only the setting name and validation rule.
 */
function invalid(key: string, rule: string): never {
  throw new Error(`Invalid configuration: ${key} ${rule}`);
}

/**
 * @author Cristono Wijaya
 * @description Reads a string setting or its fallback and rejects blanks, placeholders, newlines, and surrounding whitespace.
 * @tags Configuration
 * @param env - The raw settings source.
 * @param key - The environment variable name.
 * @param fallback - The default used only when the setting is absent.
 * @returns - The validated string.
 * @throws Error - The string is missing, blank, malformed, or contains a placeholder.
 */
function text(
  env: Record<string, unknown>,
  key: string,
  fallback?: string,
): string {
  const value = env[key] === undefined ? fallback : env[key];
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    /[<>\r\n]/.test(value)
  ) {
    return invalid(
      key,
      'is required and must be a nonblank string without placeholders or surrounding whitespace.',
    );
  }
  return value;
}

/**
 * @author Cristono Wijaya
 * @description Parses a positive, safe integer within the supplied maximum after validating the raw setting.
 * @tags Configuration
 * @param env - The raw settings source.
 * @param key - The environment variable name.
 * @param fallback - The default used only when the setting is absent.
 * @param max - The largest permitted integer.
 * @returns - The validated positive integer.
 * @throws Error - The value is not a positive safe integer within the allowed range.
 */
function integer(
  env: Record<string, unknown>,
  key: string,
  fallback: string,
  max: number,
): number {
  const value = text(env, key, fallback);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > max
  ) {
    return invalid(key, `must be an integer between 1 and ${max}.`);
  }
  return Number(value);
}

/**
 * @author Cristono Wijaya
 * @description Accepts only the literal strings true and false, avoiding implicit truthiness conversion.
 * @tags Configuration
 * @param env - The raw settings source.
 * @param key - The environment variable name.
 * @param fallback - The default used only when the setting is absent.
 * @returns - The parsed boolean.
 * @throws Error - The value is not the literal true or false string.
 */
function boolean(
  env: Record<string, unknown>,
  key: string,
  fallback: string,
): boolean {
  const value = text(env, key, fallback);
  if (value !== 'true' && value !== 'false')
    return invalid(key, 'must be true or false.');
  return value === 'true';
}

/**
 * @author Cristono Wijaya
 * @description Resolves a setting to one of the allowed values while preserving its TypeScript literal type.
 * @tags Configuration
 * @param env - The raw settings source.
 * @param key - The environment variable name.
 * @param fallback - The default used only when the setting is absent.
 * @param options - The permitted literal values.
 * @returns - The matching allowed value.
 * @throws Error - The value is not one of the permitted options.
 * @template T - The allowed string literal type preserved by validation.
 */
function choice<T extends string>(
  env: Record<string, unknown>,
  key: string,
  fallback: T,
  options: readonly T[],
): T {
  const value = text(env, key, fallback);
  const result = options.find((option) => option === value);
  if (result === undefined)
    return invalid(key, `must be one of: ${options.join(', ')}.`);
  return result;
}

/**
 * @author Cristono Wijaya
 * @description Validates environment values and cross-setting constraints before startup. Returns frozen configuration groups without opening database connections.
 * @tags Configuration
 * @param environment - Raw environment settings supplied by the configuration boundary.
 * @returns - The validated and frozen API configuration.
 * @throws Error - An environment value or a cross-setting constraint is invalid.
 * @example
 * ```ts
 * const configuration = validateEnvironment(environment);
 * ```
 */
export function validateEnvironment(
  environment: Record<string, unknown>,
): ApiConfiguration {
  const mode = choice(environment, 'NODE_ENV', 'development', [
    'development',
    'test',
    'production',
  ]);
  const port = integer(environment, 'PORT', '3001', 65535);
  const host = text(environment, 'HTTP_HOST', '0.0.0.0');
  if (isIP(host) === 0)
    invalid('HTTP_HOST', 'must be an IPv4 or IPv6 bind address.');
  const name = text(environment, 'APP_NAME', 'Brainless API');
  if (name.length > 100) invalid('APP_NAME', 'must be at most 100 characters.');
  const credentials = boolean(environment, 'CORS_CREDENTIALS', 'false');

  const origins =
    environment.CORS_ORIGINS === undefined ? '' : environment.CORS_ORIGINS;
  if (typeof origins !== 'string') {
    invalid('CORS_ORIGINS', 'must be a comma-separated list of origins.');
  }
  const corsOrigins =
    origins.trim() === ''
      ? []
      : origins.split(',').map((origin) => origin.trim());
  for (const origin of corsOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      invalid('CORS_ORIGINS', 'must contain only HTTP(S) origins.');
    }
    if (
      (mode === 'production' && url.protocol !== 'https:') ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      origin.includes('*')
    ) {
      invalid(
        'CORS_ORIGINS',
        'must contain exact HTTP(S) origins without paths, credentials, or wildcards; production requires HTTPS.',
      );
    }
  }

  const databaseUrl = text(environment, 'DATABASE_URL');
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    invalid('DATABASE_URL', 'must be a PostgreSQL connection URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !database.hostname ||
    !/^\/[^/]+$/.test(database.pathname) ||
    database.hash ||
    /\s/.test(databaseUrl) ||
    (database.port !== '' &&
      (!/^\d+$/.test(database.port) ||
        Number(database.port) < 1 ||
        Number(database.port) > 65535))
  ) {
    invalid(
      'DATABASE_URL',
      'must specify a PostgreSQL host, database name, and valid optional port without a fragment.',
    );
  }
  const driverOverrides = [
    'statement_timeout',
    'query_timeout',
    'connectionTimeoutMillis',
    'connect_timeout',
    'options',
    'max',
  ];
  if (driverOverrides.some((key) => database.searchParams.has(key))) {
    invalid(
      'DATABASE_URL',
      'must not override driver timeouts or pool settings; use DATABASE_* settings.',
    );
  }
  const rabbitmqUrl =
    environment.RABBITMQ_URL === undefined
      ? undefined
      : text(environment, 'RABBITMQ_URL');
  const redisUrl =
    environment.REDIS_URL === undefined
      ? undefined
      : text(environment, 'REDIS_URL');
  if (redisUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(redisUrl);
    } catch {
      invalid('REDIS_URL', 'must be a Redis connection URL.');
    }
    if (
      !['redis:', 'rediss:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.hash ||
      parsed.search ||
      !/^(?:|\/|\/[0-9]+)$/.test(parsed.pathname) ||
      /\s/.test(redisUrl)
    )
      invalid(
        'REDIS_URL',
        'must specify a Redis host and optional numeric database without query or fragment.',
      );
  }
  if (rabbitmqUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(rabbitmqUrl);
    } catch {
      invalid('RABBITMQ_URL', 'must be an AMQP connection URL.');
    }
    if (
      !['amqp:', 'amqps:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.username ||
      !parsed.password ||
      parsed.hash ||
      parsed.search ||
      /\s/.test(rabbitmqUrl)
    )
      invalid(
        'RABBITMQ_URL',
        'must specify an AMQP(S) host and credentials without query or fragment.',
      );
  }
  const passwordMinLength = integer(
    environment,
    'AUTH_PASSWORD_MIN_LENGTH',
    '15',
    128,
  );
  const passwordMaxLength = integer(
    environment,
    'AUTH_PASSWORD_MAX_LENGTH',
    '128',
    1024,
  );
  if (
    passwordMinLength < 15 ||
    passwordMaxLength < 64 ||
    passwordMaxLength < passwordMinLength
  ) {
    invalid(
      'AUTH_PASSWORD_MIN_LENGTH/AUTH_PASSWORD_MAX_LENGTH',
      'must have minimum >= 15, maximum >= 64, and minimum <= maximum.',
    );
  }
  const sessionTtlSeconds = integer(
    environment,
    'AUTH_SESSION_TTL_SECONDS',
    '604800',
    2592000,
  );
  const loginMaxAttempts = integer(
    environment,
    'AUTH_LOGIN_MAX_ATTEMPTS',
    '5',
    100,
  );
  const refreshTtlSeconds = integer(
    environment,
    'AUTH_REFRESH_TTL_SECONDS',
    '2592000',
    7776000,
  );
  if (refreshTtlSeconds < sessionTtlSeconds)
    invalid(
      'AUTH_REFRESH_TTL_SECONDS',
      'must be at least AUTH_SESSION_TTL_SECONDS.',
    );
  const loginLockoutSeconds = integer(
    environment,
    'AUTH_LOGIN_LOCKOUT_SECONDS',
    '900',
    86400,
  );
  const loginWindowSeconds = integer(
    environment,
    'AUTH_LOGIN_WINDOW_SECONDS',
    '900',
    86400,
  );
  const cookieName = text(
    environment,
    'COOKIE_NAME',
    'document_tracker_session',
  );
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookieName))
    invalid(
      'COOKIE_NAME',
      'must contain 1–64 letters, digits, underscores, or hyphens.',
    );
  const refreshName = text(
    environment,
    'COOKIE_REFRESH_NAME',
    'document_tracker_refresh',
  );
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(refreshName) || refreshName === cookieName)
    invalid(
      'COOKIE_REFRESH_NAME',
      'must be a valid cookie name distinct from COOKIE_NAME.',
    );
  const domain =
    environment.COOKIE_DOMAIN === undefined
      ? undefined
      : text(environment, 'COOKIE_DOMAIN');
  if (
    domain !== undefined &&
    (domain.length > 253 ||
      isIP(domain) !== 0 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        domain,
      ))
  )
    invalid(
      'COOKIE_DOMAIN',
      'must be a lowercase DNS domain without a scheme, port, leading dot or path; omit for host-only cookies.',
    );
  const path = choice(environment, 'COOKIE_PATH', '/', [
    '/',
    '/api',
    '/api/v1',
  ]);
  const refreshPath = choice(
    environment,
    'COOKIE_REFRESH_PATH',
    '/api/v1/auth',
    ['/', '/api', '/api/v1', '/api/v1/auth'],
  );
  if (
    (cookieName.startsWith('__Host-') &&
      (domain !== undefined || path !== '/')) ||
    (refreshName.startsWith('__Host-') &&
      (domain !== undefined || refreshPath !== '/'))
  )
    invalid(
      'COOKIE_DOMAIN/COOKIE_PATH/COOKIE_REFRESH_PATH',
      '__Host- cookies require host-only scope and Path=/.',
    );
  const secure = boolean(
    environment,
    'COOKIE_SECURE',
    mode === 'production' ? 'true' : 'false',
  );
  const sameSite = choice(environment, 'COOKIE_SAME_SITE', 'lax', [
    'lax',
    'strict',
    'none',
  ]);
  if (
    !secure &&
    (mode === 'production' ||
      sameSite === 'none' ||
      cookieName.startsWith('__Host-') ||
      refreshName.startsWith('__Host-') ||
      refreshName.startsWith('__Secure-') ||
      cookieName.startsWith('__Secure-'))
  ) {
    invalid(
      'COOKIE_SECURE',
      'must be true in production, with SameSite=None, or with a secure cookie-name prefix.',
    );
  }
  const storageProvider = choice(environment, 'STORAGE_PROVIDER', 'local', [
    'local',
  ]);
  const localRoot = text(environment, 'LOCAL_STORAGE_ROOT');
  let storageRoot: string;
  try {
    storageRoot = validateLocalStorageRoot(localRoot);
  } catch {
    return invalid(
      'LOCAL_STORAGE_ROOT',
      'must be a dedicated absolute local directory without traversal.',
    );
  }
  const repository = resolve(__dirname, '../../../../');
  const child = relative(repository, storageRoot);
  const parent = relative(storageRoot, repository);
  const outside = (value: string) =>
    isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`);
  if (!outside(child) || !outside(parent))
    invalid(
      'LOCAL_STORAGE_ROOT',
      'must be outside the repository and must not contain it.',
    );
  const outboxLeaseMs = integer(
    environment,
    'OUTBOX_LEASE_MS',
    '120000',
    3600000,
  );
  const rabbitmqConfirmTimeoutMs = integer(
    environment,
    'RABBITMQ_CONFIRM_TIMEOUT_MS',
    '10000',
    60000,
  );
  if (outboxLeaseMs <= rabbitmqConfirmTimeoutMs + 5000)
    invalid(
      'OUTBOX_LEASE_MS',
      'must exceed RABBITMQ_CONFIRM_TIMEOUT_MS by 5000 ms.',
    );
  return Object.freeze({
    progress: Object.freeze({
      url: redisUrl,
      ttlSeconds: integer(
        environment,
        'PROCESSING_PROGRESS_TTL_SECONDS',
        '180',
        3600,
      ),
      connectTimeoutMs: integer(
        environment,
        'REDIS_CONNECT_TIMEOUT_MS',
        '500',
        30000,
      ),
      commandTimeoutMs: integer(
        environment,
        'REDIS_COMMAND_TIMEOUT_MS',
        '500',
        30000,
      ),
    }),
    worker: Object.freeze({
      prefetch: integer(environment, 'WORKER_PREFETCH', '2', 16),
      jobLeaseMs: integer(
        environment,
        'WORKER_JOB_LEASE_MS',
        '120000',
        3600000,
      ),
      reconnectDelayMs: integer(
        environment,
        'WORKER_RECONNECT_DELAY_MS',
        '1000',
        60000,
      ),
      shutdownTimeoutMs: integer(
        environment,
        'WORKER_SHUTDOWN_TIMEOUT_MS',
        '30000',
        120000,
      ),
    }),
    outbox: Object.freeze({
      pollIntervalMs: integer(
        environment,
        'OUTBOX_POLL_INTERVAL_MS',
        '1000',
        60000,
      ),
      batchSize: integer(environment, 'OUTBOX_BATCH_SIZE', '10', 100),
      leaseMs: outboxLeaseMs,
    }),
    processingRecovery: Object.freeze({
      pollIntervalMs: integer(
        environment,
        'PROCESSING_RECOVERY_POLL_INTERVAL_MS',
        '5000',
        60000,
      ),
      batchSize: integer(
        environment,
        'PROCESSING_RECOVERY_BATCH_SIZE',
        '10',
        100,
      ),
    }),
    messaging: Object.freeze({
      url: rabbitmqUrl,
      connectTimeoutMs: integer(
        environment,
        'RABBITMQ_CONNECT_TIMEOUT_MS',
        '5000',
        30000,
      ),
      confirmTimeoutMs: rabbitmqConfirmTimeoutMs,
    }),
    upload: Object.freeze({
      maxBytes: integer(environment, 'UPLOAD_MAX_BYTES', '52428800', 209715200),
      maxPages: integer(environment, 'UPLOAD_MAX_PAGES', '500', 2000),
      maxPixels: integer(
        environment,
        'UPLOAD_MAX_PIXELS',
        '40000000',
        100000000,
      ),
      timeoutMs: integer(environment, 'UPLOAD_TIMEOUT_MS', '120000', 600000),
      inspectionTimeoutMs: integer(
        environment,
        'UPLOAD_INSPECTION_TIMEOUT_MS',
        '15000',
        60000,
      ),
      concurrency: integer(environment, 'UPLOAD_CONCURRENCY', '2', 8),
      qpdfPath: text(environment, 'UPLOAD_QPDF_PATH', 'qpdf'),
    }),
    storage: Object.freeze({
      provider: storageProvider,
      localRoot: storageRoot,
    }),
    application: Object.freeze({ environment: mode, name }),
    http: Object.freeze({
      host,
      port,
      bodyLimitBytes: integer(
        environment,
        'HTTP_BODY_LIMIT_BYTES',
        '16384',
        1048576,
      ),
    }),
    database: Object.freeze({
      url: databaseUrl,
      connectTimeoutMs: integer(
        environment,
        'DATABASE_CONNECT_TIMEOUT_MS',
        '500',
        1000,
      ),
      queryTimeoutMs: integer(
        environment,
        'DATABASE_QUERY_TIMEOUT_MS',
        '500',
        1000,
      ),
      poolSize: integer(environment, 'DATABASE_POOL_SIZE', '5', 20),
    }),
    cors: Object.freeze({
      origins: Object.freeze([...new Set(corsOrigins)]),
      credentials,
    }),
    authentication: Object.freeze({
      rateWindowSeconds: integer(
        environment,
        'AUTH_RATE_WINDOW_SECONDS',
        '60',
        3600,
      ),
      registerRateLimit: integer(
        environment,
        'AUTH_REGISTER_RATE_LIMIT',
        '10',
        1000,
      ),
      loginRateLimit: integer(environment, 'AUTH_LOGIN_RATE_LIMIT', '30', 1000),
      refreshRateLimit: integer(
        environment,
        'AUTH_REFRESH_RATE_LIMIT',
        '60',
        1000,
      ),
      globalRateLimit: integer(
        environment,
        'AUTH_GLOBAL_RATE_LIMIT',
        '300',
        10000,
      ),
      passwordMinLength,
      passwordMaxLength,
      sessionTtlSeconds,
      refreshTtlSeconds,
      loginLockoutSeconds,
      loginMaxAttempts,
      loginWindowSeconds,
    }),
    cookie: Object.freeze({
      name: cookieName,
      refreshName,
      domain,
      refreshPath,
      httpOnly: true as const,
      secure,
      sameSite,
      path,
      maxAgeMs: sessionTtlSeconds * 1000,
    }),
  });
}
