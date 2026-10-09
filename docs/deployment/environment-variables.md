# Environment variables

T10 adds API-only, opt-in standalone grounded answers. The validated `RAG_*` and
independent `GENERATION_*` settings, defaults, model/tokenizer/schema requirements
and data boundary are listed in [the RAG configuration reference](../phase-4-rag-answers.md#configuration).
`RAG_ENABLED=true` requires semantic search plus an explicit serving-profile score
floor. Generation keys must remain server-only. No default generation model is
selected; use a compatible tested deployment and keep its declared context window
within the actual model limit.

Docker defaults to project `qyvra`. Before switching an existing installation,
follow [the Docker namespace migration](../docker-rename.md) to preserve its data.

| Compose migration variable    | Default                   | Purpose                                                                      |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `POSTGRES_VOLUME_NAME`        | `<project>_postgres_data` | Explicit existing PostgreSQL volume name.                                    |
| `STORAGE_VOLUME_NAME`         | `<project>_storage_data`  | Explicit existing uploaded-file volume name.                                 |
| `RABBITMQ_VOLUME_NAME`        | `<project>_rabbitmq_data` | Explicit existing broker volume name.                                        |
| `PERSISTENT_VOLUMES_EXTERNAL` | `false`                   | Set `true` when mapping all three existing volumes; fails if any is absent.  |
| `RABBITMQ_HOSTNAME`           | `rabbitmq`                | Preserve the old container hostname when reusing persisted broker node data. |

[Documentation index](../README.md) | [Host setup](../development/getting-started.md) | [Compose](../compose.md)

Sources: [root example](../../.env.example), [web example](../../apps/web/.env.example),
[API validation](../../apps/api/src/configuration/environment.ts),
[Compose](../../docker-compose.yml) and [Dockerfiles](../../infrastructure/docker).
Examples below are public values or placeholders, never usable credentials.

## Loading and overrides

**Implemented T06 embedding settings:** see [exact defaults, validation and profile provisioning](../phase-4-embedding-generation.md#configuration-and-deployment).
`EMBEDDING_ENABLED`, `EMBEDDING_ENDPOINT`, `EMBEDDING_PROFILE_FINGERPRINT`, `EMBEDDING_API_KEY`,
`EMBEDDING_ALLOW_HTTP`, `EMBEDDING_BATCH_SIZE`, `EMBEDDING_MAX_INPUT_TOKENS`,
`EMBEDDING_MAX_BATCH_TOKENS`, `EMBEDDING_TIMEOUT_MS` and `EMBEDDING_SEND_DIMENSIONS`
are worker settings and, where applicable, query-embedding settings for enabled
search/RAG in the API. Compose passes provider secrets only to the relevant server
processes, never web/outbox. Embedding generation is disabled by default.
**Implemented T07 vector-index settings:** see [defaults and security](../phase-4-vector-indexing.md#failure-security-and-configuration).
`VECTOR_INDEX_ENABLED`, `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_ALLOW_HTTP`,
`QDRANT_TIMEOUT_MS` and `VECTOR_INDEX_BATCH_SIZE` are validated operational settings.
Compose forwards the URL/key to worker and enabled-query API configuration, with no public index port.
`QDRANT_VOLUME_NAME` controls the persistent derived-index volume name.
`QDRANT_VOLUME_EXTERNAL` defaults to `false` independently of
`PERSISTENT_VOLUMES_EXTERNAL`, so upgrades can create the new Qdrant volume while
protecting existing PostgreSQL/storage/RabbitMQ volumes. Set it to `true` only
when the named Qdrant volume already exists and is externally managed.
Generation configuration is implemented and independently configured in T10;
see the [actual generation settings](../phase-4-rag-answers.md#configuration).

**Phase 4 configuration contract:** the [original AI/RAG design](../phase-4-ai-rag.md#ai-boundaries-and-configuration--planned)
defines independent embedding/generation provider/model settings, immutable profile
and dimensions, allow-listed endpoints, timeouts, batching, concurrency, bounded
retry/cost limits and private Qdrant connection settings. Secrets are injected
separately and never embedded in profiles/prompts/payloads. These are logical
requirements; T01 itself added no `.env` values or validators. T04–T10 implemented
the exact validated settings recorded in their guides and the root example. Provider
selection is a supported-adapter contract, not a promise of arbitrary vendor support.

The API loads root `.env` in source and compiled execution, with process variables
winning. Process-level `NODE_ENV=test` disables that file. Prisma CLI does not load
root `.env`: inject `DATABASE_URL` for migrations. Next.js uses `apps/web/.env.local`;
its public values are embedded at build time. Never put secrets in `NEXT_PUBLIC_*`.

Compose uses root `.env` for interpolation and explicitly forwards only settings in
its YAML, not the entire file. The container launcher constructs DATABASE_URL from
POSTGRES_* with encoded credentials and host `postgres:5432`; root DATABASE_URL
cannot override it. Optional host auth/pool settings below require an explicit
Compose mapping to affect containers. The root example includes optional T04
broker settings; RabbitMQ is not yet wired into the HTTP API.
The separate outbox and worker processes use broker settings and the same
PostgreSQL credentials; no broker secret is forwarded to the HTTP service.

Required means required in the listed context. Defaults apply when omitted;
API blank/placeholder optional values generally fail validation. Blank CORS_ORIGINS
is the intentional exception. Remove unused optional entries instead of leaving
placeholders active. Initialization credentials affect only an empty PostgreSQL volume.

## Reference

### RabbitMQ transport (implemented in T04)

`RABBITMQ_URL` is optional for the current HTTP API and required for any process
that imports `MessagingModule` and publishes. It must be an `amqp:` or `amqps:`
URL with host and credentials; encode credential characters in the URL. The
default connection timeout is 5000 ms (`RABBITMQ_CONNECT_TIMEOUT_MS`, 1–30000);
the publisher-confirm timeout defaults to 10000 ms
(`RABBITMQ_CONFIRM_TIMEOUT_MS`, 1–60000). The canonical Compose broker uses
`RABBITMQ_USER` (local default `qyvra`) and `RABBITMQ_PASSWORD` (local
fallback to `POSTGRES_PASSWORD`); set a dedicated broker secret for deployment.
The development override binds `RABBITMQ_PORT` (5672) and
`RABBITMQ_MANAGEMENT_PORT` (15672) to loopback. `TEST_RABBITMQ_URL` selects an
isolated broker for the messaging integration test. No credentials are logged.

### Outbox dispatcher (implemented in T05)

`OUTBOX_POLL_INTERVAL_MS` defaults to 1000 (1–60000), `OUTBOX_BATCH_SIZE` to 10
(1–100), and `OUTBOX_LEASE_MS` to 120000 (1–3600000). The lease must exceed the
RabbitMQ confirm timeout by at least 5000 ms. These settings apply to the
independent `outbox` Compose service. Use a migrated disposable `TEST_DATABASE_URL`
and isolated `TEST_RABBITMQ_URL` for full integration tests. The HTTP service
does not need `RABBITMQ_URL` to serve document requests.

### Processing retry and recovery (implemented in T09)

The same independent `outbox` process polls PostgreSQL for expired worker leases
and due processing retries. `PROCESSING_RECOVERY_POLL_INTERVAL_MS` defaults to
5000 (1–60000) and `PROCESSING_RECOVERY_BATCH_SIZE` defaults to 10 (1–100).
The expired job lease is the stale threshold; `WORKER_JOB_LEASE_MS` controls its
duration. No in-memory retry timer or RabbitMQ retry counter is authoritative.

### Dedicated worker (implemented in T06)

`WORKER_PREFETCH` defaults to 2 (1–16) and bounds unacknowledged deliveries
per worker. `WORKER_JOB_LEASE_MS` defaults to 120000 (1–3600000) and is passed to
the T03 conditional job claim. `WORKER_RECONNECT_DELAY_MS` defaults to 1000
(1–60000) and delays reconnection after a transport failure or safe requeue.
`WORKER_SHUTDOWN_TIMEOUT_MS` defaults to 30000 (1–120000) and bounds the drain
of in-flight deliveries during shutdown. The worker requires the same validated
`DATABASE_URL` and `LOCAL_STORAGE_ROOT` as the API plus `RABBITMQ_URL`; Compose
constructs its database and broker URLs from private credentials. The worker
has no public HTTP port or processing-status endpoint.

| Variable                       | Purpose                                                          | Required                       | Default                                                    | Example                                | Used by                                          |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `NODE_ENV`                     | API mode; development/test/production                            | No                             | development                                                | `development`                          | API; Compose maps API mode, web fixed production |
| `APP_NAME`                     | Public API name, 1-100 characters                                | No                             | QYVRA API                                                  | `QYVRA API`                            | API                                              |
| `HTTP_HOST`                    | IPv4/IPv6 bind address                                           | No                             | 0.0.0.0                                                    | `127.0.0.1`                            | API; Compose fixes 0.0.0.0                       |
| `PORT`                         | Listening port, 1-65535                                          | No                             | 3001 API; 3000 web                                         | `3001`                                 | API; Compose fixes API 3001/web 3000             |
| `HTTP_BODY_LIMIT_BYTES`        | JSON body cap, 1-1048576 bytes                                   | No                             | 16384                                                      | `16384`                                | API                                              |
| `DATABASE_URL`                 | PostgreSQL URL with host/database; URL-encode credentials        | Yes for API/migrations         | None; Compose derives it from POSTGRES_*                   | `<postgresql-connection-url>`          | Host API, Prisma CLI; container launcher         |
| `DATABASE_CONNECT_TIMEOUT_MS`  | Pool acquisition timeout, 1-1000 ms                              | No                             | 500                                                        | `500`                                  | API                                              |
| `DATABASE_QUERY_TIMEOUT_MS`    | Driver/server query timeout, 1-1000 ms                           | No                             | 500                                                        | `500`                                  | API                                              |
| `DATABASE_POOL_SIZE`           | Connections per API process, 1-20                                | No                             | 5                                                          | `5`                                    | API                                              |
| `STORAGE_PROVIDER`             | Adapter selection; only local accepted                           | No                             | local                                                      | `local`                                | API; Compose fixes local                         |
| `LOCAL_STORAGE_ROOT`           | Absolute private directory outside/not containing repository     | Yes for API and worker         | None; Compose fixes /data/qyvra                            | `<absolute-private-storage-directory>` | API and worker/local storage                     |
| `UPLOAD_MAX_BYTES`             | Maximum file bytes, 1-209715200                                  | No                             | 52428800                                                   | `52428800`                             | API; Compose also web build/Nginx                |
| `UPLOAD_MAX_PAGES`             | PDF pages, 1-2000                                                | No                             | 500                                                        | `500`                                  | API; Compose maps                                |
| `UPLOAD_MAX_PIXELS`            | Image pixels, 1-100000000                                        | No                             | 40000000                                                   | `40000000`                             | API; Compose maps                                |
| `UPLOAD_TIMEOUT_MS`            | Receive timeout, 1-600000 ms                                     | No                             | 120000                                                     | `120000`                               | API; Compose maps                                |
| `UPLOAD_INSPECTION_TIMEOUT_MS` | Each qpdf command timeout, 1-60000 ms                            | No                             | 15000                                                      | `15000`                                | API; Compose maps                                |
| `UPLOAD_CONCURRENCY`           | Receiving/inspecting uploads per process, 1-8                    | No                             | 2                                                          | `2`                                    | API; Compose maps                                |
| `UPLOAD_QPDF_PATH`             | qpdf executable; invoked without a shell                         | No                             | qpdf                                                       | `qpdf`                                 | Host API; Docker installs qpdf on PATH           |
| `CORS_ORIGINS`                 | Comma-separated exact origins; HTTPS in production               | For browser login/mutations    | Empty allowlist                                            | `http://localhost:3000`                | API; Compose derives from PUBLIC_APP_URL         |
| `CORS_CREDENTIALS`             | Allow credentialed cross-origin browser access                   | For cross-origin cookies       | false                                                      | `true`                                 | API; Compose fixes false for same origin         |
| `AUTH_PASSWORD_MIN_LENGTH`     | Minimum Unicode code points, 15-128                              | No                             | 15                                                         | `15`                                   | API                                              |
| `AUTH_PASSWORD_MAX_LENGTH`     | Maximum code points, 64-1024 and >= minimum                      | No                             | 128                                                        | `128`                                  | API                                              |
| `AUTH_SESSION_TTL_SECONDS`     | Access lifetime, 1-2592000 seconds                               | No                             | 604800                                                     | `604800`                               | API                                              |
| `AUTH_REFRESH_TTL_SECONDS`     | Absolute refresh lifetime, 1-7776000 seconds; >= access lifetime | No                             | 2592000                                                    | `2592000`                              | API                                              |
| `AUTH_LOGIN_MAX_ATTEMPTS`      | Account attempts per window, 1-100                               | No                             | 5                                                          | `5`                                    | API                                              |
| `AUTH_LOGIN_WINDOW_SECONDS`    | Account failure window, 1-86400 seconds                          | No                             | 900                                                        | `900`                                  | API                                              |
| `AUTH_LOGIN_LOCKOUT_SECONDS`   | Account lockout, 1-86400 seconds                                 | No                             | 900                                                        | `900`                                  | API                                              |
| `AUTH_RATE_WINDOW_SECONDS`     | Process request-throttle window, 1-3600 seconds                  | No                             | 60                                                         | `60`                                   | API                                              |
| `AUTH_REGISTER_RATE_LIMIT`     | Registration requests per peer/window, 1-1000                    | No                             | 10                                                         | `10`                                   | API                                              |
| `AUTH_LOGIN_RATE_LIMIT`        | Shared login/password requests per peer/window, 1-1000           | No                             | 30                                                         | `30`                                   | API                                              |
| `AUTH_REFRESH_RATE_LIMIT`      | Refresh requests per peer/window, 1-1000                         | No                             | 60                                                         | `60`                                   | API                                              |
| `AUTH_GLOBAL_RATE_LIMIT`       | Combined process budget, 1-10000 requests/window                 | No                             | 300                                                        | `300`                                  | API                                              |
| `COOKIE_NAME`                  | Session name; 1-64 letters/digits/underscore/hyphen              | No                             | document_tracker_session                                   | `document_tracker_session`             | API                                              |
| `COOKIE_REFRESH_NAME`          | Distinct refresh cookie name, same syntax                        | No                             | document_tracker_refresh                                   | `document_tracker_refresh`             | API                                              |
| `COOKIE_DOMAIN`                | Lowercase DNS domain; omit for host-only                         | No                             | Unset (host-only)                                          | `app.example.test`                     | API                                              |
| `COOKIE_PATH`                  | Session scope: /, /api or /api/v1                                | No                             | /                                                          | `/`                                    | API; Compose fixes /                             |
| `COOKIE_REFRESH_PATH`          | Refresh scope: /, /api, /api/v1 or /api/v1/auth                  | No                             | /api/v1/auth                                               | `/api/v1/auth`                         | API; Compose fixes /api/v1/auth                  |
| `COOKIE_SECURE`                | Secure cookie policy, literal true/false                         | No; must be true in production | true in production, otherwise false; Compose default false | `false (local HTTP only)`              | API; Compose maps                                |
| `COOKIE_SAME_SITE`             | lax, strict or none                                              | No                             | lax                                                        | `lax`                                  | API; Compose fixes lax                           |
| `POSTGRES_USER`                | Database initialization role; preserve existing value            | Yes for Compose                | None (example uses qyvra)                                  | `qyvra`                                | Postgres image; API/migration launcher           |
| `POSTGRES_PASSWORD`            | Database initialization credential; preserve existing value      | Yes for Compose                | None                                                       | `<replace-with-a-local-password>`      | Postgres image; API/migration launcher           |
| `POSTGRES_DB`                  | Database initialization name; preserve existing value            | Yes for Compose                | None (example uses qyvra)                                  | `qyvra`                                | Postgres image; API/migration launcher           |
| `POSTGRES_PORT`                | Loopback database port in dev override                           | No                             | 5432                                                       | `5432`                                 | docker-compose.dev.yml only                      |
| `NGINX_PORT`                   | Loopback published HTTP port                                     | No                             | 8080                                                       | `8080`                                 | Compose                                          |
| `PUBLIC_APP_URL`               | Exact public browser origin; change with NGINX_PORT              | No                             | http://localhost:8080                                      | `http://localhost:8080`                | Compose API Origin allowlist                     |
| `COMPOSE_PROJECT_NAME`         | Compose project/volume namespace; keep stable                    | No                             | Top-level Compose name qyvra                               | `qyvra`                                | Docker Compose (or use -p)                       |
| `NEXT_PUBLIC_API_BASE_URL`     | Public browser API base including /api/v1                        | For direct host API            | /api/v1; Docker build fixes this                           | `http://localhost:3001/api/v1`         | Next.js browser build                            |
| `NEXT_PUBLIC_UPLOAD_MAX_BYTES` | Public UX size limit; align with API                             | No                             | 52428800; Compose build uses UPLOAD_MAX_BYTES              | `52428800`                             | Next.js browser build                            |
| `TEST_DATABASE_URL`            | Separately migrated isolated PostgreSQL database                 | For API integration tests      | None                                                       | `<isolated-test-postgresql-url>`       | API test:integration                             |
| `TMPDIR / TEMP / TMP`          | OS temporary staging directory; private disk with capacity       | No                             | Node OS temp selection                                     | `<private-temporary-directory>`        | Node/qpdf inspection and temporary-file tests    |
| `HOSTNAME`                     | Next standalone server bind address                              | Docker fixed                   | 0.0.0.0 in web image/Compose                               | `0.0.0.0`                              | Web standalone runtime                           |
| `NEXT_TELEMETRY_DISABLED`      | Next.js telemetry opt-out                                        | Docker fixed                   | 1 in web image                                             | `1`                                    | Web build/runtime                                |
| `NGINX_MAX_BODY_BYTES`         | Derived file limit plus 1048576 bytes multipart overhead         | Generated; do not set manually | UPLOAD_MAX_BYTES + 1048576                                 | `53477376`                             | Nginx entrypoint/template                        |
| `NGINX_ENVSUBST_FILTER`        | Restricts Nginx template substitutions                           | Compose fixed                  | ^NGINX_MAX_BODY_BYTES                                      | `^NGINX_MAX_BODY_BYTES`                | Official Nginx image entrypoint                  |

## Cross-setting rules

T05 [chunk configuration](../phase-4-chunk-generation.md#configuration-and-limits)
uses `CHUNK_SIZE_TOKENS=512`, `CHUNK_OVERLAP_TOKENS=64` (zero allowed, less than
size), `CHUNK_MAX_COUNT=10000`, `CHUNK_MAX_OUTPUT_BYTES=40000000` and
`CHUNK_TIMEOUT_MS=min(30000, half the worker lease)`, at most 75% of the lease.
Size is bounded to 16384 tokens; output ceilings to 100000 chunks/100000000 bytes.
Size/overlap are defaults for future run scheduling, not overrides of existing
immutable run snapshots. Compose maps all five settings to the worker.

PDF extraction settings are documented with ceilings in the
[T04 deployment contract](../phase-4-pdf-extraction.md#configuration-and-deployment-limits):
`PDF_EXTRACTION_MAX_BYTES`/`MAX_PAGES` inherit upload limits by default;
`PDF_EXTRACTION_MAX_CHARACTERS` defaults to 5,000,000,
`PDF_EXTRACTION_MAX_TEXT_BYTES` to 20,000,000, `PDF_EXTRACTION_HEAP_MB` to 256,
and `PDF_EXTRACTION_TIMEOUT_MS` to min(30,000, half the job lease), validated at
no more than 75% of `WORKER_JOB_LEASE_MS`. Compose supplies these to the worker
and bounds aggregate RSS with `WORKER_MEMORY_LIMIT` (default `2g`). Production
extraction requires the Linux socket-denying launcher; no unsandboxed fallback.

Disposable processing progress uses optional `REDIS_URL` (a `redis://` or
`rediss://` URL; credentials must come from deployment secrets),
`PROCESSING_PROGRESS_TTL_SECONDS` (1–3600, default 180),
`REDIS_CONNECT_TIMEOUT_MS` (1–30000, default 500), and
`REDIS_COMMAND_TIMEOUT_MS` (1–30000, default 500). Compose supplies the internal
Redis URL to API and worker without making it a required health dependency;
`REDIS_PORT` controls only the loopback port in the development override.
`TEST_REDIS_URL` enables real Redis progress integration cases against an isolated
test instance; omit it to skip only those optional progress cases.
No URL or credential is logged. If Redis is absent, job processing and status
continue without live progress. Redis persistence is disabled for the Compose
progress service.

- Origins exclude paths, trailing slashes, credentials and wildcards. Production
  requires HTTPS origins. The same-origin browser login still needs its Origin allowlisted.
- HttpOnly is fixed. SameSite=none and __Host-/__Secure- names require Secure=true.
  __Host- names additionally require Path=/ and no COOKIE_DOMAIN for that cookie.
- Database URLs cannot override driver timeout/pool parameters; use dedicated DATABASE_* settings.
- Keep upload limits aligned; changing Compose UPLOAD_MAX_BYTES requires rebuilding
  the web image. Nginx adds overhead; the API still enforces actual file bytes.
- There is no JWT/session signing secret: tokens are opaque and persisted as hashes.
- Process-local throttling does not trust forwarding headers. Proxied clients share
  the proxy peer's budget. See [deployment limitations](../compose.md#environment-and-cookies).

The isolated browser runner owns its generated `.tools/qyvra-e2e.env` and
[test Compose overrides](../../infrastructure/e2e/compose.yml). Its generated
credentials are not developer configuration; see [browser setup](../phase-1-browser-verification.md).

## T08 ingestion integration — Implemented

AI_INGESTION_ENABLED defaults false. When true, AI_INGESTION_PROFILE_FINGERPRINT must identify a provisioned immutable SQL profile; API startup checks it. Set identical chunk size/overlap on API and worker, enable worker embeddings/vector indexing first, and match its embedding fingerprint. Ingestion-only API operation needs no embedding or Qdrant secrets; enabling T09 search also configures server-side query embedding and Qdrant access. See [T08 configuration](../phase-4-ingestion.md#configuration-and-deployment) and the [current developer setup](../developer/versions/v1.3.0.md#development-deployment-and-operations).

## Phase 4 T09 semantic search

`SEMANTIC_SEARCH_ENABLED=false` keeps paid interactive work disabled. Enabling requires T06/T07 adapters and matching SQL serving profile. Validated `SEMANTIC_SEARCH_MIN_SCORE` is optional/profile calibrated; request deadline, active-manifest cap, concurrency and user/global per-minute budgets are documented in the [complete configuration table](../phase-4-semantic-search.md#configuration-and-deployment). Compose supports API-only `SEMANTIC_SEARCH_PROFILE_FINGERPRINT`; worker enrollment stays independently compatible.

## Phase 4 T10–T12 generation and release configuration

`RAG_ENABLED=false` remains the default. Enable generation independently from
embeddings using the [T10 configuration contract](../phase-4-rag-answers.md).
Provider keys belong only to server environments, never `NEXT_PUBLIC_*`, SQL profile
rows, prompts or vector payloads. Match the provisioned immutable embedding profile
across indexing and queries; a generation model has a separate identity.

The [T12 production review](../phase-4-verification.md#production-configuration-review)
distinguishes mandatory services/settings, optional Redis progress and fixture-only
HTTP/trust authentication. Its [recovery procedures](../phase-4-verification.md#operational-recovery)
preserve authoritative database/files and reuse durable embeddings after Qdrant loss.
