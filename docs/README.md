# QYVRA documentation

**Current prepared candidate: v1.3.0 / Phase 4.** Implementation, local verification
and release preparation are complete with known non-blocking limitations. No v1.3.0
tag/publication exists. Start with [getting started](development/getting-started.md),
[release notes](releases/v1.3.0.md) and [T13 readiness/Git steps](phase-4-release-preparation.md).
The v1.0.0/v1.1.0 snapshots and v1.2.0 acceptance/developer records remain historical.

The [developer baseline](developer/README.md), [v1.1.0 delta](developer/versions/v1.1.0.md)
and [v1.2.0 processing walkthrough](developer/versions/v1.2.0.md) describe their recorded
versions. Current architecture and Phase 4 contracts are linked below.

## Phase 4 — v1.3.0

- [T01 architecture, scope and contracts](phase-4-ai-rag.md)
- [T02 persistent data foundation](phase-4-data-foundation.md)
- [T03 durable stage orchestration](phase-4-processing.md)
- [T04 PDF extraction and canonical content](phase-4-pdf-extraction.md)
- [T05 deterministic chunks and provenance](phase-4-chunk-generation.md)
- [T06 provider-neutral embeddings and checkpoints](phase-4-embedding-generation.md)
- [T07 Qdrant indexing, activation, rebuild and cleanup](phase-4-vector-indexing.md)
- [T08 uploads, reprocessing, restore and backfill](phase-4-ingestion.md)
- [T09 authorized semantic retrieval](phase-4-semantic-search.md)
- [T10 grounded RAG and validated citations](phase-4-rag-answers.md)
- [T11 AI frontend and authorized source navigation](phase-4-ai-frontend.md)
- [T12 security/recovery verification ledger](phase-4-verification.md)
- [T13 final release preparation and versioning](phase-4-release-preparation.md)

## Architecture

- [Overview, backend, frontend and storage boundaries](architecture.md)
- [Database models, ownership and migration constraints](database.md)
- [Authentication/session flow](features/authentication.md)
- [Infrastructure, Nginx and persistence](compose.md)
- [API conventions and generated OpenAPI](api.md)
- [v1.2.0 processing persistence, outbox delivery, and worker boundary](phase-3-processing.md)
- [v1.2.0 Phase 3 end-to-end verification matrix (T13)](phase-3-verification.md)
- [v1.2.0 final acceptance, release readiness and upgrade/rollback guidance (T14)](phase-3-acceptance.md)

## Features

- [Authentication and account settings](features/authentication.md)
- [Documents, uploads, downloads and lifecycle](features/documents.md)
- [Categories and tags](features/organization.md)
- [Document versioning](features/document-versioning.md)

## Development

- [Getting started: Docker or host development](development/getting-started.md)
- [Testing and verification commands](development/testing.md)
- [Conventions and versioning](development/conventions.md)
- [Contributing](../CONTRIBUTING.md)
- [API package](../apps/api/README.md), [web package](../apps/web/README.md),
  [database package](../packages/database/README.md), [storage package](../packages/storage/README.md)

## Deployment

- [AI/RAG security and internal service boundaries](phase-4-ai-rag.md#security-deployment-and-observability--planned)

- [Docker namespace migration to QYVRA and preserved development data](docker-rename.md)
- [QYVRA rename, retained identifiers and repository follow-up](qyvra-rename.md)
- [Docker Compose, Nginx, migrations, backups and troubleshooting](compose.md)
- [Environment variables](deployment/environment-variables.md)

## Architecture Decisions

- [ADR convention and index](decisions/README.md)

## Releases

- [Changelog](../CHANGELOG.md)
- [v1.0.0: Phase 1 snapshot](releases/v1.0.0.md)
- [v1.1.0: Phase 2 snapshot](releases/v1.1.0.md)
- [v1.3.0: prepared Phase 4 candidate, release notes and limits](releases/v1.3.0.md)
- [v1.2.0: accepted candidate, untagged](phase-3-acceptance.md)
- [Roadmap and deferred scope](roadmap.md)
- [Documentation audit and retained evidence](documentation-audit.md)

The existing flat architecture/database/Compose guides remain canonical to preserve
links. Closely related topics are consolidated instead of repeated across directories.
