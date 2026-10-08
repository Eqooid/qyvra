# QYVRA

**Query Yielding Vault Recall Assistant** is a private document-management app
with immutable file versions, organization and an opt-in AI/RAG foundation.

**Phase 4 / v1.3.0 is complete as a prepared release candidate:**
[release notes](docs/releases/v1.3.0.md), [T13 preparation](docs/phase-4-release-preparation.md)
and [T12 verification](docs/phase-4-verification.md) record **READY WITH KNOWN
NON-BLOCKING LIMITATIONS**. It has not been tagged or published; the latest local
release tag remains v1.1.0. Private package versions and API version are separate.

Implemented: authenticated accounts, private PDF/JPEG/PNG storage, categories/tags,
metadata filters/sorting/cursors, immutable versions, archive/restore and soft
deletion. Background processing verifies originals, extracts text-bearing PDFs,
creates deterministic citation-ready chunks, checkpoints embeddings and activates
verified Qdrant indexes. Owned semantic search and standalone document Q&A return
validated citations with authorized exact-source navigation. Reprocessing, restore
reuse and bounded backfill use the same durable pipeline.

The browser reaches Next.js and NestJS through Nginx. PostgreSQL owns durable state,
RabbitMQ is transport, Redis is disposable progress and Qdrant is rebuildable.
Providers sit behind independent embedding/generation interfaces. Elasticsearch is
**Planned**, not a Phase 4 service. The stack uses Node.js 24+, TypeScript, Next.js 16,
React 19, NestJS 10, Prisma 7 and PostgreSQL 17; lockfiles pin dependencies.

Limitations: PDF AI text only, no OCR, persistent chat, streaming or agents/tools.
Provider access/profile setup is required for enabled AI operations. Grounding and
validated provenance do not eliminate model errors. AI is disabled by default;
original documents remain usable during AI outages. See [known limits](docs/releases/v1.3.0.md#verification-and-known-limitations).

Packages install independently with npm under apps/api, apps/web, packages/database
and packages/storage; there is no root package manifest. Infrastructure and canonical
guides live under infrastructure and docs. [Architecture](docs/architecture.md) and
the [documentation index](docs/README.md) explain the boundaries and release history.

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

Phase 4 release-candidate checks and safe recovery procedures are recorded in the
[T12 verification matrix](docs/phase-4-verification.md). This does not create a release tag.

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
