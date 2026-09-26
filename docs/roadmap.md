# Brainless delivery roadmap

[Documentation index](README.md) | [v1.0.0 snapshot](releases/v1.0.0.md) | [v1.1.0 snapshot](releases/v1.1.0.md)

## Current release

**Phase 1 is complete and released as v1.0.0 on 24 September 2026.** The
[acceptance review](phase-1-review.md) and [browser verification](phase-1-browser-verification.md)
record evidence. Completed scope:

- API configuration, HTTP envelopes/validation, logging, health and generated OpenAPI.
- PostgreSQL/Prisma lifecycle, constraints and migrations.
- Local authentication, profile/password settings and session APIs.
- Categories/tags and owned document metadata/lifecycle.
- Private storage, validated uploads, checksums, idempotency and immutable versions.
- Current-file download, catalog/detail/upload/history/organization/account UI.
- Local Compose/Nginx startup, migrations, persistence and isolated browser verification.

CI was a foundation target but no CI/CD workflow is checked in. It is a deferred
engineering gap, not evidence that the delivered usable-tracker acceptance failed.
See the snapshot for precise limitations; do not redo completed Phase 1 slices.

## Phase 2 — v1.1.0 (release ready)

**Objective:** Make owned documents easier to describe, browse and find by their
metadata and current file, while keeping the existing catalog and version workflows.
Phase 2 implementation and acceptance are complete. The local `v1.1.0` release
tag is verified in the [developer version comparison](developer/versions/v1.1.0.md#version-and-comparison-provenance).
The audit-state table below preserves the original planning assessment; it does
not describe missing functionality in the shipped implementation. The
[API](api.md#v110-document-contract), [database](database.md#v110-description-migration-and-query-design)
and [architecture](architecture.md#v110-document-query-boundary) sections
describe the implemented contract.

| In-scope change (audit state) | Purpose | Backend impact | API impact | Frontend impact | Database impact | Tests and dependency |
| --- | --- | --- | --- | --- | --- | --- |
| Editable description (MISSING) | Explain a document in the owner's words. | Validate and persist on upload/PATCH; preserve old upload replay fingerprints. | Add description to metadata reads/PATCH and optional upload input. | Extend upload, edit and detail forms. | Add nullable `documents.description`. | Omission/null/limits, ownership and replay; migrate first. |
| Current file summary (PARTIAL) | Show which immutable file is current without opening history. | Select highest version number under owner scope. | Add safe `currentVersion` to list/detail/PATCH. | Show filename, MIME, size, version and upload time in catalog/detail. | Reuse `document_versions`. | Version replacement, archived rows and metadata-only fixtures; follows metadata contract. |
| More useful filters (PARTIAL/MISSING) | Narrow the catalog by current file, tags and dates. | Build bounded predicates against owned documents/current version and existing joins. | Add filename, MIME, all-of tag IDs and created/updated ranges; retain `q`, category and old filters. | URL-backed controls for the new filters; reuse organization selectors/cache. Existing document/expiration date filters remain API-only. | Reuse relations/timestamps; assess indexes. | Combinations, associations, ownership, archived/deleted rows and invalid ranges; follows current-version summary. |
| Additional sorts (PARTIAL) | Order by recent edits, title or largest current file. | Build deterministic sort/cursor predicates. | Allow-list new sort values and compatible cursors. | Extend sort control and reset cursor when changing filters/order. | Assess updated/title indexes; no copied file-size column. | Ties, null file summaries, cursor validation and old cursors; follows query design. |

Existing category/tag CRUD, lifecycle, download, version upload/history and cursor
pagination are Phase 1 capabilities. They were modified only where a row above
needed them. No new document endpoint was added.

### Implementation stages and checklist

**Planning**

- [x] Audit source, schema, tests and Phase 1 documentation; record gap analysis.
- [x] Finalize v1.1.0 scope and planned API/database/architecture contract.

**Database and metadata**

- [x] Add the nullable description migration and schema/constraint tests without changing applied migrations or existing rows.
- [x] Extend upload, PATCH and read paths for description; preserve prior idempotency receipts and fingerprints.
- [x] Add the owned current-version summary to document reads without exposing storage keys or checksums.

**Listing API**

- [x] Extend validated filters, including current filename/MIME, all-of tags and created/updated ranges.
- [x] Extend allow-listed sorts and compatible, deterministic cursors.
- [x] Review owner-scoped query paths and existing indexes; no new index was justified without a populated workload. Defer representative `EXPLAIN (ANALYZE, BUFFERS)` before any future performance migration.
- [x] Update generated OpenAPI decorators and targeted HTTP/PostgreSQL tests for new contracts, invalid input and ownership.

**Frontend**

- [x] Extend document API schemas, URL parsing/query serialization and metadata editing for description.
- [x] Extend the existing catalog filters/sorts and current-file display.
- [x] Extend document detail with full description and current-file metadata.
- [x] Add optional description to the upload form using the existing multipart client.
- [x] Review organization cache refresh, responsive layout, theme and accessibility with focused UI tests, existing Phase 1 evidence and final source review.

**Acceptance and release**

- [x] Complete focused integration verification of implemented v1.1.0 slices (25 September 2026): isolated Phase 1-to-v1.1.0 migration upgrade, 52 PostgreSQL API integration tests, 91 HTTP contract tests, 30 document unit tests and 106 focused frontend tests passed; API/web type checks, targeted lint and formatting passed. The API build passed. The web build was blocked by Google Fonts network access in the verification environment.
- [x] Run focused API/frontend checks during each slice and one affected regression/browser pass near completion.
- [x] Verify migration upgrade and document workflows through Compose/Nginx if the runtime path is affected.
- [x] Run real v1.1.0 browser E2E through isolated Docker Compose and Nginx (25 September 2026): all six Playwright tests passed, including upload description, metadata/version workflows, filters, sorts, cursor traversal, ownership and Phase 1 regressions. Final release acceptance remains separate.
- [x] Update guides to implemented behavior, record results, changelog and a separate v1.1.0 release snapshot.
- [x] Complete final acceptance (25 September 2026): 11 document unit, 70 document HTTP and 100 affected frontend tests passed, along with API/web type checks and lint, Prisma validation and API build. Accept the previously passing Docker web build and six-test Nginx browser run because runtime code did not change afterward. No unresolved release blocker remains.

## Later phases — not part of v1.1.0

| Phase | Direction | Planned additions |
| --- | --- | --- |
| 3 | Processing and reminders | Workers, RabbitMQ, Redis where justified, extraction/OCR, progress, retries, reminders, purge/activity work. |
| 4 | Reviewable AI and semantic retrieval | Independent generation/embedding adapters, Ollama/OpenAI options, Qdrant, cited RAG. |
| 5 | Advanced keyword and hybrid search | Elasticsearch, highlights, autocomplete and ranking. |
| 6 | Identity upgrade | Keycloak/OIDC, retaining internal ownership IDs. |

These are directions from the broader [product specification](specification.md), not
committed release versions or installed services. Arbitrary custom metadata,
category hierarchies, bulk operations, Trash/permanent purge, historical-version
download/promotion, separate historical upload-date filtering, exact catalog counts
and CI/CD also remain outside v1.1.0. AI agents are a later product direction,
after grounded retrieval exists; no agent runtime is planned for this release.
Search indexes must be rebuildable from PostgreSQL metadata and private file storage;
v1.1.0 has no search, vector or AI runtime dependency.

Historical slice results remain in the [audit/evidence index](documentation-audit.md).
Future work should update the owning guides, add justified ADRs, record actual
verification and create a separate release snapshot.
