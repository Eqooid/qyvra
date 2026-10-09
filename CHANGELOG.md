# Changelog

Notable changes are recorded here, with Added, Changed and Fixed categories as
applicable. Releases follow [Semantic Versioning](docs/development/conventions.md#versioning).

## [Unreleased]

No next phase has started. The prepared candidates below have not been published.

## [1.3.0] — Release candidate, prepared 2026-10-08

Phase 4 implementation, local verification and release preparation are complete.
Decision: **READY WITH KNOWN NON-BLOCKING LIMITATIONS**. No v1.3.0 tag or release
publication exists. See [release notes](docs/releases/v1.3.0.md),
[T12 evidence](docs/phase-4-verification.md) and [T13 preparation](docs/phase-4-release-preparation.md).

### Added

- Durable canonical PDF text, deterministic token-bounded chunks, exact page/Unicode
  provenance, immutable embedding profiles and PostgreSQL embedding checkpoints.
- Native provider-neutral embedding/generation HTTP boundaries, private Qdrant
  indexing, verified generation activation and artifact-only vector rebuilds.
- Opt-in upload enrollment, owned idempotent reprocessing, restore reuse and bounded
  resumable dry-run/apply backfill through the existing jobs/outbox/worker.
- Authorized semantic search, standalone grounded Q&A, insufficient-evidence outcomes,
  server-validated citations and authenticated exact-source navigation.
- AI Search/readiness UI, deterministic real-infrastructure verification and a CI
  workflow without paid-provider requirements.
- [Versioned v1.3.0 developer walkthrough](docs/developer/versions/v1.3.0.md),
  added on 9 October 2026 to complete the missing T13 documentation deliverable.

### Changed

- The Phase 3 durable pipeline now covers integrity → extraction → chunks →
  embeddings → indexing. PostgreSQL remains the state and authorization authority.
- AI providers are independently configurable; profile compatibility is enforced
  for indexing/querying. Qdrant is derived and Redis progress remains disposable.

### Fixed

- Worker AMQP setup cannot restore readiness or leak a late connection after shutdown.
- Client page-span validation matches the configured 2,000-page server maximum.
- Lockfiles include required Linux native entries; broker tests use isolated vhosts.

### Security

- Mandatory vector scope filtering plus PostgreSQL hydration/reauthorization prevent
  forged payload ownership from admitting foreign chunks into AI context.
- Structured model references resolve only to authorized supplied evidence. Answers
  render as plain text; source routes enforce exact ownership and lifecycle.
- Targeted dependency patches pass production high/critical gates without framework
  major upgrades; remaining audit findings are explicitly tracked in T12.

### Reliability

- Lease-fenced atomic stage completion and outbox scheduling, resumable batches,
  verified index activation and durable cleanup retain at-least-once safety.
- Qdrant collection-loss rebuild reuses SQL embeddings; Redis/broker/worker outages
  preserve durable intent. Archive/delete immediately revoke retrieval eligibility.

### Known limitations

- PDF text only; no OCR, persistent chat, streaming, agent actions, hybrid search or
  local model orchestration. Native compatible HTTP adapters do not support every provider.
- Grounding and validated citations do not guarantee factual/model-injection immunity.
  Live-model quality, remote CI and production capacity/HA remain unverified.
- Five moderate production API findings, development tooling advisories and 25 unchanged
  web format warnings remain. No independent tenants, public purge or historical PDF viewer.

## [1.2.0] — Accepted candidate, not tagged

The following v1.2.0 release-candidate work is implemented and accepted as
release ready; no v1.2.0 tag has been created. See the
[T14 acceptance record](docs/phase-3-acceptance.md) for evidence and limitations.

### Added

- Version-scoped PostgreSQL processing jobs and a transactional outbox, created
  atomically with each new document version.
- Confirmed RabbitMQ publication, a separate outbox/recovery process, and an
  independently runnable worker with durable, bounded retry and dead-letter
  handling.
- Streamed stored-file size/SHA-256 integrity verification against immutable
  upload metadata.
- An owned processing-status API, optional disposable Redis progress, and
  polling status/progress views on document detail and version history.

### Changed

- Archive and soft delete cancel unfinished processing in their document
  transaction. Restore schedules a new generation for cancelled work on the
  current version.
- Local Compose includes RabbitMQ, Redis, outbox and worker services while
  preserving the Nginx entry point and PostgreSQL/private-file authority.

### Fixed

- API lint now accepts the checkout's native line endings while preserving
  the existing TypeScript formatting rules.
- Targeted API dependency overrides patch Lodash, Multer, js-yaml, qs and
  body-parser advisories without a NestJS major-version upgrade. Remaining
  dependency findings and their applicability are recorded in the T14 acceptance review.

See the [Phase 3 architecture](docs/phase-3-processing.md) and
[verification matrix](docs/phase-3-verification.md). Extraction, OCR,
Elasticsearch, Qdrant, embeddings, RAG and AI features are not part of v1.2.0.

## [1.1.0] - 2026-09-25

### Added

- Documentation index, onboarding/testing guides, feature guides, environment reference,
  ADR convention and v1.0.0 release snapshot.
- Optional, nullable document descriptions in uploads and metadata editing.
- Owned current-version summaries in document list, detail and PATCH responses.
- Current filename/MIME, all-of tag and created/updated date filters for the document catalog.
- Allow-listed document sorting and deterministic opaque cursor navigation in the API and UI.

### Changed

- Documentation baseline distinguishes implemented Phase 1 behavior from planned work
  and historical verification evidence.
- The document list and detail show current-file metadata and descriptions; the upload
  form accepts an optional description. Existing uploads without one remain supported.
- Document-list queries retain owner scoping, archive/deletion rules and existing
  metadata filters while combining the new filters with AND semantics.

See the [v1.1.0 snapshot](docs/releases/v1.1.0.md) for migration, compatibility,
verification and deferred work.

## [1.0.0] - 2026-09-24

### Added

- Local registration and Argon2id authentication with PostgreSQL-backed sessions,
  refresh rotation/replay detection, logout, session management and account settings.
- Owner-scoped categories and tags, document metadata/filtering, archive/restore and soft deletion.
- Validated streaming PDF/JPEG/PNG uploads, private local storage, SHA-256 duplicate
  protection and durable upload idempotency.
- Immutable file versions, paginated version history and authorized current-file downloads.
- Responsive Next.js frontend with account, organization and document workflows and theme selection.
- NestJS validation, safe response envelopes, correlation logging, health probes and generated OpenAPI.
- Prisma schema/migrations, local Nginx/Compose deployment with persistent database/file volumes,
  unit/HTTP/database/storage tests and isolated Chromium workflow verification.

See the [v1.0.0 snapshot](docs/releases/v1.0.0.md) for evidence and release limitations.
