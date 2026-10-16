# QYVRA documentation

**Current prepared candidate: v1.3.1 / Local AI Provider Compatibility.**
Documentation/version preparation is complete; readiness is **CONDITIONALLY READY**
for the pinned pair, with no publication claim. Start with [getting started](development/getting-started.md),
[local AI setup](development/local-ai.md), [release notes](releases/v1.3.1.md)
and [T06 readiness/handoff](local-provider-release-preparation.md).
The v1.0.0/v1.1.0 snapshots and v1.2.0 acceptance/developer records remain historical.

Start with the [v1.3.1 developer walkthrough](developer/versions/v1.3.1.md).
The [v1.3.0 walkthrough](developer/versions/v1.3.0.md) preserves the AI/RAG baseline.
The [developer baseline](developer/README.md), [v1.1.0 delta](developer/versions/v1.1.0.md)
and [v1.2.0 processing walkthrough](developer/versions/v1.2.0.md) describe their recorded
versions. Current architecture and Phase 4 contracts are linked below.

## Phase 5 — v1.4.0 planned

- [Live continuation evidence and remaining gates](phase-5-live-verification.md)
- [Proposed 30-query relevance corpus](phase-5-search-quality.md)

- [T12 final verification and owner-only manual Git handoff](phase-5-manual-git-handoff.md)
- [T11 acceptance matrix, security findings and NOT READY decision](phase-5-verification.md)
- [v1.4.0 draft candidate scope, upgrade and rollback](releases/v1.4.0.md)
- [v1.4.0 developer walkthrough](developer/versions/v1.4.0.md)
- [T01 scope, audited baseline, architecture, ordered tasks, acceptance and testing](phase-5-search.md)
- [T02 implemented search persistence, v3 contracts and verification](phase-5-data-foundation.md)
- [T03 enrollment, lifecycle fencing, durable fanout and verification](phase-5-search-enrollment.md)
- [T04 private Elasticsearch adapter, mappings, deployment and verification](phase-5-elasticsearch.md)
- [T05 independent PDF extraction, verified lexical publication and test evidence](phase-5-lexical-publication.md)
- [T06 authorized keyword API, canonical snippets, limits and test evidence](phase-5-keyword-search.md)
- [T07 hybrid candidates, RRF, bounded Redis windows and verification](phase-5-hybrid-search.md)
- [T08 safe highlights, private suggestions and exact lexical sources](phase-5-search-evidence.md)
- [T09 search frontend, browser source workflows and verification](phase-5-search-frontend.md)
- [T10 backfill, rebuild, reconciliation, operator recovery and verification](phase-5-search-operations.md)
- [ADR-007: Rebuildable keyword projections with SQL publication](decisions/ADR-007-rebuildable-keyword-search.md)
- [ADR-008: Application-side cross-index document ranking](decisions/ADR-008-cross-index-hybrid-ranking.md)
- [ADR-009: Maintenance generations and bounded SQL cutover](decisions/ADR-009-search-maintenance-generations.md)

T01 design and T02/T03 foundations are implemented. T04 transport/deployment
configuration and T05 lexical handlers are implemented and locally verified, with
live acceptance pending. T06 keyword serving is implemented and defaults off;
T07 cursor/hybrid and T08 highlights/private suggestions/source reads are implemented
with live acceptance pending; T09 frontend is implemented and locally verified,
with the initial live Nginx workflow passed and extended/hybrid acceptance pending. `VERSION`
remains `1.3.1`; v1.4.0 is a target, not a prepared or published release.
T10 maintenance is implemented with local verification and pending live recovery
acceptance. T11 reviewed the candidate: **NOT READY**, with mandatory live,
quality/resource and reviewed-candidate remote CI gates outstanding. T11 remains
PARTIAL; see its continuation checkpoint rather than repeating implementation.

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

## v1.3.1 — Local AI Provider Compatibility

- [Current developer walkthrough and retained T01 audit](developer/versions/v1.3.1.md)
- [Proposed ADR-006: Native local-provider adapters](decisions/ADR-006-local-provider-compatibility.md)

- [T02 native Ollama embeddings, pinned profiles/assets and verification](local-embeddings.md)
- [T03 native Ollama generation, pinned context/framing and validated citations](local-generation.md)
- [T04 provider configuration matrix, private assets/networking and host access](local-provider-configuration.md)
- [T05 real local PDF-to-RAG, security/recovery and qualified readiness](local-provider-verification.md)
- [Reproducible local models/tokenizers and deployment setup](development/local-ai.md)
- [T06 candidate version, upgrade/release review and validation](local-provider-release-preparation.md)
- [T07 release candidate audit, CI findings and proposed commit scope](local-provider-release-candidate-review.md)
- [v1.3.1 release notes and upgrade/rollback](releases/v1.3.1.md)

T01 is documentation only. T02 implements native embeddings; T03 implements native
generation; T04 consolidates configuration/networking. T05 is complete: real Nomic
embeddings, Qwen generation, PDF-to-RAG/browser and service recovery pass for the
documented pinned pair. Status is **CONDITIONALLY READY**, with deployment/model
limits recorded in the report. T06 is complete; no release occurred.

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

- [v1.3.1: implemented local-provider development guide](developer/versions/v1.3.1.md)
- [v1.3.0: AI/RAG development guide](developer/versions/v1.3.0.md)
- [Versioned developer history: v1.0.0 baseline and v1.1.0/v1.2.0/v1.3.0](developer/README.md)
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
- [v1.3.1: prepared local-provider candidate](releases/v1.3.1.md)
- [v1.0.0: Phase 1 snapshot](releases/v1.0.0.md)
- [v1.1.0: Phase 2 snapshot](releases/v1.1.0.md)
- [v1.3.0: prepared Phase 4 candidate, release notes and limits](releases/v1.3.0.md)
- [v1.2.0: accepted candidate, untagged](phase-3-acceptance.md)
- [Roadmap and deferred scope](roadmap.md)
- [Documentation audit and retained evidence](documentation-audit.md)

The existing flat architecture/database/Compose guides remain canonical to preserve
links. Closely related topics are consolidated instead of repeated across directories.
