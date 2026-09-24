# Environment variables

[Documentation index](../README.md) | [Host setup](../development/getting-started.md) | [Compose](../compose.md)

Sources: [root example](../../.env.example), [web example](../../apps/web/.env.example),
[API validation](../../apps/api/src/configuration/environment.ts),
[Compose](../../docker-compose.yml) and [Dockerfiles](../../infrastructure/docker).
Examples below are public values or placeholders, never usable credentials.

## Loading and overrides

The API loads root `.env` in source and compiled execution, with process variables
winning. Process-level `NODE_ENV=test` disables that file. Prisma CLI does not load
root `.env`: inject `DATABASE_URL` for migrations. Next.js uses `apps/web/.env.local`;
its public values are embedded at build time. Never put secrets in `NEXT_PUBLIC_*`.

Compose uses root `.env` for interpolation and explicitly forwards only settings in
its YAML, not the entire file. The container launcher constructs DATABASE_URL from
POSTGRES_* with encoded credentials and host `postgres:5432`; root DATABASE_URL
cannot override it. Optional host auth/pool settings below require an explicit
Compose mapping to affect containers. No environment example change is needed.

Required means required in the listed context. Defaults apply when omitted;
API blank/placeholder optional values generally fail validation. Blank CORS_ORIGINS
is the intentional exception. Remove unused optional entries instead of leaving
placeholders active. Initialization credentials affect only an empty PostgreSQL volume.

## Reference

| Variable                       | Purpose                                                          | Required                       | Default                                                    | Example                                | Used by                                          |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `NODE_ENV`                     | API mode; development/test/production                            | No                             | development                                                | `development`                          | API; Compose maps API mode, web fixed production |
| `APP_NAME`                     | Public API name, 1-100 characters                                | No                             | Brainless API                                              | `Brainless API`                        | API                                              |
| `HTTP_HOST`                    | IPv4/IPv6 bind address                                           | No                             | 0.0.0.0                                                    | `127.0.0.1`                            | API; Compose fixes 0.0.0.0                       |
| `PORT`                         | Listening port, 1-65535                                          | No                             | 3001 API; 3000 web                                         | `3001`                                 | API; Compose fixes API 3001/web 3000             |
| `HTTP_BODY_LIMIT_BYTES`        | JSON body cap, 1-1048576 bytes                                   | No                             | 16384                                                      | `16384`                                | API                                              |
| `DATABASE_URL`                 | PostgreSQL URL with host/database; URL-encode credentials        | Yes for API/migrations         | None; Compose derives it from POSTGRES_*                   | `<postgresql-connection-url>`          | Host API, Prisma CLI; container launcher         |
| `DATABASE_CONNECT_TIMEOUT_MS`  | Pool acquisition timeout, 1-1000 ms                              | No                             | 500                                                        | `500`                                  | API                                              |
| `DATABASE_QUERY_TIMEOUT_MS`    | Driver/server query timeout, 1-1000 ms                           | No                             | 500                                                        | `500`                                  | API                                              |
| `DATABASE_POOL_SIZE`           | Connections per API process, 1-20                                | No                             | 5                                                          | `5`                                    | API                                              |
| `STORAGE_PROVIDER`             | Adapter selection; only local accepted                           | No                             | local                                                      | `local`                                | API; Compose fixes local                         |
| `LOCAL_STORAGE_ROOT`           | Absolute private directory outside/not containing repository     | Yes for API                    | None; Compose fixes /data/brainless                        | `<absolute-private-storage-directory>` | API/local storage                                |
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
| `POSTGRES_USER`                | Database initialization role; preserve existing value            | Yes for Compose                | None (example uses brainless)                              | `brainless`                            | Postgres image; API/migration launcher           |
| `POSTGRES_PASSWORD`            | Database initialization credential; preserve existing value      | Yes for Compose                | None                                                       | `<replace-with-a-local-password>`      | Postgres image; API/migration launcher           |
| `POSTGRES_DB`                  | Database initialization name; preserve existing value            | Yes for Compose                | None (example uses brainless)                              | `brainless`                            | Postgres image; API/migration launcher           |
| `POSTGRES_PORT`                | Loopback database port in dev override                           | No                             | 5432                                                       | `5432`                                 | docker-compose.dev.yml only                      |
| `NGINX_PORT`                   | Loopback published HTTP port                                     | No                             | 8080                                                       | `8080`                                 | Compose                                          |
| `PUBLIC_APP_URL`               | Exact public browser origin; change with NGINX_PORT              | No                             | http://localhost:8080                                      | `http://localhost:8080`                | Compose API Origin allowlist                     |
| `COMPOSE_PROJECT_NAME`         | Compose project/volume namespace; keep stable                    | No                             | Compose directory-derived project name                     | `brainless`                            | Docker Compose (or use -p)                       |
| `NEXT_PUBLIC_API_BASE_URL`     | Public browser API base including /api/v1                        | For direct host API            | /api/v1; Docker build fixes this                           | `http://localhost:3001/api/v1`         | Next.js browser build                            |
| `NEXT_PUBLIC_UPLOAD_MAX_BYTES` | Public UX size limit; align with API                             | No                             | 52428800; Compose build uses UPLOAD_MAX_BYTES              | `52428800`                             | Next.js browser build                            |
| `TEST_DATABASE_URL`            | Separately migrated isolated PostgreSQL database                 | For API integration tests      | None                                                       | `<isolated-test-postgresql-url>`       | API test:integration                             |
| `TMPDIR / TEMP / TMP`          | OS temporary staging directory; private disk with capacity       | No                             | Node OS temp selection                                     | `<private-temporary-directory>`        | Node/qpdf inspection and temporary-file tests    |
| `HOSTNAME`                     | Next standalone server bind address                              | Docker fixed                   | 0.0.0.0 in web image/Compose                               | `0.0.0.0`                              | Web standalone runtime                           |
| `NEXT_TELEMETRY_DISABLED`      | Next.js telemetry opt-out                                        | Docker fixed                   | 1 in web image                                             | `1`                                    | Web build/runtime                                |
| `NGINX_MAX_BODY_BYTES`         | Derived file limit plus 1048576 bytes multipart overhead         | Generated; do not set manually | UPLOAD_MAX_BYTES + 1048576                                 | `53477376`                             | Nginx entrypoint/template                        |
| `NGINX_ENVSUBST_FILTER`        | Restricts Nginx template substitutions                           | Compose fixed                  | ^NGINX_MAX_BODY_BYTES                                      | `^NGINX_MAX_BODY_BYTES`                | Official Nginx image entrypoint                  |

## Cross-setting rules

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

The isolated browser runner owns its generated `.tools/brainless-e2e.env` and
[test Compose overrides](../../infrastructure/e2e/compose.yml). Its generated
credentials are not developer configuration; see [browser setup](../phase-1-browser-verification.md).
