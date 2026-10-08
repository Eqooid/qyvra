# QYVRA local Docker Compose

[Documentation index](README.md) | [Environment reference](deployment/environment-variables.md) |
[Host onboarding](development/getting-started.md) | [v1.0.0 snapshot](releases/v1.0.0.md) |
[v1.1.0 snapshot](releases/v1.1.0.md)

## Status and boundaries

Current product candidate: **v1.3.0**; [T13 preparation](phase-4-release-preparation.md)
and [release snapshot](releases/v1.3.0.md) record the untagged status and exact limits.
Compose continues to build local project/service images, without release-specific
registry tags or OCI version labels. No registry push or production deploy is part
of release preparation. Start/recovery commands below preserve original volumes.

T10 grounded answers are opt-in through the API service's `RAG_*` and `GENERATION_*`
settings. Generation credentials/model/endpoint are independent of embeddings and
are not supplied to the worker or browser. Enable only after selecting the SQL
serving profile and calibrating `SEMANTIC_SEARCH_MIN_SCORE`. No additional service,
volume or public Qdrant port is introduced. See [T10 configuration and provider
deployment requirements](phase-4-rag-answers.md#configuration).

T06 implements [embedding generation and checkpoint configuration](phase-4-embedding-generation.md#configuration-and-deployment).
The worker receives embedding configuration and its optional bearer secret; builds and
ordinary startup require no provider key. Embeddings default to disabled. Configure an exact
persisted profile fingerprint and operator-controlled endpoint before explicit processing.
The bridge permits outbound requests; production egress must allow only approved providers.
[T07 private Qdrant indexing and cleanup](phase-4-vector-indexing.md),
[T09 retrieval](phase-4-semantic-search.md) and [T10 RAG](phase-4-rag-answers.md)
are implemented. Opt-in search/RAG also supplies server-only query embedding and
generation configuration to the API. Provider secrets never go to outbox or web.

**T04 PDF extraction is implemented** in the existing worker image.
**T05 chunk generation is implemented** in
the same image with the pinned local tiktoken WASM/rank files; no additional native
toolchain or service is required. See [chunk limits](phase-4-chunk-generation.md#configuration-and-limits).
The PDF compiler stage installs GCC only during build and copies the Linux socket-denying launcher
into the unprivileged runtime. The worker's default `2g` memory limit bounds aggregate
RSS; parser heap/time/byte/page limits are configurable through the existing environment
boundary. See [PDF extraction deployment and verification](phase-4-pdf-extraction.md).
Original storage remains read-only and extraction introduces no service or public port.

**Phase 4 deployment:** [AI/RAG infrastructure and security](phase-4-ai-rag.md#security-deployment-and-observability--planned)
adds optional private Qdrant and independently configured provider adapters.
T07 joins only the worker and Qdrant to the dedicated internal `vector` network.
API index access remains a future retrieval change; outbox needs neither AI credentials nor index
access. Original storage stays read-only in workers. Separate AI readiness from
core document health. PostgreSQL/original backups remain authoritative; Qdrant
can be rebuilt. No service, image, port, volume or configuration changes occur in T01.

The Compose/Nginx entry point serves the existing document workflows and the
v1.2.0 processing foundation. The additional worker and outbox processes share the
API image; PostgreSQL and private files remain authoritative, RabbitMQ carries
durable delivery, and Redis provides optional disposable progress.
Image builds, migrations, service health, real browser workflows, upload/download
and persistence across application-container recreation passed in Phase 1; the
v1.1.0 six-test browser workflow also passed through an isolated Nginx Compose
project. See [Phase 1 evidence](phase-1-browser-verification.md) and the
[v1.1.0 snapshot](releases/v1.1.0.md). Docker Desktop's Linux
engine must be running; a missing `dockerDesktopLinuxEngine` pipe means the engine
is unavailable, not that application migration or upload validation failed.
The dated infrastructure-task results below are retained as history.
Current Phase 3 evidence is in the [T13 verification](phase-3-verification.md)
and [T14 acceptance/upgrade guidance](phase-3-acceptance.md).

## First start

Qdrant's new volume is Compose-managed by default, independently of
`PERSISTENT_VOLUMES_EXTERNAL`, which protects existing PostgreSQL, storage and
RabbitMQ volumes. Set `QDRANT_VOLUME_EXTERNAL=true` only when the named Qdrant
volume already exists and should be externally managed. If Compose reports
`external volume "qyvra_qdrant_data" not found`, use this updated configuration
with `QDRANT_VOLUME_EXTERNAL=false`; keep your existing legacy volume mappings
and `PERSISTENT_VOLUMES_EXTERNAL=true` intact.

Install Docker Desktop with Linux containers and Compose v2. Run from the repository
root. The default project name is `qyvra`. Existing installations must first map
their original volumes and broker hostname as described in the
[Docker rename guide](docker-rename.md); changing only the project name creates
new empty volumes and makes old data appear missing.

POSIX shell:

```sh
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

For a NEW database replace `POSTGRES_PASSWORD` with a local password. Example
`POSTGRES_USER=qyvra` and `POSTGRES_DB=qyvra` are non-secret development
names. For an EXISTING database keep all three actual `POSTGRES_*` values; changing
initialization variables does not change existing database roles or passwords.
Quote passwords containing `$` literally in .env with single quotes. Do not use
angle-bracket placeholders. Do not replace an existing .env blindly.

```sh
docker compose config --quiet
docker compose up --build
```

Open **http://localhost:8080**. For background startup:

```sh
docker compose up --build -d
docker compose ps --all
docker compose logs -f
```

`migrate` should exit with code 0; postgres/rabbitmq/api/worker/web/nginx should be
healthy, and outbox should remain running. Redis health is observable but optional
for API/worker correctness. Migration failure prevents application startup.
Service-specific diagnosis:

Redis now runs as an internal, non-persistent service for disposable processing
progress. API and worker have an optional `REDIS_URL` (Compose defaults to
`redis://redis:6379`) but do not require Redis health to start or process jobs.
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d redis`
also exposes Redis on host loopback for local API/worker testing. To run the API
or worker on the host, set `REDIS_URL=redis://127.0.0.1:6379`; omit it to disable
progress without affecting durable processing. The status API returns
`progress: null` when Redis is unavailable. `docker compose logs redis` and
`docker compose exec redis redis-cli ping` diagnose the optional service.

```sh
docker compose logs -f migrate api
docker compose logs -f nginx web
docker compose logs -f postgres
```

To use a different host port change BOTH `NGINX_PORT` and `PUBLIC_APP_URL`, for
example 8088 and http://localhost:8088. Use that exact hostname consistently in the
browser; `localhost` and `127.0.0.1` are different origins. Recreate after changes.
No browser code contains Docker service names or secrets.

## Services and images

- `postgres`: PostgreSQL 17, original `postgres_data` volume, no canonical host port.
- `rabbitmq`: RabbitMQ 4.1 with management plugin on the private Compose network,
  durable `rabbitmq_data` volume and `rabbitmq-diagnostics -q ping` health check.
  It is not a dependency of HTTP startup. The canonical Compose file does
  not publish AMQP or management ports.
- `migrate`: one-shot Prisma `migrate deploy`, after PostgreSQL is healthy.
- `api`: compiled NestJS on internal 3001, Node 24, qpdf, Argon2/sharp and production
  dependencies; user `node` (UID 1000). Starts only after migrations succeed.
- `outbox`: the same API image runs `outbox-main.js` as a separate process after
  migrations and broker health. It derives encoded database/AMQP URLs from
  private Compose credentials, polls due outbox rows, and retries broker outages.
  T09 also polls PostgreSQL for expired processing leases and due retries, creating
  new outbox intents without direct broker publication.
  It exposes no HTTP port and does not affect API readiness.
- `worker`: the same API image runs `worker-main.js` as a separate non-HTTP
  process after migrations and broker health. It consumes the processing queue
  with manual acknowledgements and bounded prefetch. A private readiness file
  requires consumer connectivity and a periodic PostgreSQL probe; it is not
  processing state. The production integrity handler reads the shared private
  storage volume through a read-only mount.
- `web`: Next.js standalone production server on internal 3000, Node 24, user `node`.
- `nginx`: the only published service, loopback 8080 -> container 80. Depends on healthy
  API/web and probes both through its own routing.

The default project bridge network provides service-name discovery. API and web
ports are not published. Nginx resolves replacement containers via Docker DNS.
`/api/` forwards unchanged to NestJS (including `/api/v1` and query strings); every
other route forwards to Next.js, so refreshing nested pages works through the proxy.
No file directory is served statically. Downloads still require API authentication.

For host-run messaging integration tests, use both Compose files so AMQP port
5672 and management port 15672 bind to loopback only. Set `RABBITMQ_USER` and
`RABBITMQ_PASSWORD` in the private root `.env`; production deployments should use
a dedicated broker secret. Existing local `.env` files fall back to their
`POSTGRES_PASSWORD` for RabbitMQ initialization, which preserves first startup;
changing credentials after the broker volume is initialized requires normal
RabbitMQ user management. Set `TEST_RABBITMQ_URL` only in the test process and run
`npm --prefix apps/api run test:integration -- --runTestsByPath test/messaging.integration-spec.ts`.
For a host-run relay, build the API package, provide its normal validated
`DATABASE_URL` and `LOCAL_STORAGE_ROOT` plus `RABBITMQ_URL`, then run
`npm --prefix apps/api run start:outbox`. This process has no HTTP listener.
For a host-run worker, provide the same validated database/storage settings and
`RABBITMQ_URL`, build the API package, then run
`npm --prefix apps/api run start:worker`. Run the API, outbox and worker as
independent processes; `docker compose up --build -d` starts all three in the
complete stack. Stop or omit the `worker` service to run the API without it.
`docker compose logs -f worker` shows consumer connection and rejected-message
events. For focused worker integration tests, use a disposable migrated
`TEST_DATABASE_URL`, an isolated `TEST_RABBITMQ_URL`, and
`npm --prefix apps/api run test:integration -- --runTestsByPath test/worker.integration-spec.ts`.
The production worker verifies `VERIFY_STORED_FILE` deliveries against the
immutable version size and SHA-256. Messages dead-lettered before T08 deployment
still require explicit operator reconciliation.
The worker checks read access to its private storage root before starting its
consumer; a missing volume or incorrect permissions fails startup.
The API does not dispatch outbox records, so broker availability does not
affect document HTTP workflows. The separate dispatcher records transport failures
in PostgreSQL and retries after backoff. Inspect `docker compose logs -f outbox`
and due `processing_outbox` rows when messages are delayed. T07 upload/version
transactions create the job and outbox intent; the relay publishes committed intent.

The packages are independent npm projects with four existing package-lock.json
files, not a root npm workspace. `npm ci` uses those lockfiles; API `file:` links keep
their relative `/app/packages/*` layout. API runtime excludes source, tests and dev
dependencies. A separate migration target retains the Prisma CLI. Next standalone
output includes its traced runtime plus public/static assets. `.dockerignore`
excludes secrets, node_modules, generated output, Git and local tooling. Docker
builds require npm registry access and the existing Next Google Fonts downloads.

## Environment and cookies

Compose explicitly supplies only the settings listed in docker-compose.yml; it
never forwards the entire root .env into images or containers. Other optional
settings in .env.example document HOST development. Add a deliberate Compose
mapping if customizing those policies for a container deployment.

The database launcher constructs the same DATABASE_URL for API/migration from
POSTGRES_* and URL-encodes credentials. It always connects to `postgres:5432`.
Root DATABASE_URL and legacy API_DATABASE_URL do not override container routing.
There is no signing secret for the current opaque session implementation.

The browser uses `/api/v1`, fixed at web build time. No internal server API URL is
needed: current data requests are browser-side. The public upload UX limit is built
from the same UPLOAD_MAX_BYTES setting as the API; rebuild web when changing it.
Host Next.js development can still use apps/web/.env.local with its direct API URL.

Local Compose uses compiled application servers, NOT watchers. The API's
NODE_ENV=development is intentional for local HTTP: production validation requires
HTTPS origins and Secure cookies. Web always runs NODE_ENV=production. Cookies
remain HttpOnly, host-only, SameSite=Lax, session Path=/ and refresh
Path=/api/v1/auth, with Secure=false for local HTTP. Existing cookie names remain.
The exact PUBLIC_APP_URL is the origin allowlist (the API also uses it for CSRF).
CORS credentials are false because browser requests are same-origin. The existing
X-CSRF-Protection header remains required; the proxy does not manufacture it.

This is not an Internet production deployment. Later TLS must terminate at Nginx
or a trusted managed load balancer, with production API NODE_ENV, HTTPS public
origin, COOKIE_SECURE=true, and an explicitly reviewed trusted forwarding policy.
Current Nginx overwrites forwarded headers using its own HTTP connection; do not
place it behind TLS termination without updating that policy. No global trust-proxy
setting is enabled. Existing API throttling uses socket peers, so proxied clients
share the proxy's rate-limit budget; multi-user/per-client throttling needs review
before public deployment. Production validation was not weakened.

## Streaming limits

Default file limit is 52428800 bytes (50 MiB), hard API ceiling 200 MiB. Nginx's
entrypoint validates the same UPLOAD_MAX_BYTES and adds 1 MiB for multipart overhead.
The API still enforces file bytes, metadata bounds, MIME/signatures, encryption and
pages. Request and response buffering are disabled for API traffic. Timeouts are
650 seconds at Nginx (above the API's maximum receiving timeout of 600 seconds);
API inspection and admission limits still apply. Files are private and never stored
in the web container. Nginx access logs are disabled to avoid logging metadata in
query strings; use API correlation logs. Error logs may contain request paths.

## Maintenance and host development

Stop WITHOUT removing database or files:

```sh
docker compose down
```

Rebuild after dependencies/Dockerfiles or public build settings change:

```sh
docker compose up --build -d
```

For a deliberate base-image refresh:

```sh
docker compose build --pull
docker compose up -d
```

Safe migration redeployment (no reset; startup normally runs it automatically):

```sh
docker compose run --rm migrate
```

Runtime diagnostics (final API/web images deliberately do not include compilers):

```sh
docker compose exec api node --version
docker compose exec api qpdf --version
docker compose exec web node --version
docker compose exec nginx nginx -t
docker compose exec api node -e "fetch('http://127.0.0.1:3001/api/v1/health/ready').then(r=>console.log(r.status))"
docker compose exec api node -e "require('node:fs').accessSync('/data/qyvra',6); console.log('Storage root is readable and writable')"
```

For the previous host-run API/web hot-reload workflow, publish only PostgreSQL via
the small development override (no duplicated services):

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait postgres
```

Set host DATABASE_URL to 127.0.0.1 and the configured POSTGRES_PORT, and a host
LOCAL_STORAGE_ROOT outside the repository. Install host qpdf and follow the API/web
READMEs. Inject DATABASE_URL before host `npm --prefix packages/database run
migrate:deploy`. Stop host apps before starting the complete stack if necessary.
Do not mount Windows qpdf paths into the Linux container configuration.

## Persistence and manual backups

Keep the original `postgres_data` and `storage_data` volume keys and project name.
The API mounts storage_data at /data/qyvra for writes; the worker mounts the
same volume read-only for verification. New
volumes inherit directory ownership from the image (UID 1000, private permissions).
Existing volumes are not recursively changed: if readiness reports inaccessible
storage, inspect ownership before intentionally correcting it. Never chmod 777.

Inspect mounts without exposing environment values:

```sh
docker inspect --format '{{json .Mounts}}' $(docker compose ps -q api)
docker inspect --format '{{json .Mounts}}' $(docker compose ps -q postgres)
```

These substitutions work in POSIX shell and PowerShell. Back up both SQL and files
at the same maintenance point with writers stopped. For example:

```sh
docker compose stop api
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/qyvra.dump'
docker compose cp postgres:/tmp/qyvra.dump ./qyvra.dump
docker compose run --rm --no-deps --user root --entrypoint tar -v qyvra_backup:/backup api -czf /backup/documents.tgz -C /data/qyvra .
docker compose run --rm --no-deps --entrypoint ls -v qyvra_backup:/backup api -lh /backup/documents.tgz
docker compose start api
```

The SQL dump is a local file; the file archive is in the explicitly named
`qyvra_backup` volume. Inspect/export it with Docker Desktop or a temporary
read-only mount. Protect backups as sensitive personal data. This is manual backup
guidance, not an automated backup system; test a restore separately before relying
on backups. Shell quoting may require adjustment for legacy Windows PowerShell's
native argument handling; the Docker Desktop volume export UI is an alternative.

**Destructive warning:** `docker compose down --volumes` deletes PostgreSQL data
AND document files. Do not use it to restart, migrate, troubleshoot or upgrade.
No destructive command was executed for this task.

## Focused smoke check once Docker is running

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps --all
docker compose exec nginx nginx -t
curl -f http://localhost:8080/api/v1/health/live
curl -f http://localhost:8080/api/v1/health/ready
```

On Windows use curl.exe or Invoke-WebRequest. Through http://localhost:8080:
register a disposable test account, log in, reload to verify the session, create a
category and tag, upload a small non-sensitive PDF/PNG/JPEG, open its metadata and
download it. Compare the downloaded bytes with the original. Upload different
content as version 2 and inspect version history. Check archive/restore/soft delete
on a separate disposable document. Use Account settings from the account menu for
profile/password changes and logout-all.

For persistence, leave a test document active, record its ID, then recreate only
the app and database containers WITHOUT volumes deletion, allowing readiness:

```sh
docker compose up -d --force-recreate postgres
docker compose up -d --force-recreate api web nginx
docker compose ps --all
```

Log in again if necessary, confirm the same document/version records and identical
download bytes, then `docker compose down`. The isolated browser acceptance suite
has verified persistence, ownership and document workflows; these commands also
provide a manual check when changing your local configuration.

## Recorded checks (22 September 2026)

These are historical infrastructure-task results. The 23 September follow-up
successfully built and started the isolated full stack, ran migrations, checked
Nginx configuration, verified real browser workflows and confirmed persistence
across container recreation. See [final browser verification](phase-1-browser-verification.md).

- `docker compose --env-file .env.example config --quiet`: passed (no rendered secrets printed).
- `docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.dev.yml config --quiet`: passed.
- `node --test infrastructure/docker/database-command.test.cjs`: passed (configuration/launcher checks; no daemon required).
- `node --check infrastructure/docker/database-command.cjs`: passed.
- `npm --prefix apps/api run build`: passed, including storage/database builds and Prisma generation. No database connection or migration was run.
- `npm --prefix apps/web run build`: passed, including TypeScript and standalone server output. Existing Google Fonts required network access.
- Frontend ESLint for next.config.ts and Prettier on changed JS/TS/YAML/Markdown: passed.
- Compiled API configuration accepted the Compose HTTP policy and rejected that policy with NODE_ENV=production.
- Git Bash syntax check for the Nginx upload-limit script: passed.
- `docker compose --env-file .env.example build`: blocked before building by the missing Docker Desktop Linux engine pipe.
- Nginx `-t`, image runtime/startup/health checks, migration execution, live workflow and recreation/persistence checks: NOT RUN due to that same engine limitation.

Files changed: root Compose and .env.example, .dockerignore/.gitattributes,
new host-development Compose override, API/web/Nginx Dockerfiles, Nginx template
and limit script, database command launcher and focused tests, Next standalone
configuration, root/API/web/storage READMEs, architecture/roadmap and this guide.
No schema migration, real .env, existing volume or business endpoint was changed.

## T08 ingestion integration — Implemented

[T08](phase-4-ingestion.md) passes nonsecret ingestion/profile/chunk settings to API and worker. Provision the SQL profile before enabling ingestion. The runtime image includes scripts/ai-backfill.cjs for bounded dry-run/apply maintenance through the canonical scheduler; use the existing database-command wrapper. Qdrant stays on the private vector network; T09 adds API read access.

## Phase 4 T09 private retrieval deployment

The API joins the existing internal vector network and receives server-only embedding/Qdrant configuration for opt-in query retrieval. Qdrant has no published port or proxy route. Configure an explicit matching SQL serving profile and API fingerprint; `SEMANTIC_SEARCH_PROFILE_FINGERPRINT` is an API-only Compose override during replacement builds. [Configuration, profile selection and limits](phase-4-semantic-search.md#configuration-and-deployment).

## T11 real AI browser verification

`node infrastructure/e2e/ai-run.cjs test` builds an isolated `qyvra-e2e-ai` stack and provisions a test embedding profile before enabling enrollment. It adds a private deterministic HTTP provider fixture only through `infrastructure/e2e/ai-compose.yml`; normal Compose defaults and public ports are unchanged. Actual uploads, workers, SQL, Qdrant and Nginx participate. See [T11 verification and limitations](phase-4-ai-frontend.md#verification-and-remaining-scope).

## T12 recovery and production review

[T12 verification](phase-4-verification.md) records actual outage/rebuild tests and
[operational recovery](phase-4-verification.md#operational-recovery). Keep original
database/storage volumes when restoring services. After Qdrant collection loss,
explicit index-only reprocessing rebuilds from complete durable embeddings;
SQL readiness alone is not a live remote-health check. The T12 browser fault suite
requires an isolated `qyvra-e2e-ai-t12` project; never run destructive collection-loss
tests against development or production services.

See the [production configuration review](phase-4-verification.md#production-configuration-review)
before exposing this local HTTP stack. The private deterministic provider fixture
is not a production provider and is absent from normal Compose.
