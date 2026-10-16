import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { validateLocalStorageRoot } from '@qyvra/storage';
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

/** Shared API/worker policy; compatible private services may legitimately omit keys. */
function providerEndpoint(
  environment: Record<string, unknown>,
  operation: 'EMBEDDING' | 'GENERATION',
  value: string,
): URL {
  const key = `${operation}_ENDPOINT`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(key, 'must be an absolute HTTP(S) URL.');
  }
  const allowHttp = boolean(environment, `${operation}_ALLOW_HTTP`, 'false');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp))
  )
    invalid(
      key,
      'requires HTTPS (or explicit HTTP opt-in), without credentials, query or fragment.',
    );
  if (url.hostname.replace(/\.$/, '') === 'api.openai.com') {
    if (url.protocol !== 'https:')
      invalid(key, 'official OpenAI requires HTTPS.');
    text(environment, `${operation}_API_KEY`);
  }
  return url;
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
  const name = text(environment, 'APP_NAME', 'QYVRA API');
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
      'must contain 1Ã¢â‚¬â€œ64 letters, digits, underscores, or hyphens.',
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
  const chunkSize = integer(environment, 'CHUNK_SIZE_TOKENS', '512', 16384);
  const overlap = text(environment, 'CHUNK_OVERLAP_TOKENS', '64');
  if (
    !/^\d+$/.test(overlap) ||
    !Number.isSafeInteger(Number(overlap)) ||
    Number(overlap) >= chunkSize
  )
    invalid(
      'CHUNK_OVERLAP_TOKENS',
      'must be an integer from zero to less than CHUNK_SIZE_TOKENS.',
    );
  const leaseMs = integer(
    environment,
    'WORKER_JOB_LEASE_MS',
    '120000',
    3600000,
  );
  const embeddingEnabled = boolean(environment, 'EMBEDDING_ENABLED', 'false');
  const embeddingTokenizerPath = environment.EMBEDDING_TOKENIZER_PATH
    ? text(environment, 'EMBEDDING_TOKENIZER_PATH')
    : undefined;
  if (embeddingTokenizerPath && !isAbsolute(embeddingTokenizerPath))
    invalid(
      'EMBEDDING_TOKENIZER_PATH',
      'must be an absolute operator-owned file path.',
    );
  const embeddingEndpoint = embeddingEnabled
    ? text(environment, 'EMBEDDING_ENDPOINT')
    : undefined;
  const embeddingFingerprint = embeddingEnabled
    ? text(environment, 'EMBEDDING_PROFILE_FINGERPRINT')
    : undefined;
  if (embeddingFingerprint && !/^[0-9a-f]{64}$/.test(embeddingFingerprint))
    invalid(
      'EMBEDDING_PROFILE_FINGERPRINT',
      'must be a SHA-256 profile fingerprint.',
    );
  if (embeddingEndpoint) {
    providerEndpoint(environment, 'EMBEDDING', embeddingEndpoint);
  }
  const embeddingMaxTokens = integer(
    environment,
    'EMBEDDING_MAX_INPUT_TOKENS',
    '8191',
    8192,
  );
  const embeddingBatchTokens = integer(
    environment,
    'EMBEDDING_MAX_BATCH_TOKENS',
    '100000',
    300000,
  );
  if (embeddingBatchTokens < embeddingMaxTokens)
    invalid(
      'EMBEDDING_MAX_BATCH_TOKENS',
      'must be at least EMBEDDING_MAX_INPUT_TOKENS.',
    );
  const vectorEnabled = boolean(environment, 'VECTOR_INDEX_ENABLED', 'false');
  const vectorUrl = vectorEnabled ? text(environment, 'QDRANT_URL') : undefined;
  if (vectorUrl) {
    let parsed: URL;
    try {
      parsed = new URL(vectorUrl);
    } catch {
      return invalid('QDRANT_URL', 'must be an absolute HTTP(S) origin.');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    )
      return invalid(
        'QDRANT_URL',
        'must be an HTTP(S) origin without credentials, paths, or query.',
      );
    if (
      mode === 'production' &&
      parsed.protocol !== 'https:' &&
      !boolean(environment, 'QDRANT_ALLOW_HTTP', 'false')
    )
      return invalid(
        'QDRANT_ALLOW_HTTP',
        'must explicitly allow a private HTTP deployment, or use TLS.',
      );
  }
  const keywordEnrollmentEnabled = boolean(
    environment,
    'SEARCH_ENROLLMENT_ENABLED',
    'false',
  );
  const searchGenerationFingerprint = keywordEnrollmentEnabled
    ? text(environment, 'SEARCH_GENERATION_FINGERPRINT')
    : '';
  if (
    keywordEnrollmentEnabled &&
    !/^[0-9a-f]{64}$/.test(searchGenerationFingerprint)
  )
    invalid(
      'SEARCH_GENERATION_FINGERPRINT',
      'must identify a provisioned immutable search generation.',
    );
  const elasticEnabled = boolean(environment, 'ELASTICSEARCH_ENABLED', 'false');
  const keywordEnabled = boolean(
    environment,
    'KEYWORD_SEARCH_ENABLED',
    'false',
  );
  const keywordFingerprint = keywordEnabled
    ? text(environment, 'KEYWORD_SEARCH_GENERATION_FINGERPRINT')
    : '';
  if (
    keywordEnabled &&
    (!elasticEnabled || !/^[0-9a-f]{64}$/.test(keywordFingerprint))
  )
    invalid(
      'KEYWORD_SEARCH_GENERATION_FINGERPRINT',
      'requires Elasticsearch and a compatible serving fingerprint.',
    );
  const elasticPrefix = text(
    environment,
    'ELASTICSEARCH_INDEX_PREFIX',
    'qyvra-search',
  );
  if (
    !/^qyvra-search(?:-[a-z0-9]+)*$/.test(elasticPrefix) ||
    elasticPrefix.length > 40
  )
    invalid(
      'ELASTICSEARCH_INDEX_PREFIX',
      'must be a bounded qyvra-search namespace.',
    );
  const elasticSchema = integer(
    environment,
    'ELASTICSEARCH_SCHEMA_VERSION',
    '1',
    1,
  );
  const elasticHttp = boolean(environment, 'ELASTICSEARCH_ALLOW_HTTP', 'false');
  const elasticUrl = elasticEnabled
    ? text(environment, 'ELASTICSEARCH_URL')
    : undefined;
  const elasticValue = (key: string) =>
    elasticEnabled && environment[key] ? text(environment, key) : undefined;
  const elasticUsername = elasticValue('ELASTICSEARCH_USERNAME');
  const elasticPassword = elasticValue('ELASTICSEARCH_PASSWORD');
  const elasticPasswordFile = elasticValue('ELASTICSEARCH_PASSWORD_FILE');
  const elasticKey = elasticValue('ELASTICSEARCH_API_KEY');
  const elasticKeyFile = elasticValue('ELASTICSEARCH_API_KEY_FILE');
  const elasticCa = elasticValue('ELASTICSEARCH_CA_FILE');
  if (elasticEnabled) {
    let endpoint: URL;
    try {
      endpoint = new URL(elasticUrl!);
    } catch {
      return invalid(
        'ELASTICSEARCH_URL',
        'must be an explicit HTTP(S) endpoint.',
      );
    }
    if (
      !['https:', 'http:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    )
      invalid(
        'ELASTICSEARCH_URL',
        'must not contain credentials, query, fragment or path.',
      );
    const host = endpoint.hostname.replace(/^\[|\]$/g, '');
    const privateHost =
      host === 'localhost' ||
      host === '::1' ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host) ||
      (/^f[cd][0-9a-f:]+$/i.test(host) && isIP(host) === 6) ||
      /^elasticsearch(?:-[a-z0-9]+)*$/.test(host) ||
      /\.(local|internal)$/.test(host);
    if (
      endpoint.protocol === 'http:' &&
      (mode === 'production' || !elasticHttp || !privateHost)
    )
      invalid(
        'ELASTICSEARCH_URL',
        'requires authenticated TLS; isolated development HTTP needs explicit allowance.',
      );
    if (
      (elasticPassword && elasticPasswordFile) ||
      (elasticKey && elasticKeyFile) ||
      !!(elasticKey || elasticKeyFile) ===
        !!(elasticUsername || elasticPassword || elasticPasswordFile) ||
      (!(elasticKey || elasticKeyFile) &&
        !(elasticUsername && (elasticPassword || elasticPasswordFile)))
    )
      invalid(
        'ELASTICSEARCH_AUTH',
        'requires exactly one complete Basic or API-key credential.',
      );
    for (const [key, path] of [
      ['ELASTICSEARCH_PASSWORD_FILE', elasticPasswordFile],
      ['ELASTICSEARCH_API_KEY_FILE', elasticKeyFile],
      ['ELASTICSEARCH_CA_FILE', elasticCa],
    ])
      if (path && !isAbsolute(path))
        invalid(key!, 'must be an absolute server-only file path.');
    if (elasticCa && endpoint.protocol !== 'https:')
      invalid('ELASTICSEARCH_CA_FILE', 'requires HTTPS.');
  }
  const elasticTimeout = integer(
    environment,
    'ELASTICSEARCH_TIMEOUT_MS',
    '10000',
    60000,
  );
  const elasticRequestBytes = integer(
    environment,
    'ELASTICSEARCH_MAX_REQUEST_BYTES',
    '1048576',
    1048576,
  );
  const elasticResponseBytes = integer(
    environment,
    'ELASTICSEARCH_MAX_RESPONSE_BYTES',
    '4194304',
    8388608,
  );
  const elasticBulkSize = integer(
    environment,
    'ELASTICSEARCH_BULK_SIZE',
    '100',
    100,
  );
  const elasticMaxScopes = integer(
    environment,
    'ELASTICSEARCH_MAX_SCOPES',
    '100',
    100,
  );
  const elasticConcurrency = integer(
    environment,
    'ELASTICSEARCH_CONCURRENCY',
    '4',
    16,
  );
  const ingestionEnabled = boolean(
    environment,
    'AI_INGESTION_ENABLED',
    'false',
  );
  const ingestionFingerprint = ingestionEnabled
    ? text(environment, 'AI_INGESTION_PROFILE_FINGERPRINT')
    : undefined;
  if (ingestionFingerprint && !/^[0-9a-f]{64}$/.test(ingestionFingerprint))
    invalid(
      'AI_INGESTION_PROFILE_FINGERPRINT',
      'must identify an immutable embedding profile.',
    );
  const searchEnabled = boolean(
    environment,
    'SEMANTIC_SEARCH_ENABLED',
    'false',
  );
  if (
    ingestionEnabled &&
    embeddingEnabled &&
    !searchEnabled &&
    ingestionFingerprint !== embeddingFingerprint
  )
    invalid(
      'AI_INGESTION_PROFILE_FINGERPRINT',
      'must match the enabled embedding profile.',
    );
  if (searchEnabled && (!embeddingEnabled || !vectorEnabled))
    invalid(
      'SEMANTIC_SEARCH_ENABLED',
      'requires configured embeddings and Qdrant.',
    );
  const scoreText =
    environment.SEMANTIC_SEARCH_MIN_SCORE === undefined ||
    environment.SEMANTIC_SEARCH_MIN_SCORE === ''
      ? undefined
      : text(environment, 'SEMANTIC_SEARCH_MIN_SCORE');
  const minScore =
    scoreText === undefined || scoreText === '' ? undefined : Number(scoreText);
  if (
    minScore !== undefined &&
    (!Number.isFinite(minScore) ||
      minScore < -1 ||
      minScore > 1 ||
      !scoreText?.trim())
  )
    invalid(
      'SEMANTIC_SEARCH_MIN_SCORE',
      'must be a calibrated cosine score in [-1,1].',
    );
  const ragEnabled = boolean(environment, 'RAG_ENABLED', 'false');
  if (ragEnabled && (!searchEnabled || minScore === undefined))
    invalid(
      'RAG_ENABLED',
      'requires semantic search and an explicitly calibrated SEMANTIC_SEARCH_MIN_SCORE.',
    );
  const generationProvider = text(
    environment,
    'GENERATION_PROVIDER',
    'openai-compatible',
  );
  const generationTokenizer = text(
    environment,
    'GENERATION_TOKENIZER',
    'o200k_base',
  );
  if (
    generationTokenizer !== 'cl100k_base' &&
    generationTokenizer !== 'o200k_base' &&
    generationTokenizer !== 'huggingface-json'
  )
    invalid(
      'GENERATION_TOKENIZER',
      'must match the provider: cl100k_base/o200k_base or huggingface-json.',
    );
  if (
    generationProvider !== 'openai-compatible' &&
    generationProvider !== 'ollama'
  )
    invalid('GENERATION_PROVIDER', 'must be openai-compatible or ollama.');
  if (
    (generationProvider === 'ollama') !==
    (generationTokenizer === 'huggingface-json')
  )
    invalid('GENERATION_TOKENIZER', 'must match the configured provider.');
  const generationTokenizerPath = environment.GENERATION_TOKENIZER_PATH
    ? text(environment, 'GENERATION_TOKENIZER_PATH')
    : undefined;
  if (generationTokenizerPath && !isAbsolute(generationTokenizerPath))
    invalid(
      'GENERATION_TOKENIZER_PATH',
      'must be an absolute operator-provisioned path.',
    );
  if (ragEnabled && generationProvider === 'ollama' && !generationTokenizerPath)
    invalid('GENERATION_TOKENIZER_PATH', 'is required for Ollama generation.');
  const generationEndpoint = ragEnabled
    ? text(environment, 'GENERATION_ENDPOINT')
    : undefined;
  if (generationEndpoint) {
    const url = providerEndpoint(environment, 'GENERATION', generationEndpoint);
    if (generationProvider === 'ollama' && !url.pathname.endsWith('/api/chat'))
      invalid('GENERATION_ENDPOINT', 'must end with /api/chat for Ollama.');
  }
  const outputField = text(
    environment,
    'GENERATION_OUTPUT_TOKEN_FIELD',
    'max_completion_tokens',
  );
  if (outputField !== 'max_completion_tokens' && outputField !== 'max_tokens')
    invalid(
      'GENERATION_OUTPUT_TOKEN_FIELD',
      'must be max_completion_tokens or max_tokens.',
    );
  const temperature = Number(text(environment, 'GENERATION_TEMPERATURE', '0'));
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1)
    invalid('GENERATION_TEMPERATURE', 'must be between 0 and 1.');
  const contextTokens = integer(
    environment,
    'RAG_CONTEXT_TOKENS',
    '8192',
    32768,
  );
  const maxOutputTokens = integer(
    environment,
    'GENERATION_MAX_OUTPUT_TOKENS',
    '1024',
    4096,
  );
  if (contextTokens <= maxOutputTokens + 1024)
    invalid(
      'RAG_CONTEXT_TOKENS',
      'must reserve output plus at least 1024 input/envelope tokens.',
    );
  return Object.freeze({
    rag: Object.freeze({
      enabled: ragEnabled,
      maxSources: integer(environment, 'RAG_MAX_SOURCES', '8', 20),
      perDocument: integer(environment, 'RAG_PER_DOCUMENT_SOURCES', '3', 20),
      contextTokens,
      timeoutMs: integer(environment, 'RAG_TIMEOUT_MS', '60000', 120000),
      concurrency: integer(environment, 'RAG_CONCURRENCY', '2', 32),
      perUserPerMinute: integer(environment, 'RAG_USER_PER_MINUTE', '10', 300),
      globalPerMinute: integer(
        environment,
        'RAG_GLOBAL_PER_MINUTE',
        '100',
        10000,
      ),
    }),
    generation: Object.freeze({
      tokenizer: generationTokenizer,
      provider: generationProvider,
      tokenizerPath: generationTokenizerPath,
      think: boolean(environment, 'GENERATION_THINK', 'false'),
      model: ragEnabled ? text(environment, 'GENERATION_MODEL') : undefined,
      endpoint: generationEndpoint,
      apiKey:
        ragEnabled && environment.GENERATION_API_KEY
          ? text(environment, 'GENERATION_API_KEY')
          : undefined,
      timeoutMs: integer(environment, 'GENERATION_TIMEOUT_MS', '25000', 60000),
      maxOutputTokens,
      temperature,
      outputTokenField: outputField,
    }),
    semanticSearch: Object.freeze({
      enabled: searchEnabled,
      minScore,
      maxManifests: integer(
        environment,
        'SEMANTIC_SEARCH_MAX_MANIFESTS',
        '250',
        2000,
      ),
      timeoutMs: integer(
        environment,
        'SEMANTIC_SEARCH_TIMEOUT_MS',
        '35000',
        60000,
      ),
      concurrency: integer(environment, 'SEMANTIC_SEARCH_CONCURRENCY', '4', 32),
      perUserPerMinute: integer(
        environment,
        'SEMANTIC_SEARCH_USER_PER_MINUTE',
        '30',
        300,
      ),
      globalPerMinute: integer(
        environment,
        'SEMANTIC_SEARCH_GLOBAL_PER_MINUTE',
        '300',
        10000,
      ),
    }),
    hybridSearch: Object.freeze({
      enabled: (() => {
        const enabled = boolean(environment, 'HYBRID_SEARCH_ENABLED', 'false');
        if (enabled && (!keywordEnabled || !searchEnabled))
          invalid(
            'HYBRID_SEARCH_ENABLED',
            'requires keyword and semantic search.',
          );
        return enabled;
      })(),
    }),
    keywordSearch: Object.freeze({
      enabled: keywordEnabled,
      generationFingerprint: keywordFingerprint,
      timeoutMs: integer(
        environment,
        'KEYWORD_SEARCH_TIMEOUT_MS',
        '10000',
        60000,
      ),
      maxScopes: (() => {
        const max = integer(
          environment,
          'KEYWORD_SEARCH_MAX_SCOPES',
          String(elasticMaxScopes),
          100,
        );
        if (max > elasticMaxScopes)
          invalid(
            'KEYWORD_SEARCH_MAX_SCOPES',
            'must not exceed ELASTICSEARCH_MAX_SCOPES.',
          );
        return max;
      })(),
      rawHitLimit: integer(
        environment,
        'KEYWORD_SEARCH_RAW_HIT_LIMIT',
        '200',
        200,
      ),
      concurrency: integer(environment, 'KEYWORD_SEARCH_CONCURRENCY', '4', 32),
      perUserPerMinute: integer(
        environment,
        'KEYWORD_SEARCH_USER_PER_MINUTE',
        '30',
        300,
      ),
      globalPerMinute: integer(
        environment,
        'KEYWORD_SEARCH_GLOBAL_PER_MINUTE',
        '300',
        10000,
      ),
    }),
    searchEnrollment: Object.freeze({
      enabled: keywordEnrollmentEnabled,
      generationFingerprint: searchGenerationFingerprint,
    }),
    elasticsearch: Object.freeze({
      enabled: elasticEnabled,
      url: elasticUrl,
      username: elasticUsername,
      password: elasticPassword,
      passwordFile: elasticPasswordFile,
      apiKey: elasticKey,
      apiKeyFile: elasticKeyFile,
      caFile: elasticCa,
      indexPrefix: elasticPrefix,
      schemaVersion: elasticSchema as 1,
      timeoutMs: elasticTimeout,
      maxRequestBytes: elasticRequestBytes,
      maxResponseBytes: elasticResponseBytes,
      bulkSize: elasticBulkSize,
      maxScopes: elasticMaxScopes,
      concurrency: elasticConcurrency,
    }),
    aiIngestion: Object.freeze({
      enabled: ingestionEnabled,
      profileFingerprint: ingestionFingerprint,
    }),
    vectorIndex: Object.freeze({
      enabled: vectorEnabled,
      url: vectorUrl,
      apiKey:
        vectorEnabled && environment.QDRANT_API_KEY
          ? text(environment, 'QDRANT_API_KEY')
          : undefined,
      batchSize: integer(environment, 'VECTOR_INDEX_BATCH_SIZE', '64', 256),
      timeoutMs: integer(
        environment,
        'QDRANT_TIMEOUT_MS',
        String(
          Math.min(
            10000,
            Math.max(
              1,
              Math.floor(
                integer(environment, 'WORKER_JOB_LEASE_MS', '120000', 3600000) /
                  2,
              ),
            ),
          ),
        ),
        Math.max(
          1,
          Math.floor(
            integer(environment, 'WORKER_JOB_LEASE_MS', '120000', 3600000) / 2,
          ),
        ),
      ),
    }),
    embedding: Object.freeze({
      enabled: embeddingEnabled,
      endpoint: embeddingEndpoint,
      profileFingerprint: embeddingFingerprint,
      apiKey:
        embeddingEnabled && environment.EMBEDDING_API_KEY
          ? text(environment, 'EMBEDDING_API_KEY')
          : undefined,
      batchSize: integer(environment, 'EMBEDDING_BATCH_SIZE', '32', 128),
      maxInputTokens: embeddingMaxTokens,
      maxBatchTokens: embeddingBatchTokens,
      timeoutMs: integer(
        environment,
        'EMBEDDING_TIMEOUT_MS',
        String(Math.min(30000, Math.floor(leaseMs / 2))),
        Math.max(1, Math.floor(leaseMs / 2)),
      ),
      sendDimensions: boolean(environment, 'EMBEDDING_SEND_DIMENSIONS', 'true'),
      tokenizerPath: embeddingTokenizerPath,
    }),
    chunking: Object.freeze({
      chunkSize,
      chunkOverlap: Number(overlap),
      maxChunks: integer(environment, 'CHUNK_MAX_COUNT', '10000', 100000),
      maxOutputBytes: integer(
        environment,
        'CHUNK_MAX_OUTPUT_BYTES',
        '40000000',
        100000000,
      ),
      timeoutMs: integer(
        environment,
        'CHUNK_TIMEOUT_MS',
        String(Math.min(30000, Math.max(1, Math.floor(leaseMs * 0.5)))),
        Math.max(1, Math.floor(leaseMs * 0.75)),
      ),
    }),
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
    extraction: Object.freeze({
      maxBytes: integer(
        environment,
        'PDF_EXTRACTION_MAX_BYTES',
        String(integer(environment, 'UPLOAD_MAX_BYTES', '52428800', 209715200)),
        209715200,
      ),
      maxPages: integer(
        environment,
        'PDF_EXTRACTION_MAX_PAGES',
        String(integer(environment, 'UPLOAD_MAX_PAGES', '500', 2000)),
        2000,
      ),
      maxCharacters: integer(
        environment,
        'PDF_EXTRACTION_MAX_CHARACTERS',
        '5000000',
        5000000,
      ),
      maxTextBytes: integer(
        environment,
        'PDF_EXTRACTION_MAX_TEXT_BYTES',
        '20000000',
        20000000,
      ),
      timeoutMs: integer(
        environment,
        'PDF_EXTRACTION_TIMEOUT_MS',
        String(
          Math.min(
            30000,
            Math.max(
              1,
              Math.floor(
                integer(environment, 'WORKER_JOB_LEASE_MS', '120000', 3600000) *
                  0.5,
              ),
            ),
          ),
        ),
        Math.max(
          1,
          Math.floor(
            integer(environment, 'WORKER_JOB_LEASE_MS', '120000', 3600000) *
              0.75,
          ),
        ),
      ),
      heapMb: integer(environment, 'PDF_EXTRACTION_HEAP_MB', '256', 1024),
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
      searchDeliveryEnabled: boolean(
        environment,
        'SEARCH_OUTBOX_DELIVERY_ENABLED',
        elasticEnabled ? 'true' : 'false',
      ),
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
