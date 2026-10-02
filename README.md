# QYVRA

**Query Yielding Vault Recall Assistant** (formerly known as Brainless).

QYVRA is a personal document-management application for storing private files,
organizing their metadata, and keeping immutable file versions.

**Latest locally verified release tag: v1.1.0. Phase 1 remains complete.** Registration,
account settings, categories/tags, document upload/download, metadata editing,
archive/restore, soft deletion and version history are implemented. OCR, AI,
full-text/semantic search and reminders are **Planned**, not available.
[Phase 2 / v1.1.0](docs/roadmap.md#phase-2--v110-release-ready) adds document
descriptions, current-file summaries, metadata filters, deterministic sorting and
cursor navigation. See the [incremental developer guide](docs/developer/versions/v1.1.0.md)
for the verified version comparison and upgrade requirements.
The [v1.2.0 Phase 3 foundation](docs/phase-3-processing.md) is implemented and
accepted as a release-ready candidate (not yet tagged):
PostgreSQL job/outbox persistence, job rules, RabbitMQ transport, an independently
runnable outbox dispatcher, a separate worker consumer, and upload-triggered
job/outbox scheduling and production stored-file integrity verification are
implemented. T09 adds PostgreSQL-backed processing retry and expired-lease
recovery in the separate outbox process. T10 adds the owned processing-status
API. T11 adds optional Redis progress; T12 displays owned processing status and
progress on document detail and inspected version history. The
[T13 verification matrix](docs/phase-3-verification.md) records full-stack
evidence and limits. The [T14 acceptance record](docs/phase-3-acceptance.md)
records final checks, fixes, dependency findings and upgrade/rollback guidance;
v1.2.0 has not been tagged as a release.

## Architecture and stack

The browser reaches Next.js and the NestJS REST API through Nginx. NestJS owns
authorization and accesses PostgreSQL through Prisma and private files through
the shared storage abstraction. See the [architecture diagram](docs/architecture.md).

The repository uses Node.js 24+, TypeScript, NestJS 10, Next.js 16, React 19,
Tailwind CSS 4, shadcn/Base UI, TanStack Query, React Hook Form/Zod, Prisma 7,
PostgreSQL 17, Nginx 1.28 and Docker Compose. These are repository dependency/image
majors; the four npm lockfiles record exact JavaScript dependency versions.

```text
apps/api/             NestJS API
apps/web/             Next.js App Router frontend
packages/database/    Prisma schema, migrations and shared client
packages/storage/     Streaming storage interface and local adapter
infrastructure/       Docker images, Nginx and browser-test orchestration
docs/                 Developer guides, release snapshots and verification reports
```

Packages install independently with npm. There is no root `package.json`; the empty
`pnpm-workspace.yml` does not define an active workspace.

## Quick start with Docker

Requires Docker with Linux containers and Compose v2. From a new checkout:

```sh
cp .env.example .env
```

PowerShell: `Copy-Item .env.example .env`. Replace the `POSTGRES_PASSWORD`
placeholder before startup. Preserve an existing `.env`, database initialization
values. Compose defaults to project `qyvra` independently of the checkout directory.
Existing installations must map their original volumes before changing project
names; see [Docker rename and data compatibility](docs/docker-rename.md).

```sh
docker compose up --build -d
docker compose ps --all
docker compose logs -f
```

Open [QYVRA](http://localhost:8080). Migrations run before API startup.
Register, then log in. Stop with `docker compose down`; do not add `--volumes`,
which deletes the database and uploaded files. This is a local HTTP deployment.
See [Compose operations](docs/compose.md) for persistence, backups and deployment limits.

## Develop and test

Follow [getting started](docs/development/getting-started.md) for dependency installation,
host PostgreSQL, qpdf, private storage, environment configuration and migrations.
After setup, use separate terminals from the repository root:

```sh
npm --prefix apps/api run start:dev
npm --prefix apps/web run dev
```

Common checks:

```sh
npm --prefix apps/api test -- --runInBand
npm --prefix apps/api run test:e2e -- --runInBand
npm --prefix apps/web test -- --maxWorkers=1
npm --prefix apps/api run lint
npm --prefix apps/web run lint
npm --prefix apps/api run typecheck
npm --prefix apps/web run typecheck
npm --prefix apps/api run format:check
npm --prefix apps/web run format:check
npm --prefix apps/api run build
npm --prefix apps/web run build
```

[Testing](docs/development/testing.md) covers storage tests, the isolated PostgreSQL
integration suite and real browser tests through Nginx. API HTTP tests use a database
double and do not replace database integration tests.

## Documentation

- [Developer documentation](docs/developer/README.md): preserved v1.0.0 baseline plus v1.1.0 changes, walkthroughs and upgrade guidance
- [Documentation index](docs/README.md) and [contributing](CONTRIBUTING.md)
- [API conventions](docs/api.md), [local Swagger UI](http://localhost:8080/api/v1/docs/)
  and [generated OpenAPI JSON](http://localhost:8080/api/v1/docs-json)
- [Environment variables](docs/deployment/environment-variables.md)
- [Changelog](CHANGELOG.md) and [release snapshots](docs/README.md#releases)
- [Versioning policy](docs/development/conventions.md#versioning) and [roadmap](docs/roadmap.md)

Coding-agent instructions live separately in [AGENTS.md](AGENTS.md) and the nested
application AGENTS files.
