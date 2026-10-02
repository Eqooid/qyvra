# 11 · Configuration and environment variables

[Guide index](README.md) · [Onboarding](14-development-workflow.md) · [Existing environment reference](../deployment/environment-variables.md)

Sources of truth are [API environment validation](../../apps/api/src/configuration/environment.ts), [typed settings](../../apps/api/src/configuration/settings.ts), [root template](../../.env.example), [web template](../../apps/web/.env.example), [Compose](../../docker-compose.yml), and [Dockerfiles](../../infrastructure/docker). Examples below are safe placeholders/defaults, never real credentials. Replace required placeholders; leave unused optional values omitted rather than copying angle brackets into configuration.

## Who loads what?

| Mode            | Configuration behavior                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host API        | `ConfigurationModule` loads repository-root `.env`; process environment can supply settings. Requires DATABASE_URL and private LOCAL_STORAGE_ROOT.      |
| Host web        | Next.js reads `apps/web/.env.local`, not root `.env`. Direct API origin needs credentialed CORS.                                                        |
| Host Prisma CLI | Reads process DATABASE_URL through `prisma.config.ts`; inject it separately. Client generation needs no live connection.                                |
| Compose         | Root `.env` is interpolation input. Only explicitly mapped values enter containers; arbitrary API settings added there are not automatically forwarded. |
| API tests       | Process NODE_ENV=test disables root `.env`; unit/HTTP fixtures provide settings. Real DB suites require TEST_DATABASE_URL.                              |
| Browser E2E     | Runner owns generated `.tools/qyvra-e2e.env` and an isolated project; do not substitute developer credentials.                                      |
| Production      | API production validation requires Secure cookies and HTTPS allowed origins. Checked-in Compose is local HTTP, not a finished public deployment.        |

There is no JWT/session signing secret. Cookie values are independent random opaque tokens stored only as hashes in PostgreSQL.

## API application, database and storage

| Variable                       | Required                    | Purpose/default or bound                                                                                  | Safe example                                          |
| ------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `NODE_ENV`                     | No                          | development/test/production; default development                                                          | `development`                                         |
| `APP_NAME`                     | No                          | Public name, max 100; default QYVRA API                                                               | `QYVRA API`                                       |
| `HTTP_HOST`                    | No                          | IPv4/IPv6 listener; default 0.0.0.0                                                                       | `127.0.0.1`                                           |
| `PORT`                         | No                          | API listener 1–65535; default 3001                                                                        | `3001`                                                |
| `HTTP_BODY_LIMIT_BYTES`        | No                          | JSON limit; default 16384, max 1048576                                                                    | `16384`                                               |
| `DATABASE_URL`                 | Yes for host API/migrations | PostgreSQL URL with host/database; Compose derives it                                                     | `postgresql://user:password@localhost:5432/qyvra` |
| `DATABASE_CONNECT_TIMEOUT_MS`  | No                          | Acquisition timeout; default 500, max 1000                                                                | `500`                                                 |
| `DATABASE_QUERY_TIMEOUT_MS`    | No                          | Query/statement timeout; default 500, max 1000                                                            | `500`                                                 |
| `DATABASE_POOL_SIZE`           | No                          | Per-process pool; default 5, max 20                                                                       | `5`                                                   |
| `STORAGE_PROVIDER`             | No                          | Only local is accepted                                                                                    | `local`                                               |
| `LOCAL_STORAGE_ROOT`           | Yes for API                 | Dedicated absolute private directory outside and not containing repository; Compose fixes /data/qyvra | `C:/BrainlessData`                                    |
| `UPLOAD_MAX_BYTES`             | No                          | Default 52428800 (50 MiB), max 209715200                                                                  | `52428800`                                            |
| `UPLOAD_MAX_PAGES`             | No                          | PDF pages; default 500, max 2000                                                                          | `500`                                                 |
| `UPLOAD_MAX_PIXELS`            | No                          | Image pixels; default 40000000, max 100000000                                                             | `40000000`                                            |
| `UPLOAD_TIMEOUT_MS`            | No                          | Receive timeout; default 120000, max 600000                                                               | `120000`                                              |
| `UPLOAD_INSPECTION_TIMEOUT_MS` | No                          | Per qpdf command; default 15000, max 60000                                                                | `15000`                                               |
| `UPLOAD_CONCURRENCY`           | No                          | Per-process receiving/inspection capacity; default 2, max 8                                               | `2`                                                   |
| `UPLOAD_QPDF_PATH`             | No                          | Trusted executable; defaults to qpdf from PATH                                                            | `qpdf`                                                |

Numeric API settings in this table are positive integers. Database URLs reject driver timeout/pool overrides such as `options`, `max`, or `statement_timeout`; use dedicated settings. The local storage root cannot be a filesystem root, traversal path or UNC share. Storage still validates ancestors at access time.

## Authentication and browser policy

| Variable                     | Required                                       | Purpose/default or bound                                                  | Safe example               |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- | -------------------------- |
| `CORS_ORIGINS`               | Needed for browser login/mutations with Origin | Comma-separated exact origins; omitted/blank disables cross-origin access | `http://localhost:3000`    |
| `CORS_CREDENTIALS`           | For cross-origin cookie UI                     | true/false; default false                                                 | `true`                     |
| `AUTH_PASSWORD_MIN_LENGTH`   | No                                             | Default 15; range 15–128 code points                                      | `15`                       |
| `AUTH_PASSWORD_MAX_LENGTH`   | No                                             | Default 128; range 64–1024 and at least minimum                           | `128`                      |
| `AUTH_SESSION_TTL_SECONDS`   | No                                             | Default 604800; max 2592000                                               | `604800`                   |
| `AUTH_REFRESH_TTL_SECONDS`   | No                                             | Default 2592000; max 7776000; at least session TTL                        | `2592000`                  |
| `AUTH_LOGIN_MAX_ATTEMPTS`    | No                                             | Persisted account failures; default 5, max 100                            | `5`                        |
| `AUTH_LOGIN_WINDOW_SECONDS`  | No                                             | Failure window; default 900, max 86400                                    | `900`                      |
| `AUTH_LOGIN_LOCKOUT_SECONDS` | No                                             | Lockout duration; default 900, max 86400                                  | `900`                      |
| `AUTH_RATE_WINDOW_SECONDS`   | No                                             | Process-local request window; default 60, max 3600                        | `60`                       |
| `AUTH_REGISTER_RATE_LIMIT`   | No                                             | Per-peer registration budget; default 10, max 1000                        | `10`                       |
| `AUTH_LOGIN_RATE_LIMIT`      | No                                             | Per-peer login/password-change budget; default 30, max 1000               | `30`                       |
| `AUTH_REFRESH_RATE_LIMIT`    | No                                             | Per-peer refresh budget; default 60, max 1000                             | `60`                       |
| `AUTH_GLOBAL_RATE_LIMIT`     | No                                             | Combined process auth budget; default 300, max 10000                      | `300`                      |
| `COOKIE_NAME`                | No                                             | Access cookie name, default document_tracker_session                      | `document_tracker_session` |
| `COOKIE_REFRESH_NAME`        | No                                             | Distinct refresh cookie name, default document_tracker_refresh            | `document_tracker_refresh` |
| `COOKIE_DOMAIN`              | No                                             | Omit for host-only; if supplied, lowercase DNS domain                     | `example.test`             |
| `COOKIE_PATH`                | No                                             | `/`, `/api`, or `/api/v1`; default `/`                                    | `/`                        |
| `COOKIE_REFRESH_PATH`        | No                                             | Same scopes plus `/api/v1/auth` (default)                                 | `/api/v1/auth`             |
| `COOKIE_SECURE`              | No, but true required in production            | Default false outside production; true in production                      | `false` for local HTTP     |
| `COOKIE_SAME_SITE`           | No                                             | lax/strict/none; default lax                                              | `lax`                      |

Origins must exclude paths, trailing slash, credentials and wildcards; production accepts only HTTPS. An origin allowlist is also the mutation/login security policy, even when requests are same-origin and CORS credentials are false. HttpOnly is fixed. Cookie names allow 1–64 letters/digits/underscores/hyphens. SameSite=None or secure-name prefixes require Secure; `__Host-` requires `/` and no Domain for that cookie.

## Compose, frontend and test inputs

| Variable                       | Required                    | Purpose/default                                                | Safe example                                               |
| ------------------------------ | --------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| `POSTGRES_USER`                | Compose                     | Initialization role; preserve for existing volume              | `qyvra`                                                |
| `POSTGRES_PASSWORD`            | Compose                     | Initialization password; no usable default                     | `<replace-with-local-password>`                            |
| `POSTGRES_DB`                  | Compose                     | Initialization database                                        | `qyvra`                                                |
| `POSTGRES_PORT`                | No                          | Host dev override only; default 5432                           | `5432`                                                     |
| `NGINX_PORT`                   | No                          | Loopback published port; default 8080                          | `8080`                                                     |
| `PUBLIC_APP_URL`               | No                          | Exact Compose browser origin; default http://localhost:8080    | `http://localhost:8080`                                    |
| `COMPOSE_PROJECT_NAME`         | No                          | Compose project/volume namespace; top-level name qyvra if omitted | `qyvra`                                                |
| `NEXT_PUBLIC_API_BASE_URL`     | For direct host API         | Browser API URL; default /api/v1; Docker build fixes /api/v1   | `http://localhost:3001/api/v1`                             |
| `NEXT_PUBLIC_UPLOAD_MAX_BYTES` | No                          | Browser UX limit; default 52428800, max 209715200              | `52428800`                                                 |
| `TEST_DATABASE_URL`            | Real API integration suites | Dedicated disposable, migrated database                        | `postgresql://user:password@localhost:5432/qyvra_test` |
| `E2E_SESSION_TTL`              | No                          | Browser override; default 3600; expiry runner uses 8           | `3600`                                                     |
| `HOSTNAME`                     | Docker fixed                | Standalone web listener, 0.0.0.0                               | `0.0.0.0`                                                  |
| `NEXT_TELEMETRY_DISABLED`      | Docker fixed                | Web build/runtime opt-out                                      | `1`                                                        |
| `NGINX_MAX_BODY_BYTES`         | Derived, not user input     | File limit + 1048576 overhead                                  | `53477376`                                                 |
| `NGINX_ENVSUBST_FILTER`        | Compose fixed               | Restrict template substitution to derived body limit           | `^NGINX_MAX_BODY_BYTES`                                    |
| `TMPDIR`, `TEMP`, `TMP`        | No                          | OS/Node temporary directory selection for inspection/tests     | `<private-temporary-directory>`                            |

[database-command.cjs](../../infrastructure/docker/database-command.cjs) URL-encodes POSTGRES credentials and constructs `DATABASE_URL` for `postgres:5432` in API/migration containers. A root host DATABASE_URL does not override that routing. Initialization values only initialize an empty PostgreSQL volume; editing them does not change an existing database password.

Compose explicitly maps NODE_ENV, HTTP/storage/CORS/cookie settings and upload resource limits. It does not forward every optional AUTH/DATABASE/COOKIE setting from `.env`. Inspect the service `environment` block before assuming an override is active.

Web public variables are embedded at build time and must contain no secrets. Changing Compose UPLOAD_MAX_BYTES also requires rebuilding web so its public UX limit stays aligned. Nginx derives its own body limit; the API separately limits actual bytes and multipart overhead. Restart host processes/recreate affected containers after settings change.
