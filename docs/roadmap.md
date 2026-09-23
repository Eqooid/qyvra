# Brainless Delivery Roadmap

## Phase 1 checklist (final browser verification, 23 September 2026)

Phase 1 usable-tracker acceptance is complete. Checked items have implementation
and passing verification evidence. See [final results](phase-1-browser-verification.md).
The older implementation reports below retain historical verification details.

- [x] API foundation, validated configuration, health, logging and envelopes.
- [x] PostgreSQL lifecycle, Prisma shared package and persistent PostgreSQL Compose service.
- [x] Authentication, profile/password updates and session management.
- [x] Next.js authentication, protected dashboard shell and responsive navigation.
- [x] Next.js account settings: profile editing, password change and confirmed logout-all; component and real Nginx browser checks passed.
- [x] Categories: schema, owned CRUD, constraints, pagination and tests; all required checks passed.
- [x] Tags: owned CRUD/search, normalized uniqueness, pagination and all required verification passed.
- [x] Document metadata foundation: owned list/detail/update, associations and verified tests.
- [x] Public document creation (with streaming upload and first immutable version).
- [x] Provider-neutral streaming storage and private local filesystem adapter; validated configuration, DI and tests.
- [x] Validated streaming upload (PDF/JPEG/PNG, bounded receiving/inspection, owned metadata).
- [x] SHA-256 checksums and concurrent same-owner duplicate protection.
- [x] First immutable document version and durable upload idempotency.
- [x] Additional immutable version uploads and version history endpoints; concurrency, replay and ownership tests verified.
- [x] Secure current-version download: ownership, streaming, safe headers and failure/abort tests verified.
- [x] Metadata archive, restore and document soft deletion; file lifecycle remains deferred.
- [x] Next.js document-management pages and real browser workflow tests.
- [x] Frontend document data-access layer and `/documents` list: URL filters, cursor pagination, responsive states and automated/browser checks.
- [x] Live API/browser catalog through Nginx.
- [x] Next.js document upload page: multipart metadata, progress/cancellation, retry idempotency and verified frontend tests/build.
- [x] Live API upload and active cancellation through Nginx; aborted request/storage cleanup verified.
- [x] Next.js document detail, metadata editing, current-file download, archive/restore and confirmed soft deletion; frontend checks passed.
- [x] Live API detail/actions, download byte comparison, archive/restore/soft delete.
- [x] Next.js version-history page and upload-new-version UI: paginated metadata, immutable upload, replay-safe refresh and frontend/browser verification passed.
- [x] Next.js Categories and Tags management: owned lists, validated create/edit, confirmed deletion, cache refresh and frontend/browser checks passed. See [verification](web-organization-implementation.md).
- [x] Live category/tag CRUD, assigned-category deletion conflict, and safe removal of an assigned tag.
- [x] Live version history/upload and latest-version download through Nginx.
- [x] Nginx configuration: nginx -t, public routing and cookie authentication verified.
- [x] Compose images, service health, migrations, and database/file persistence across API/web recreation verified with isolated volumes. See [setup/verification](compose.md).
- [x] Ownership and document-workflow browser integration tests through Nginx.
- [x] Final Phase 1 acceptance verification: 174 component tests, three real browser tests, frontend checks/build and Docker integration passed. CI automation is not added by this task.

Dependency order: Categories, Tags, document metadata, storage/upload/checksums,
versions/download, document pages, deployment, final verification. The current
latest frontend run completes account settings and real browser verification. See
[current acceptance results](phase-1-browser-verification.md) for exact checks;
older implementation reports below are historical evidence.
RabbitMQ, Redis, extraction/OCR, search indexes,
embeddings, AI/chat, reminders and Keycloak are not Phase 1 requirements.

Categories verification: 158 unit tests, 58 PostgreSQL integration tests, 148 HTTP
end-to-end tests, Prisma formatting/validation/generation, linting, type checking,
formatting and production build passed. See [Categories implementation report](categories-implementation.md)
for migration, commands, files and limitations. That run stopped after Categories.

Tags follow-up verification passed: 165 unit tests, 66 PostgreSQL integration tests,
179 HTTP tests, Prisma formatting/validation/generation, API formatting/lint/type
checks and production build. See [Tags implementation report](tags-implementation.md)
for files, migration, search/deletion semantics and commands.

Document metadata follow-up verification passed: 175 unit tests, 76 PostgreSQL
integration tests and 232 HTTP tests; Prisma formatting/validation/generation,
migration deployment to an isolated test database, formatting/lint/type checking
and API production build. The final cursor/Swagger changes passed targeted reruns.
See [Document metadata implementation report](document-metadata-implementation.md)
for exact commands, changed files, migration, ownership and transition policy.
No public document creation, storage, files, versions or frontend work was added.

Storage follow-up: `@brainless/storage`, local streaming adapter, NestJS binding,
required private root configuration and optional API Compose profile are verified.
Storage tests passed on Linux (3 unit + 12 integration; none skipped). Windows
passed all tests except the file-symlink privilege case, covered by Linux; junction
checks passed on both. API regression tests passed: 178 unit, 76 PostgreSQL
integration and 232 HTTP tests. Formatting, lint, type checking, shared/API builds,
Docker image build, Compose validation and private-mount container smoke checks
passed. See [storage implementation report](storage-implementation.md).
At that historical checkpoint HTTP upload/download, creation, versions and checksums
were not implemented. The upload follow-up below supersedes that limitation.

Upload follow-up: authenticated multipart POST /documents now creates UPLOADED
documents with immutable PENDING version 1, incremental SHA-256, owned associations,
concurrent checksum protection, durable scoped idempotency and compensating cleanup.
Prisma formatting/validation/generation and both new migrations passed on an isolated
PostgreSQL database. Verification passed: 181 API unit tests; 93 full-suite PostgreSQL
tests followed by all 19 expanded upload integration tests; 238 HTTP end-to-end tests;
format/lint/type checks; API/shared production builds and Docker image build. Linux
storage regression: 15 passed, no skips; Linux upload workflow: 17 passed. Windows
storage: 14 passed with one symlink-privilege skip covered by Linux. See
[upload implementation report](upload-implementation.md) for commands, files,
limitations, qpdf setup and crash reconciliation policy. No download, additional
versions, processing, frontend or Phase 2 work is included.

## Current implementation status

Document detail/actions verification: formatting, lint, TypeScript, all 110 frontend
tests (30 new detail/action cases), and production build passed. Production-browser
checks passed metadata editing, native attachment download, archive/restore/delete,
dialog focus management and both themes at desktop/mobile widths without overflow
or console/hydration errors. Browser requests were intercepted; the real configured
API was offline. Its detail response has no current-file metadata and normal detail
does not expose soft-deleted rows. Those limits and the download-header probe are
documented in the [detail report](web-detail-implementation.md). No backend, schema
or environment changes were made. Phase 1 remains incomplete.

Document-upload frontend verification: formatting/check, lint, TypeScript, all 80
frontend tests (35 new upload cases), and Next.js production build passed. Browser
checks passed PDF/JPEG/PNG submission flows, invalid selection, keyboard cancellation,
preserved metadata, success navigation and both themes at 1440px/390px without
overflow or console/hydration errors. Those checks intercepted the API boundary;
the configured local API was unavailable, so real storage/parser/CORS verification
remains unchecked. No backend or migration changes were made. See
[upload-page report](web-upload-implementation.md) for files, retry policy, optional
public size setting and generic-error contract limitations. Detail and version UI
remain pending.

Document-list frontend verification (16 September 2026): formatting, linting,
TypeScript checking, all 45 frontend tests and the Next.js production build passed.
The browser passed light/dark themes at desktop/mobile widths, URL search/back
navigation, keyboard disclosure and search-focus checks without console/hydration
errors. Browser checks used API-boundary fixtures; the configured real API was
offline, so live integration remains unchecked. No backend changes were made.
See [document-list report](documents-list-implementation.md). Upload and detail
links deliberately target the next tasks' routes; those pages remain unimplemented.

Additional versioning verification passed: 211 unit tests, 112 PostgreSQL integration
tests, 264 HTTP tests, followed by 80 targeted HTTP checks after the UUID-routing fix.
Prisma formatting/validation/generation, all ten migrations on isolated PostgreSQL,
API formatting/lint/type checking and API/shared production builds passed. Storage
passed all 15 tests on Linux, covering the Windows symlink privilege skip. See
[versioning report](versioning-implementation.md) for migration, files, contracts,
commands and limitations. Authentication behavior is preserved; no frontend or
processing work was added.

Current-version download verification passed: 195 API unit tests, 99 PostgreSQL
integration tests (including initial upload and upload-to-download), 249 HTTP
end-to-end tests, format/lint/type checks and API/shared production builds. Current
storage tests passed on Linux: 15 with no skips, covering the one Windows symlink
privilege skip. A 32 MiB generated-stream test verifies bounded chunks/backpressure
and abort/read-failure tests verify cleanup without false completion. No migration,
new dependency, authentication change or version-history endpoint was needed.
See [download implementation report](download-implementation.md).

The web app now connects to the implemented authentication API: registration,
login, safe current-user loading, protected dashboard navigation, responsive shell,
logout and serialized session refresh. Forms use React Hook Form/Zod; remote state
uses TanStack Query. Browser tokens stay in HttpOnly cookies. See `apps/web/README.md`
for the separate public API URL setting and required API CORS configuration.
The dashboard has an explicit empty state; this does not complete document features.

**Historical review (superseded by the 23 September acceptance result above).** See the
[acceptance review](phase-1-review.md) for evidence and verification results.
Authentication foundation completion is not completion of the usable-tracker phase.
The 13 September 2026 review passed Prisma validation/generation, formatting,
linting, type checking, 140 unit tests, 80 HTTP tests, and the production build.
Database integration verification failed because an isolated `TEST_DATABASE_URL`
was missing and Docker's Linux engine was unavailable. Historical passing counts
do not replace this failed current run. See the review report for setup steps.
At that review, outstanding work included document UI, Nginx/full deployment and CI.
Versioning and metadata restore satisfy their API scope despite historical catalog
rows labeling them MVP+; complete end-user workflow verification remains pending.

The basic API foundation is implemented: strict TypeScript, validated port/CORS
settings, the `/api/v1` prefix, global DTO validation, shutdown hooks, application
information, and foundation tests. PostgreSQL Compose, shared Prisma generation,
startup/shutdown lifecycle, and database readiness are implemented. CI remains
pending. Phase 1 authentication storage is implemented with its first migration
and constraint tests. Local registration is implemented with Argon2id and atomic
account creation. Local login now verifies Argon2id, enforces PostgreSQL-backed
temporary lockout, and creates hashed sessions with HttpOnly cookies and last-login
metadata. Reusable session authentication and `GET /api/v1/auth/me` now expose the
authenticated public profile and throttle last-seen writes. Refresh rotation,
database-backed reuse detection, idempotent logout and their CSRF checks are now
implemented. Owned session listing, single-session revocation and revocation of
all other sessions are implemented with CSRF and ownership checks. GET /me,
profile updates, local password changes with atomic other-session revocation, and
logout-all are now implemented. No new schema or migration is required. Verification
for this follow-up passed on 14 September 2026: 151 unit tests, 114 HTTP tests,
51 PostgreSQL integration tests, formatting, linting, type checking, Prisma validation
and generation, and the API production build. The review counts above are historical;
the isolated PostgreSQL follow-up resolves that review's database-verification blocker.
Owned document metadata and recoverable lifecycle are now implemented as recorded
above. Public creation with first-version upload and secure current-version download
were verified, as were additional versions; document UI was incomplete at that time.

Typed startup configuration now also covers environment/name, HTTP bind address,
the required PostgreSQL URL, session policy, and cookie settings, with validation
and startup integration tests. Registration also has configurable password length rules.

API observability is implemented: structured logging with redaction, correlation
ID propagation through asynchronous services, request completion/failure logs,
and centralized safe HTTP error mapping with automated tests.

Liveness/readiness probes and Swagger documentation are implemented for the
current runtime, including PostgreSQL readiness. Other dependency checks remain
deferred until the API actually uses those dependencies.

# 15. Delivery roadmap

Phase 1 authentication hardening now includes request throttling, bounded JSON
bodies, secure HTTP headers and additional configuration/redaction/session-race
tests. Multi-replica deployments still need shared edge throttling; no later-phase
infrastructure or additional authentication features were introduced.

| **Phase** | **Deliverable**  | **Enabled stack**          | **Exit condition**                                |
| --------- | ---------------- | -------------------------- | ------------------------------------------------- |
| 0         | Foundation       | NestJS, PostgreSQL, Docker | Migrations, modules, CI tests, health             |
| 1         | Usable tracker   | \+ Nginx, object storage   | Auth, CRUD, upload/download, categories/tags      |
| 2         | Processing       | \+ RabbitMQ, Redis         | Extraction, progress, retries, reminders          |
| 3         | Local/hosted AI  | \+ Ollama/OpenAI, Qdrant   | Reviewable extraction, semantic search, cited Q&A |
| 4         | Advanced search  | \+ Elasticsearch           | Keyword, highlights, autocomplete, hybrid ranking |
| 5         | Identity upgrade | \+ Keycloak                | OIDC migration without changing domain ownership  |

## 15.1 Suggested first development backlog

28. Create monorepo, Docker Compose, configuration validation and health endpoints.

29. Implement users, local credentials, identities and session authentication.

30. Implement categories, tags and document metadata migrations.

31. Add object storage adapter and validated single-file upload.

32. Build document list, upload and detail pages.

33. Add versioning, checksum duplicate detection and authorized download.

34. Add worker, RabbitMQ job records and incremental text extraction.

35. Add processing status UI, retries and Redis progress.

36. Add provider-neutral AI interfaces, Ollama/OpenAI adapters and profiles.

37. Add chunks, embeddings, Qdrant search and document-scoped RAG.

38. Add Elasticsearch only after semantic search and core workflows are stable.

# 16. MVP acceptance criteria

| **Area**       | **Acceptance criterion**                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Authentication | A user can register, log in, remain authenticated through an HttpOnly session, log out, and cannot access another user's data. |
| Upload         | A valid supported file is stored durably with checksum and version metadata; invalid or oversized files are rejected clearly.  |
| Catalog        | A user can list, filter, open, edit, categorize, tag, archive, restore, and soft-delete owned documents.                       |
| Download       | Only the owner can obtain the original file; storage paths are never accepted directly from the client.                        |
| Versioning     | A new file version does not overwrite the prior immutable version.                                                             |
| Failure        | Database or storage failure does not leave a falsely successful document record.                                               |
| Deployment     | The MVP starts through documented Docker Compose commands and is reached through Nginx.                                        |
| Tests          | Critical ownership, upload, and document CRUD paths pass automated integration tests.                                          |

## 16.1 Phase 3 AI acceptance criteria

- Every AI result records provider, model, prompt version, duration, and status.

- Extracted critical values are pending until explicitly verified.

- Semantic queries use the same embedding profile as indexed chunks.

- Every RAG answer contains valid owned-document citations or reports insufficient evidence.

- A failed provider call does not make the original document inaccessible.

- Existing chunks can be re-embedded into a new Qdrant collection without re-uploading the PDF.
