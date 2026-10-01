# Changelog

Notable changes are recorded here, with Added, Changed and Fixed categories as
applicable. Releases follow [Semantic Versioning](docs/development/conventions.md#versioning).

## [Unreleased]

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
