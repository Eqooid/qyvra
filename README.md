# Brainless

Brainless is a personal knowledge and document-management application. Its current implementation focuses on securely organizing, processing, searching, and discussing personal documents.

## Planned workspace

```text
apps/
  web/                 Next.js and shadcn/ui frontend
  api/                 NestJS REST API
  document-worker/     extraction, OCR, and chunking
  indexing-worker/     Elasticsearch and Qdrant indexing
  reminder-worker/     reminder scheduling and delivery
packages/
  database/            Prisma schema, migrations, and client
  contracts/           shared provider-neutral contracts
  messaging/           RabbitMQ message contracts
  ai/                  AI provider interfaces
  storage/             file-storage interfaces
docs/                   product and engineering documentation
infrastructure/         Docker and service configuration
```

Only create applications and packages when their roadmap phase begins. The existing Next.js application belongs in `apps/web`.

The Phase 1 usable tracker is complete, including account settings and real browser
verification through Nginx. See the [final acceptance results](docs/phase-1-browser-verification.md).

Immutable additional-version uploads and version history are implemented. See
[versioning verification and migration setup](docs/versioning-implementation.md).
Next.js document pages and container runtime workflows are verified; see
[Compose setup and verification](docs/compose.md).

## Run the complete local application

Account settings are available from the account menu. See
[real browser verification](docs/phase-1-browser-verification.md) for the isolated
Nginx E2E commands and latest Phase 1 verification results.

Requires Docker Desktop with Linux containers and Compose v2. For a new checkout:

```sh
cp .env.example .env
```

PowerShell: `Copy-Item .env.example .env`. Replace the POSTGRES_PASSWORD placeholder.
For existing data, preserve the actual POSTGRES_* values and Compose project name.

```sh
docker compose up --build
```

Open **http://localhost:8080**. API calls use the same origin at `/api/v1`.
Migrations run automatically before the API starts. Background/status/logs/stop:

```sh
docker compose up --build -d
docker compose ps --all
docker compose logs -f
docker compose down
```

Do not add `--volumes`: PostgreSQL and private uploaded files must survive shutdown.
See [full setup](docs/compose.md) for service logs, configuration, rebuilds, manual
migrations, persistence checks and backups. Docker Desktop's Linux engine must be
running before starting the application or isolated browser tests.

For host development, use Node 24+ and the independent npm lockfiles. Start only
PostgreSQL with `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait postgres`.
Follow [API setup](apps/api/README.md) and [web setup](apps/web/README.md), with a
host DATABASE_URL, private LOCAL_STORAGE_ROOT and qpdf. Host commands are unchanged.

## Documentation

- [Full specification](docs/specification.md)
- [Architecture](docs/architecture.md)
- [Database and storage](docs/database.md)
- [API reference](docs/api.md)
- [Delivery roadmap](docs/roadmap.md)

## Instructions for coding agents

Read the root [AGENTS.md](AGENTS.md) before changing the repository. When modifying the frontend, also follow `apps/web/AGENTS.md`.

## Continuing development

```text
Read AGENTS.md and the relevant documentation under docs/.

Inspect the existing repository and current acceptance results. Implement only the explicitly requested task, preserving completed Phase 1 behavior. Before coding, provide a concise plan and list the files you will change. Run checks relevant to the change and update its documentation. Do not start a later phase without an explicit request.
```

## Branding compatibility

Product branding is Brainless; the machine-readable slug is `brainless`. Packages
are `@brainless/api`, `@brainless/web`, `@brainless/database`, and `@brainless/storage`. There is no root
`package.json`; the independent npm installation layout remains unchanged. After
updating, run `npm install` in `packages/database`, `apps/api`, and `apps/web` to
refresh the local package link and lockfile metadata.

Existing authentication identifiers are intentionally retained: cookie defaults
`document_tracker_session` and `document_tracker_refresh`, the
`document-tracker-auth` BroadcastChannel, and `document-tracker-auth:<api-base>`
Web Lock. Keeping these allows old and new tabs to coordinate refresh and logout
without invalidating current cookies. They are internal compatibility identifiers,
not display branding. The identity issuer remains `local`; no identity or session
records need migration. Tests and cookie-setting documentation retain these names.

No tables, columns, migrations, populated environment files, database names, Docker
service names, or persistent volumes are renamed. Keep the existing Compose project
name (including any `COMPOSE_PROJECT_NAME` or `-p` setting) and `postgres_data` volume;
changing the project name can select a different volume. Do not use `down -v`.
If a local `.env` explicitly sets the old `APP_NAME`, change only that display value
to `Brainless API` or remove it to use the new default. Leave database URLs and
initialization settings pointing at the existing database. Nginx now provides the local entry point; no monitoring services are added.

The latest [Phase 1 API review](docs/phase-1-review.md) records verification results
and remaining acceptance gaps. Database integration tests require a separately
migrated `TEST_DATABASE_URL`; a successful API build is not a substitute for them.
