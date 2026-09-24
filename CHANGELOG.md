# Changelog

Notable changes are recorded here, with Added, Changed and Fixed categories as
applicable. Releases follow [Semantic Versioning](docs/development/conventions.md#versioning).

## [Unreleased]

### Added

- Documentation index, onboarding/testing guides, feature guides, environment reference,
  ADR convention and v1.0.0 release snapshot.

### Changed

- Documentation baseline distinguishes implemented Phase 1 behavior from planned work
  and historical verification evidence.

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
