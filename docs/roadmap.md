# QYVRA delivery roadmap

**Phase 4 T03 orchestration, T04 PDF extraction and T05 chunking are implemented:** [durable stage contracts and lifecycle](phase-4-processing.md)
cover atomic successor scheduling, v2 transport, shared retry/recovery, worker routing,
lifecycle fencing and the owned status extension. [Durable PDF text extraction](phase-4-pdf-extraction.md)
is implemented. [Deterministic chunks and citation provenance](phase-4-chunk-generation.md)
are implemented. [T06 embedding generation and durable checkpoints](phase-4-embedding-generation.md) are implemented. [T07 Qdrant indexing, activation and cleanup](phase-4-vector-indexing.md) are implemented. [T10 grounded answers and validated citations](phase-4-rag-answers.md) and [T11 AI Search and authorized citation navigation](phase-4-ai-frontend.md) are implemented. OCR remains **Planned**. [T09 authorized semantic retrieval and search API](phase-4-semantic-search.md) are implemented and opt-in. [T08 upload/reprocess/restore enrollment and bounded backfill](phase-4-ingestion.md) are implemented and opt-in.

[Documentation index](README.md) | [v1.0.0 snapshot](releases/v1.0.0.md) | [v1.1.0 snapshot](releases/v1.1.0.md)

## Phase 1 — v1.0.0 released

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

At Phase 1 acceptance, CI was a foundation target but no CI/CD workflow was checked in. It was a deferred
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

| In-scope change (audit state)         | Purpose                                                       | Backend impact                                                                       | API impact                                                                                           | Frontend impact                                                                                                                         | Database impact                                           | Tests and dependency                                                                                              |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Editable description (MISSING)        | Explain a document in the owner's words.                      | Validate and persist on upload/PATCH; preserve old upload replay fingerprints.       | Add description to metadata reads/PATCH and optional upload input.                                   | Extend upload, edit and detail forms.                                                                                                   | Add nullable `documents.description`.                     | Omission/null/limits, ownership and replay; migrate first.                                                        |
| Current file summary (PARTIAL)        | Show which immutable file is current without opening history. | Select highest version number under owner scope.                                     | Add safe `currentVersion` to list/detail/PATCH.                                                      | Show filename, MIME, size, version and upload time in catalog/detail.                                                                   | Reuse `document_versions`.                                | Version replacement, archived rows and metadata-only fixtures; follows metadata contract.                         |
| More useful filters (PARTIAL/MISSING) | Narrow the catalog by current file, tags and dates.           | Build bounded predicates against owned documents/current version and existing joins. | Add filename, MIME, all-of tag IDs and created/updated ranges; retain `q`, category and old filters. | URL-backed controls for the new filters; reuse organization selectors/cache. Existing document/expiration date filters remain API-only. | Reuse relations/timestamps; assess indexes.               | Combinations, associations, ownership, archived/deleted rows and invalid ranges; follows current-version summary. |
| Additional sorts (PARTIAL)            | Order by recent edits, title or largest current file.         | Build deterministic sort/cursor predicates.                                          | Allow-list new sort values and compatible cursors.                                                   | Extend sort control and reset cursor when changing filters/order.                                                                       | Assess updated/title indexes; no copied file-size column. | Ties, null file summaries, cursor validation and old cursors; follows query design.                               |

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

## Phase 3 — v1.2.0 processing foundation (release ready)

T01 recorded the [foundation contract](phase-3-processing.md) and
[ADR-002](decisions/ADR-002-durable-processing-outbox-worker.md). **T02 and T03
are implemented:** the additive job/outbox migration, owner/version constraints,
versioned message intent, transaction-safe creation, lifecycle rules, and
conditional repository operations are in the repository.
v1.2.0 is not yet tagged; the processing path is runnable through T12 and was
exercised in T13. [T14 final acceptance](phase-3-acceptance.md) is complete and
records a release-ready decision, remaining dependency findings and deployment
verification limits. No v1.2.0 release tag has been created by acceptance.

**Implemented in T02:** PostgreSQL can persist version-specific jobs and
publication intents atomically using the new transaction helper. Job state is
separate from `Document.status`. T07 now calls this helper from both upload paths.

**Implemented in T03:** duplicate active creation returns the existing job,
claims spend one attempt, conditional state and lease-token checks fence competing
workers, bounded retries remain in PostgreSQL, and due/stale/outbox queries are
available. T05 and T09 now run the dispatcher and recovery coordinator.

**Implemented in T04:** RabbitMQ transport abstraction, versioned message
serialization, durable direct-exchange/queue topology with dead-letter resources,
mandatory persistent publication with confirms, and local Compose broker support.
At the T04 checkpoint, no outbox dispatcher or worker used it.

**Implemented and integration-verified in T05:** An independently
runnable outbox dispatcher polls PostgreSQL in bounded batches, claims due rows
with expiring leases, publishes the stored envelope through T04, and records
`PUBLISHED` only after confirmation. Failed publication remains `PENDING` with
bounded backoff. Confirmed-but-unrecorded delivery may be replayed with the same
message ID.

**Implemented and integration-verified in T06:** A dedicated non-HTTP NestJS
worker runs independently of the API and outbox dispatcher. Its RabbitMQ consumer
validates the versioned envelope, checks the durable job identity, delegates
conditional claims/outcomes to T03, and manually acknowledges only after a
durable decision. Invalid messages and unhandled job types go to the dead-letter
queue; interrupted deliveries can be redelivered. T08 registers the production
file-integrity handler and verifies the full processing path.

**Implemented and integration-verified in T07:** Both initial and subsequent
version uploads create a `VERIFY_STORED_FILE` job and outbox intent in the same
PostgreSQL transaction as the version and completed upload receipt. A replay of
the same upload key creates neither again. The HTTP request does not contact
RabbitMQ or wait for a worker. A live-broker test now follows a real upload through
T05/T06 and the T08 production handler. Messages dead-lettered before T08 deployment
still need explicit reconciliation.

**Implemented in T08:** The worker streams the stored original through the
shared storage adapter and compares actual size and SHA-256 against immutable
version metadata. T03 records success, bounded retry, or terminal failure before
acknowledgement. The worker mounts the private storage volume read-only.

**Implemented in T09:** The outbox runtime also coordinates due processing
retries and expired job leases using PostgreSQL. It creates one new durable
outbox intent per retry attempt; T05 alone publishes it. Stable jobs and bounded
attempts survive process and broker restarts.

**Implemented in T10:** The owned, read-only version processing-status API
reports PostgreSQL job state, retry timing and safe failures without exposing
transport or worker internals.

**Implemented in T11:** Redis stores only expiring, attempt-scoped progress;
the worker writes it best effort and the owned status API reads it optionally.
PostgreSQL remains authoritative after Redis loss.

**Implemented in T12:** The frontend shows current-version processing on document
detail and per-version status when inspecting history. Active jobs poll the owned
API every five seconds; terminal jobs stop polling. The document list avoids
per-row processing requests. Existing receipts, versioning, archive/restore,
soft deletion, metadata discovery, and ownership boundaries remain intact.

**Verified in T13:** An [isolated full-stack verification matrix](phase-3-verification.md)
covers upload-to-worker processing, owned status and UI, outages, retries, lease
recovery, restart, duplicate delivery, concurrency, malformed messages, migration,
and existing document workflows. **T14 is complete:** final affected tests,
Nginx smoke, lifecycle cancellation/restore fixes and canonical documentation
are recorded in the [acceptance review](phase-3-acceptance.md). T13 remains a
historical verification record rather than a release declaration.

**Planned / Future, outside this foundation:** text extraction, OCR, chunking,
reminders, permanent purge, AI providers, embeddings, Qdrant, semantic/RAG/chat,
agents, Elasticsearch, and hybrid retrieval. This narrows the older Phase 3
direction below; its broad feature list does not define the v1.2.0 deliverable.
The processing-status route is implemented at T10; optional Redis progress is implemented at T11.

## Phase 4 — v1.3.0 AI/RAG foundation (Complete; unpublished release candidate)

**T02 persistence implemented:** [the data foundation and verification](phase-4-data-foundation.md)
add owned extraction/chunk artifacts, immutable profiles, SQL embedding checkpoints,
run/index/pointer metadata and nullable Phase 3 job dependencies. Stage vocabulary
and durable orchestration are implemented by T03. Internal explicit run requests
produce stage intents. **T04 PDF extraction is implemented:** bounded isolated PDF.js parsing,
canonical owned artifacts and atomic chunk-stage intent publication. Automatic upload
wiring is implemented in T08; RAG handlers/routes are implemented in T10; AI UI is implemented in [T11](phase-4-ai-frontend.md).
**T05 implemented:** deterministic token-bounded chunk generation, UUIDv5 identity,
scalar-offset/page provenance and atomic successor publication. See [T05](phase-4-chunk-generation.md).
**T06 implemented:** [provider-agnostic embeddings and durable checkpoints](phase-4-embedding-generation.md), with native HTTP, full-batch validation, lease fencing and resumable retries. **T07 implemented:** [private Qdrant indexing, activation, artifact-only rebuild and lifecycle cleanup/reconciliation](phase-4-vector-indexing.md). **T08 implemented:** [owned asynchronous upload/reprocess/restore integration and bounded backfill](phase-4-ingestion.md). **T09 implemented:** [authorized semantic retrieval and search API](phase-4-semantic-search.md). **T10 implemented:** [bounded grounded RAG and validated citations](phase-4-rag-answers.md). **T11 implemented:** [semantic/RAG UI, authoritative readiness and owned citation navigation](phase-4-ai-frontend.md). **T12 verified:** [end-to-end security, recovery and release-readiness assessment](phase-4-verification.md); known non-blocking limitations remain, with no release tag.

T01 defines the [canonical architecture, contracts and acceptance](phase-4-ai-rag.md)
and ADR-003 through ADR-005, confirmed as implemented in T13. T01 documentation, T02 persistence, T03 orchestration and T04 PDF extraction are
implemented along with T05 chunks, T06 embeddings, T07 indexing, T08 ingestion and T09 retrieval; T10 grounded RAG is implemented; the AI frontend is implemented in T11. Extend Phase 3 instead of adding another processing
system. Initial scope is text-bearing PDF extraction, deterministic owned chunks,
provider-neutral embeddings, profile-isolated Qdrant, owned semantic retrieval and
grounded answers with server-validated source citations.

Follow the [ordered T02–T12 implementation table](phase-4-ai-rag.md#ordered-implementation-tasks-and-acceptance--planned):
data/constraints → durable stage and message extensions → extraction → chunks →
embedding checkpoints → private Qdrant/index cleanup → upload/reprocessing integration
→ authorized retrieval → grounded RAG → frontend/citations → full-stack acceptance.
Each slice requires focused verification. [T12](phase-4-verification.md) records
completed security/recovery/browser acceptance: **READY WITH KNOWN NON-BLOCKING
LIMITATIONS**, 8 October 2026. **T13 complete:** [release snapshot/notes](releases/v1.3.0.md),
changelog and [versioning/preparation assessment](phase-4-release-preparation.md)
finalize Phase 4. Implementation, local verification and release preparation are
complete; remote CI on the reviewed commit, tagging and publication remain separate
user-approved steps. No v1.3.0 release is declared or tagged; Phase 5 is not started.

OCR, classification/summaries, persistent chat, autonomous agents, multi-agent
orchestration, LangChain/LangGraph, MCP/Hermes, external actions, autonomous document
modification, voice, city/office visualization and local LLM orchestration are
excluded. Operational provider/model/parser choices, quotas, grounding thresholds,
retention and profile-switch coverage remain documented pre-release decisions.

## Later phases and earlier planning directions

| Phase | Direction                              | Planned additions                                                                                                                  |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 3     | Earlier processing/reminders direction | Broader ideas included extraction/OCR, reminders and purge/activity work. The narrower planned v1.2.0 foundation is defined above. |
| 4     | Earlier AI direction                   | Delivered foundation is defined above; specialized Ollama/local adapters remain future work.                                       |
| 5     | Advanced keyword and hybrid search     | Elasticsearch, highlights, autocomplete and ranking.                                                                               |
| 6     | Identity upgrade                       | Keycloak/OIDC, retaining internal ownership IDs.                                                                                   |

These are directions from the broader [product specification](specification.md), not
installed services; only the narrowed v1.2.0 foundation above is the current Phase 3
plan. Arbitrary custom metadata,
category hierarchies, bulk operations, Trash/permanent purge, historical-version
download/promotion, separate historical upload-date filtering, exact catalog counts
and CI/CD also remain outside v1.1.0. AI agents are a later product direction,
after grounded retrieval exists; no agent runtime is planned for this release.
Search indexes must be rebuildable from PostgreSQL metadata and private file storage;
v1.1.0 has no search, vector or AI runtime dependency.

Historical slice results remain in the [audit/evidence index](documentation-audit.md).
Future work should update the owning guides, add justified ADRs, record actual
verification and create a separate release snapshot.
