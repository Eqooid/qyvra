# QYVRA v1.3.1

**Query Yielding Vault Recall Assistant** is a private document-management app
with immutable file versions, organization and an opt-in AI/RAG foundation.

**Current development candidate: v1.3.1 — Local AI Provider Compatibility.**
[Release notes](docs/releases/v1.3.1.md), [T05 evidence](docs/local-provider-verification.md)
and [T06 preparation](docs/local-provider-release-preparation.md) record
**CONDITIONALLY READY** for the pinned Nomic/Qwen deployment. [VERSION](VERSION)
is `1.3.1`; publication/tagging remains separate. Private npm packages stay `0.0.1`
and the HTTP contract remains `/api/v1` / OpenAPI `1`.

The [v1.3.1 developer walkthrough](docs/developer/versions/v1.3.1.md) explains
implemented adapters and retains the original T01 audit. [T02 native Ollama
embeddings](docs/local-embeddings.md) are implemented. [T03 native Ollama generation](docs/local-generation.md)
is implemented behind the same grounded RAG interface.
[T04 provider configuration and Docker networking](docs/local-provider-configuration.md)
adds optional private networking/assets and shared credential validation.
[T05](docs/local-provider-verification.md) verifies the pinned Nomic/Qwen pair,
real local PDF-to-RAG, browser navigation and service recovery: **CONDITIONALLY READY**.
Other models/deployments require validation. T06 documentation/version preparation
is complete; no automatic release action occurred. The [v1.3.0 snapshot](docs/releases/v1.3.0.md)
preserves the AI/RAG foundation's historical scope.

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
original documents remain usable during AI outages. See [known limits](docs/releases/v1.3.1.md#known-limits-and-release-gate).

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

For optional local RAG, T05 verified `nomic-embed-text:v1.5` (768 dimensions) and
`qwen3:0.6b` with Ollama 0.40.3 and pinned tokenizer bundles. Prepare models/assets,
an immutable SQL profile and calibrated retrieval settings before enabling AI.
API and worker use trusted server-only endpoints; container `localhost` does not
reach host Ollama. Follow [local setup](docs/development/local-ai.md) and
[host/container/LAN networking](docs/local-provider-configuration.md).

Start with the [v1.3.1 developer guide](docs/developer/versions/v1.3.1.md) and
[local model/tokenizer setup](docs/development/local-ai.md) for
upload-to-RAG source navigation, AI configuration, independent worker startup,
contracts, lifecycle/recovery and the limits of the recorded verification.

Local-provider checks are recorded in [T05](docs/local-provider-verification.md).
The earlier Phase 4 [T12 matrix](docs/phase-4-verification.md) remains historical.
Neither document creates a release tag.

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

- [v1.3.0 development documentation](docs/developer/versions/v1.3.0.md): Phase 4 architecture, data, processing, APIs, frontend, security and operations
- [Developer documentation history](docs/developer/README.md): preserved v1.0.0 baseline and v1.1.0/v1.2.0/v1.3.0 delta guides
- [Documentation index](docs/README.md) and [contributing](CONTRIBUTING.md)
- [API conventions](docs/api.md), [local Swagger UI](http://localhost:8080/api/v1/docs/)
  and [generated OpenAPI JSON](http://localhost:8080/api/v1/docs-json)
- [Environment variables](docs/deployment/environment-variables.md)
- [Changelog](CHANGELOG.md) and [release snapshots](docs/README.md#releases)
- [Versioning policy](docs/development/conventions.md#versioning) and [roadmap](docs/roadmap.md)

Coding-agent instructions live separately in [AGENTS.md](AGENTS.md) and the nested
application AGENTS files.
