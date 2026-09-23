# Brainless API

The API currently provides the basic HTTP foundation and public application
information at `GET /api/v1`. It uses strict TypeScript, global DTO validation,
standard JSON envelopes, generated request IDs, and Nest shutdown hooks.

## Document metadata foundation

For streaming upload, install **qpdf** on the host and verify `qpdf --version`, or set
`UPLOAD_QPDF_PATH` to its executable. The API Docker image installs qpdf. Install API
dependencies again (`npm --prefix apps/api ci`) for Busboy and Sharp, then apply all
pending migrations with `npm --prefix packages/database run migrate:deploy` using an
injected `DATABASE_URL`. Run `npm --prefix apps/api run build` to generate/build shared
packages and the API. Existing database volumes must not be recreated or reset.

Keep `LOCAL_STORAGE_ROOT` outside the repository. Optional `UPLOAD_*` settings and
their defaults are documented in root `.env.example`; remove unchanged optional
placeholders to use defaults. Leave `UPLOAD_QPDF_PATH` omitted inside Docker so the
container uses its installed binary rather than a host executable path. Temporary
inspection uses OS TEMP/TMPDIR; keep it private and provision disk space for the
stored file plus inspection copy per concurrent upload. No upload files are public.

Send one PDF/JPEG/PNG as multipart `file`, required `title`, optional allowed metadata,
the session cookie, `X-CSRF-Protection: 1`, and a newly generated UUID `Idempotency-Key`.
Let the HTTP client generate the multipart Content-Type boundary. `tagIds` is a JSON
array of existing owned tag UUIDs. See [upload contract](../../docs/api.md#streaming-document-creation)
and [implementation/verification notes](../../docs/upload-implementation.md).

The later storage foundation adds `@brainless/storage` and required
`LOCAL_STORAGE_ROOT`; see [shared storage setup](../../packages/storage/README.md).
The root must be an absolute dedicated directory outside this repository. Provider
selection defaults to local. Metadata endpoints still do not perform file operations.

Authenticated list/detail/update, archive, restore and soft-delete endpoints are
available under `/api/v1/documents`; Swagger describes filters, cursor pagination,
safe response fields and transitions. Collection POST now streams one supported file
and creates its first immutable version. GET `/api/v1/documents/:documentId/download`
streams the highest owned version as a private attachment. Archived documents are
allowed; deleted/DELETING documents return 404. No query/body fields or old-version
selection is accepted. Missing objects return 503; no versions return 409.
Additional immutable uploads and paginated version list/detail are available under
`/api/v1/documents/:documentId/versions`. POST accepts only multipart `file`, with
the same upload security headers and validation. Apply migration
`20260915030000_version_upload_scope` and regenerate/build before restarting the API;
stop older API instances for this receipt-key schema transition. No new environment
settings are required. See [version contracts](../../docs/api.md#immutable-version-history)
and [verification](../../docs/versioning-implementation.md). Integration tests use isolated fixtures.
Referenced categories return 409 on deletion; deleting tags removes only their joins.

Apply `20260914050000_document_metadata` before startup, using an injected
`DATABASE_URL`: `npm --prefix packages/database run migrate:deploy` from the root.
Run database generation/build after pulling the schema. Authentication settings are
unchanged. For tests set an isolated `TEST_DATABASE_URL`,
apply migrations there with `DATABASE_URL` pointing to that same test database,
then run `npm --prefix apps/api run test:integration`. Never reset your database.

## Tags

GET/POST /api/v1/tags and PATCH/DELETE /api/v1/tags/:tagId require the existing
session cookie. Mutations require X-CSRF-Protection: 1 and a trusted browser Origin.
Names use the shared Categories normalization policy and per-owner case-insensitive
uniqueness. List/search uses optional q, limit (default 25, max 100), UUID cursor and
sort=id. Deletion is permanent; document joins do not exist yet. See docs/api.md
for the full contract. Apply migration 20260914030000_tags before serving these routes;
no new environment variables, dependencies or frontend pages are needed.

## Categories

Authenticated GET/POST /api/v1/categories and PATCH/DELETE
/api/v1/categories/:categoryId implement owned category CRUD. Mutations require
X-CSRF-Protection: 1 and a trusted browser Origin. Lists use cursor pagination;
category names are normalized and unique per user ignoring case. Deletion is
permanent for unused categories; no document reassignment exists yet. See
[the API contract](../../docs/api.md) for validation and envelopes.

Apply the new 20260914010000_categories migration with
`npm --prefix packages/database run migrate:deploy` from the repository root,
using the intended injected DATABASE_URL. Do not reset existing databases. No new
environment variables or frontend changes are required. The isolated integration
suite checks category ownership, concurrent duplicates, deletion and SQL constraints.

## Local registration

`POST /api/v1/auth/register` creates a local account without a session. See
[the API contract](../../docs/api.md) for normalization, password policy and responses.
Optional `AUTH_PASSWORD_MIN_LENGTH` and `AUTH_PASSWORD_MAX_LENGTH` default to
15 and 128 Unicode code points. Passwords are hashed with Argon2id before the
account transaction. Registration integration tests require an isolated migrated
`TEST_DATABASE_URL` and clean up only their generated test accounts.

## Profile and password settings

GET /api/v1/me returns the same safe profile as /auth/me. PATCH /api/v1/me accepts
only displayName, timezone and locale; PATCH /api/v1/me/password accepts
currentPassword and newPassword. Both require a valid session cookie,
X-CSRF-Protection: 1 and an allowlisted browser Origin. Password changes preserve
the current session and atomically revoke other owned sessions. The existing
password policy applies, and password changes share the login rate limit.
See [the API contract](../../docs/api.md) for validation and response details.
No additional environment settings or migrations are required. The PostgreSQL
integration suite includes real Argon2id verification, ownership and rollback tests.

## Configuration

Local login is available at `POST /api/v1/auth/login`. Apply pending migrations with
`npm --prefix ../../packages/database run migrate:deploy` from this directory using
your injected `DATABASE_URL`. The new login migration adds last-login/session metadata.
See [the login contract](../../docs/api.md) and root `.env.example` for lockout,
session/refresh lifetimes, cookie scope and browser Origin requirements.
`POST /api/v1/auth/refresh` rotates both cookies; `POST /api/v1/auth/logout` revokes
the current session and clears cookies idempotently. Both require
`X-CSRF-Protection: 1` and an allowlisted browser Origin. Apply pending migrations
to create consumed-refresh-token history. Serialize refresh calls: replay of a
consumed token revokes its session. Authenticated `POST /api/v1/auth/logout-all`
revokes every owned session and clears both cookies. Repeating it with revoked
credentials returns 401 with no further effects. It requires the same CSRF checks.

Session management provides `GET /api/v1/me/sessions`,
`DELETE /api/v1/me/sessions/:sessionId`, and `DELETE /api/v1/me/sessions/others`.
All require an authenticated session; DELETE also requires `X-CSRF-Protection: 1`
and trusted browser Origin. Listing is paginated and contains safe metadata only.
See [the API contract](../../docs/api.md) for expiration and idempotency rules.

`GET /api/v1/auth/me` requires the session cookie set by login and returns only the
authenticated public profile. `AuthModule` exports `SessionAuthGuard` and the typed
`CurrentUser` decorator through its public index. Apply the last-seen migration
before starting the API; it preserves existing activity timestamps under the new
`last_seen_at` column name. Validity is checked every request; activity writes are
limited to once per minute. Swagger includes the configured session cookie scheme.

Copy the repository-root `.env.example` to the repository-root `.env` and replace
its placeholders. The API loads that root `.env` in both source and compiled
execution; existing process environment variables take precedence. Set
`NODE_ENV=test` in the process environment to ignore local `.env` files. Jest does
this automatically. Unit/HTTP tests stub the database; the separate integration
suite connects using `TEST_DATABASE_URL`. Production can use injected environment
variables without an `.env`.

| Variable                      | Meaning                                                              | Default when omitted                    |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `NODE_ENV`                    | `development`, `test`, or `production`                               | `development`                           |
| `APP_NAME`                    | Nonblank application name, at most 100 characters                    | `Brainless API`                         |
| `HTTP_HOST`                   | IPv4 or IPv6 bind address                                            | `0.0.0.0`                               |
| `PORT`                        | Integer from 1 to 65535                                              | `3001`                                  |
| `DATABASE_URL`                | PostgreSQL URL with host and database; connected before HTTP startup | **Required in all environments**        |
| `DATABASE_CONNECT_TIMEOUT_MS` | Connection acquisition timeout, 1–1000 ms                            | `500`                                   |
| `DATABASE_QUERY_TIMEOUT_MS`   | Driver/server SQL timeout, 1–1000 ms                                 | `500`                                   |
| `DATABASE_POOL_SIZE`          | Connections per API process, 1–20                                    | `5`                                     |
| `CORS_ORIGINS`                | Comma-separated exact HTTP(S) origins                                | Empty; CORS disabled                    |
| `CORS_CREDENTIALS`            | Literal `true` or `false`                                            | `false`                                 |
| `AUTH_SESSION_TTL_SECONDS`    | Integer 1–2592000                                                    | `604800`                                |
| `AUTH_LOGIN_MAX_ATTEMPTS`     | Integer 1–100                                                        | `5`                                     |
| `AUTH_LOGIN_WINDOW_SECONDS`   | Integer 1–86400                                                      | `900`                                   |
| `COOKIE_NAME`                 | 1–64 letters, digits, underscores, or hyphens                        | `document_tracker_session`              |
| `COOKIE_SECURE`               | Literal `true` or `false`                                            | `true` in production; otherwise `false` |
| `COOKIE_SAME_SITE`            | `lax`, `strict`, or `none`                                           | `lax`                                   |

Origins cannot include paths, trailing slashes, user information, query strings,
fragments, or wildcards. Invalid settings stop startup. No frontend origin is
built into the application. CORS does not replace authorization.

Missing required values, empty optional values (except CORS origins), placeholders,
and invalid values stop application initialization before it listens. Errors name
the setting and rule without echoing values or connection credentials. Unrelated
operating-system environment variables are ignored.

Cookies are always HttpOnly and default to host-only scope. Session path defaults
to `/`, refresh path to `/api/v1/auth`; validated overrides are documented in
`.env.example`. Their maximum ages derive from their database expiration times.
Secure cookies are mandatory in production, for `SameSite=none`, and for
`__Host-`/`__Secure-` names. Login issues both cookies and enforces account lockout.
No JWT signing secret is required. Refresh preserves the absolute refresh deadline.

Import `ConfigurationModule` and inject `ConfigurationService` to access the
readonly `application`, `http`, `database`, `cors`, `authentication`, and `cookie`
sections. For example, `configuration.http.port` is a number and
`configuration.cookie.sameSite` is a string union. Configuration is validated once
at provider initialization and frozen. Only the configuration boundary reads
`process.env`; consumers must not use raw environment lookups or generic
string-key configuration access. Do not log configuration objects.

## Health and OpenAPI

- `GET /api/v1/health/live`: process responsiveness, HTTP 200.
- `GET /api/v1/health/ready`: HTTP 200 after bootstrap, HTTP 503 during shutdown.
- `/api/v1/docs/`: Swagger UI; `/api/v1/docs-json`: OpenAPI JSON for all implemented routes.

Readiness queries PostgreSQL through the shared Prisma client and checks application
lifecycle state. It returns HTTP 503 on connection/query failure or shutdown.
Connection acquisition and SQL execution each default to 500 ms. Liveness performs
no dependency I/O. Configure probe callers with a short HTTP timeout that accounts
for both limits. All health responses are non-cacheable
and use the standard envelopes and correlation IDs; see `docs/api.md`.

## Logging and request context

Import `ObservabilityModule` to inject `RequestContext` and `StructuredLogger` in
application services. `context.correlationId` remains available after awaited
operations; it is undefined outside a request. Use structured events such as
`logger.event('info', 'operation.completed', { count: 1 })`. Logs are JSON lines on
stdout and automatically include the current correlation ID.

Send a UUID in `X-Correlation-Id` (or the legacy `X-Request-Id`). The API returns
both headers with the selected/generated ID, also used by response envelopes.
See `docs/api.md` for validity rules and error mappings. Request logs omit bodies,
headers, query strings, and URLs; logging redacts sensitive structured fields and
known credential text patterns. Never log configuration objects, arbitrary user
content, or secrets in free-form messages.

## Development and verification commands

Use Node 24+. From the repository root, initialize the shared package before the API:

```sh
npm --prefix packages/database ci
npm --prefix packages/storage ci
npm --prefix packages/storage run build
npm --prefix packages/database run build
npm --prefix apps/api ci
```

Copy `.env.example` to `.env`, replace the PostgreSQL/HTTP placeholders, and remove
unused optional entries to take their defaults. Set `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, and `POSTGRES_PORT` for Compose. Use matching
URL-encoded credentials and `127.0.0.1:<POSTGRES_PORT>` in the host API's
`DATABASE_URL`. Then run from the root:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait postgres
# Inject DATABASE_URL into this shell first; Prisma CLI does not read root .env.
npm --prefix packages/database run migrate:deploy
npm --prefix apps/api run start:dev
```

Compose persists PostgreSQL data in a named volume. Existing database initialization
values are not changed by editing `.env`; never use volume deletion or reset to
apply schema changes. The authentication schema migration belongs in
`packages/database` and must be applied with
`npm --prefix packages/database run migrate:deploy` after
injecting `DATABASE_URL` into that command's environment. Prisma CLI generation
requires no credentials and does not automatically load the root `.env`.

Import `DatabaseModule` and inject `PrismaService` in API infrastructure code.
Its `client` is the reusable shared Prisma client; startup connects and runs
`SELECT 1`, and shutdown disconnects cleanly. Other processes can use the shared
package's `createPrismaClient` factory with validated settings.

Run commands from `apps/api` using npm (use `npm.cmd` if PowerShell blocks npm.ps1):

```sh
npm ci
npm run start:dev
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
npm run start:prod
```

The e2e suite uses production HTTP setup with a database test double and closes
each application after testing. Run PostgreSQL connectivity and authentication integration tests by injecting
`TEST_DATABASE_URL` for an isolated PostgreSQL database, then running
`npm run test:integration`. That command intentionally fails when the URL is absent;
it does not silently skip tests or use the development database. Apply migrations
to that isolated test database first. The suite checks connectivity/timeouts and
authentication schema constraints. Constraint cases use transactions and roll back
their rows; tests never reset, truncate, or drop tables. API build/typecheck/test commands generate and build the shared
client first; `npm run database:generate` is also available explicitly.

## Phase 1 review and security setup

Phase 1 is **not complete**. The API implements the foundation and local authentication;
see [the acceptance review](../../docs/phase-1-review.md) for missing Phase 1 features.
There is no root package manager command: use the independent npm lockfiles in
`packages/database` and `apps/api`. The empty `pnpm-workspace.yml` is not an active workspace.

Optional `.env.example` entries containing placeholders must be replaced or removed,
not left verbatim. The minimum API configuration is `DATABASE_URL` and
`LOCAL_STORAGE_ROOT`; Compose also needs
its `POSTGRES_*` initialization values. Do not paste credentials into commands saved
in shell history. For PowerShell, inject the URL from a secret manager or obtain it
without echo using:

```powershell
$databaseCredential = Get-Credential -Message 'Enter any label as username and the PostgreSQL URL as password'
$env:DATABASE_URL = $databaseCredential.GetNetworkCredential().Password
npm.cmd --prefix packages/database run migrate:deploy
Remove-Item Env:DATABASE_URL
```

The API itself reads root `.env`. Apply all seven existing migrations **before** startup;
readiness checks connectivity, not migration history. Never reset an existing database.
For integration tests, provision a separate disposable PostgreSQL database, inject
`TEST_DATABASE_URL` and use that same URL as `DATABASE_URL` when deploying migrations.
Integration tests write and clean up their own random accounts/sessions; only the
connectivity checks are read-only. Never point the suite at development or production data.

Development/test default to HTTP-compatible cookies; production requires HTTPS and
Secure cookies, enables HSTS and requires HTTPS CORS origins. Host-only cookies are
recommended. Set CORS_ORIGINS to the exact UI origin (including same-origin browser
login), and CORS_CREDENTIALS=true for cross-origin cookie requests. Browser clients
must send credentials and the documented CSRF header for session mutations.

Request limits use AUTH_RATE_WINDOW_SECONDS (default 60), AUTH_REGISTER_RATE_LIMIT
(10), AUTH_LOGIN_RATE_LIMIT (30), AUTH_REFRESH_RATE_LIMIT (60), and the combined
AUTH_GLOBAL_RATE_LIMIT (300). These are per process; forwarding headers are not
trusted and proxy clients share the proxy's budget. Multiple replicas require an
additional shared edge limiter. HTTP_BODY_LIMIT_BYTES defaults to 16384; compressed
and non-JSON bodies are rejected. Other settings and bounds are in `.env.example`.

Full verification from the repository root:

```sh
npm --prefix packages/database run validate
npm --prefix packages/database run generate
npm --prefix packages/database run format
npm --prefix packages/database run format:check
npm --prefix packages/database run lint
npm --prefix packages/database run typecheck
npm --prefix packages/database run build
npm --prefix apps/api run format
npm --prefix apps/api run format:check
npm --prefix apps/api run lint
npm --prefix apps/api run typecheck
npm --prefix apps/api test -- --runInBand
npm --prefix apps/api run test:e2e -- --runInBand
# Requires the isolated, migrated TEST_DATABASE_URL described above:
npm --prefix apps/api run test:integration
npm --prefix apps/api run build
```

`start:prod` requires the preceding production build (including the shared database
client). It does not set NODE_ENV: inject NODE_ENV=production explicitly for deployment.
Compose now configures the complete Nginx/web/API/PostgreSQL stack and one-shot
migrations, with private `storage_data:/data/brainless`. See [Compose setup](../../docs/compose.md).
Docker runtime verification, TLS, cloud object storage and CI remain outstanding. The audit still reports dependency vulnerabilities; do not treat
test success as approval for public production deployment.

## Current Phase 1 review and local verification

The latest review is recorded in [the Phase 1 acceptance review](../../docs/phase-1-review.md).
Passing the authentication tests does not complete the document-management MVP.
Prisma readiness verifies connectivity only; deploy all seven existing migrations
before starting the API. Use `npm ci` in `packages/database`, build that package,
then use `npm ci` in `apps/api`; there is no root npm workspace command.

The minimal API `.env` contains a real local `DATABASE_URL`. Omit unused optional
placeholder entries to take defaults. For Compose, supply `POSTGRES_USER`,
`POSTGRES_PASSWORD`, and `POSTGRES_DB`; omit `POSTGRES_PORT` to use 5432.
For the browser, also configure its exact origin in `CORS_ORIGINS` and set
`CORS_CREDENTIALS=true`. Allowed origins can read the `Retry-After` response header
on HTTP 429. This does not change rate budgets or bypass Origin/CSRF checks.

Before database integration tests, check `docker version` reports a running Linux
engine. Provision an isolated PostgreSQL database, inject its URL as `DATABASE_URL`
for `migrate:deploy`, and as `TEST_DATABASE_URL` for `test:integration`. The suite
deliberately fails when that setting is absent. Do not reuse development or
production data. Docker Compose validation alone does not prove database availability.

Keep the current Compose project name and named volume. Initialization variables
do not change credentials inside an existing database; do not delete volumes or
reset the database to resolve configuration errors.
