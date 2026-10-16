# Phase 5 T02 — Search persistence and versioned processing contracts

Status: **Implemented foundation**. Verification date: **13 October 2026**.
Baseline: v1.3.1 candidate on `v1.4.0`, HEAD `d86395f`, with the retained T01
documentation and this uncommitted T02 change set. `VERSION` remains `1.3.1`.

[Phase 5 plan](phase-5-search.md) | [Database](database.md) |
[ADR-007](decisions/ADR-007-rebuildable-keyword-search.md) | [Testing](development/testing.md)

T02 implements storage and explicit transport vocabulary only. No application
enrollment, search handler, Elasticsearch adapter/service, public search route,
frontend, bulk reindex, parser execution or AI/RAG change is introduced.

## Implemented persistence

The canonical entities are in [shared Prisma](../packages/database/prisma/schema.prisma).
[Migration 20261013010000_search_persistence](../packages/database/prisma/migrations/20261013010000_search_persistence/migration.sql)
adds four tables and the nullable `processing_jobs.search_projection_id` reference.
All 15 earlier migrations are unchanged; the chain now contains 16 migrations.
The new migration is transactional and seeds no generations, states, projections,
fanout events, jobs or backfill. Existing job references remain null.

| Model/table                                              | Ownership and purpose                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SearchIndexGeneration` / `search_index_generations`     | Global immutable mapping/analyzer/extractor/normalization/segmentation identity and physical metadata/page index names. Unique generation number, fingerprint and names; a partial unique index permits at most one SERVING generation.                                               |
| `DocumentSearchState` / `document_search_states`         | One owned document row, required desired file version, positive monotonic desired revision and optional ready projection. Composite FKs bind desired version and ready projection to the same document, owner and revision.                                                           |
| `VersionSearchProjection` / `version_search_projections` | Immutable owner/version/generation/revision build identity, metadata hash, optional owned canonical extraction, bounded record-ID manifest/hash, metadata readiness and separate text coverage. Unique version/generation/revision and composite owned identity/revision keys.        |
| `SearchProjectionChange` / `search_projection_changes`   | Durable owner-bound CATEGORY_DELETED/TAG_DELETED checkpoint, stable deleted-resource UUID, ordered document scan cursor and PENDING/COMPLETED state. Resource is deliberately not a FK to a row that will be deleted. Unique owner/reason/resource coalesces repeated event creation. |

No canonical document text, vectors, credentials, service URLs, raw errors or
duplicated processing attempts are added to search state. ProcessingJob continues
to own attempts, lease tokens, deadlines, retry availability, failure codes and
completion timestamps. All new timestamps use `TIMESTAMPTZ(3)` and UTC semantics.

Generation states are BUILDING → SERVING → RETIRED, or BUILDING → RETIRED.
Configuration/fingerprint/index names cannot be rewritten. SQL verifies the same
SHA-256 canonical tuple used by `searchGenerationFingerprint`; physical names
must be distinct server-owned `qyvra-search-*` names. Mapping schemaVersion is
independent of transport schemaVersion 3. Identical configurations reuse the
same generation; changing mapping identity requires another immutable generation.
Actual remote generation preparation/cutover verification belongs to T04/T10.

Projection states are BUILDING → READY/FAILED/REMOVAL_PENDING,
READY/FAILED → REMOVAL_PENDING, then REMOVAL_PENDING → REMOVED. Published/failed/
retired manifests are immutable except status and update time. Text coverage is
NOT_REQUESTED/PENDING/READY/UNSUPPORTED/FAILED; READY text requires canonical
extraction with matching owner/version/checksum and generation extractor identity.
Metadata readiness is separate; a metadata-only READY projection is valid.
Adding text to a published metadata-only manifest requires a new revision and
projection; a READY manifest cannot be rewritten.

READY requires metadata readiness, a nonempty verified record manifest, record
hash, timestamp and its metadata record ID. Record IDs must belong to that
projection, be distinct and match deterministic metadata/page-segment syntax;
count matches the JSON array. SQL hard caps are 10,000 records and 1 MiB manifest
JSON text. T04/T05 may apply stricter operational limits. READY publication checks
the current active version, desired revision and non-retired generation. A ready
document pointer additionally requires a SERVING generation. Revoke a pointer
before retiring its projection. Verified flags alone are not evidence of actual
Elasticsearch writes: T05 must verify remote contents before its leased SQL commit.

SQL locks the owned document for state/projection publication guards, matching
existing application lock order. Revision updates must keep the value or advance
exactly one; changing desired version requires advancing it. Revision advancement
clears the pointer. Existing document mutations are not automatically modified by
T02: transactional invalidation, enrollment, archive/delete/restore wiring and
fanout execution belong to T03. Future retrieval must always reauthorize current
SQL lifecycle/version/filter state, even if a retained pointer has become stale.

## Persistence primitives and idempotency

[SearchPersistenceRepository](../packages/database/src/search-repository.ts) exports
opt-in methods; no API/worker module registers it for automatic enrollment:

- `createGeneration`: idempotent immutable configuration creation; mismatched
  generation/name replay is rejected.
- `initializeStateInTransaction`: owned active current-version state initialization,
  with no job creation. No automatic legacy initialization/backfill.
- `advanceRevisionInTransaction`: expected-revision compare-and-swap under the
  document lock; callers own mutation atomicity. Two concurrent expected-revision
  writers cannot both advance it.
- `createProjectionInTransaction`: owned current desired revision creation, using
  deterministic UUIDv5(version UUID, generation UUID, revision). Conflicting metadata
  hash replay is rejected. The fixed namespace is part of the persisted contract.
- `createJobInTransaction`: ordinary ProcessingJob plus existing outbox in one
  caller-owned transaction. Equivalent active work returns its original job/message
  identifiers. Different active projection/predecessor conflicts rather than creating
  another job. Terminal same-projection replay is explicit and creates a new job
  generation. Existing version/type generation uniqueness and one-active index remain.
- `findProjection`: owner-scoped read; foreign IDs return no record.
- `createChangeInTransaction`: native conflict-ignoring insert plus owner/resource
  lookup avoids an emulated-upsert race without an additional lock system.
- `advanceChangeInTransaction`: cursor/status CAS; SQL rejects backwards cursors,
  changed owner/resource identity and completed checkpoint reopening.

[Identity helpers](../packages/database/src/search.ts) validate UUIDs, positive
32-bit revisions/schema versions, bounded configuration tokens and record indices.
`searchRecordId` returns `projectionUUID:metadata` or
`projectionUUID:page:pageNumber:segment`, with one-based pages and zero-based segments.
Generation/configuration fingerprints and projection identity functions never
include credentials or an embedding profile. They are storage contracts, not
new provider configuration.

## Versioned message contract

| Version | Allowed job types and fields                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Existing VERIFY_STORED_FILE and its unchanged ten-field envelope.                                                                                     |
| 2       | Existing six integrity/AI/vector-removal types and unchanged ten fields. Search types are rejected.                                                   |
| 3       | INDEX_SEARCH, EXTRACT_SEARCH_TEXT and REMOVE_SEARCH_INDEX only. Existing ten fields plus required searchProjectionId, indexGenerationId and revision. |

`ProcessingMessageV1/V2/V3` form a discriminated union.
`NewSearchJob` also discriminates search extraction, whose completed integrity
predecessor UUID is required, from indexing/removal, which do not accept it.
No userId or domain content is transported. The job/owned projection determines
owner, immutable generation configuration and canonical artifact references.

Example identifiers-only INDEX_SEARCH message (synthetic UUIDs):

```json
{
  "schemaVersion": 3,
  "messageId": "11111111-1111-4111-8111-111111111111",
  "type": "processing.execute",
  "occurredAt": "2026-10-13T00:00:00.000Z",
  "correlationId": "22222222-2222-4222-8222-222222222222",
  "jobId": "33333333-3333-4333-8333-333333333333",
  "documentId": "44444444-4444-4444-8444-444444444444",
  "documentVersionId": "55555555-5555-4555-8555-555555555555",
  "jobType": "INDEX_SEARCH",
  "dispatchSequence": 1,
  "searchProjectionId": "66666666-6666-5666-8666-666666666666",
  "indexGenerationId": "77777777-7777-4777-8777-777777777777",
  "revision": 1
}
```

[Transport parsing](../apps/api/src/infrastructure/messaging/processing-message.ts)
checks exact field sets, explicit versions/job-type pairing, UUIDs, positive safe
dispatch sequence, positive 32-bit revision, canonical ISO UTC time and a 4 KiB
serialized limit. Unknown versions, malformed/missing fields, additional content/
credentials/userId and pretending search work is v1/v2 are rejected. Parsing
returns stable ordered fields; serialization revalidates before emitting UTF-8 JSON.
SQL independently checks a v3 outbox payload against its durable job/projection,
message/correlation IDs, occurrence time, dispatch sequence, generation and revision.

`createProcessingOutboxIntent` selects v3 for search jobs, resolves the owned
projection and rejects incompatible/unknown explicit versions. Retry dispatch
preserves job/correlation/projection/generation/revision, advances dispatchSequence
and creates a new stable messageId for that intent; uncertain publication retries
reuse the same outbox/messageId. Broker publication remains outside transactions.

## Worker and recovery boundaries

Existing dispatcher/publisher/consumer serialization recognizes v3. Worker
dispatch rechecks document/version/job/correlation and exact projection/generation/
revision before execution. **There are no registered search handlers.** A live
nonterminal v3 delivery without a handler is dead-lettered before claiming an
attempt; it is never acknowledged as successfully completed. Terminal jobs retain
the existing acknowledgement behavior after identity validation.

Search job eligibility uses SQL desired revision/current active version and a
non-retired generation, independently of AI-run state. Removal can remain eligible
for archived/deleted/superseded projections in REMOVAL_PENDING/REMOVED. Existing
lease/attempt/retry machinery applies; search jobs do not enter `ensureNextStage`'s
AI successor chain. Recovery candidate scans recognize removal eligibility but
T03 still owns actual lifecycle cancellation/cleanup scheduling.

SQL prevents successful INDEX_SEARCH completion without a READY projection,
EXTRACT_SEARCH_TEXT without the exact completed integrity predecessor and matching
canonical PDF extraction output, or removal without REMOVED projection state.
Committed extraction outputs cannot be cleared/replaced. No fake successful
handler is added. Production parser/index/removal execution belongs to T05/T10.

## Compatibility, upgrade and downgrade

Apply the normal migration chain to a backed-up installation; never edit an applied
historical migration or reset existing data/volumes. T02 adds no required runtime
settings, packages, services, enrollment flags or startup seed. Original document,
version, receipt, auth and AI records remain unchanged. Existing v1/v2 messages and
semantic/RAG/provider configuration keep their behavior; processing-status job
vocabulary can recognize future search types without exposing internal projections.

Old consumers reject v3 and cannot execute search work. Do not run them alongside
active v3 enrollment. T03 rollout must disable enrollment, drain/replace consumers
and roll matching API/outbox/worker before enabling new intents. A schema-compatible
old query is not proof of a complete binary downgrade: old schedulers do not know
search eligibility/recovery. Prefer a compatible runtime with search disabled;
full downgrade/backup restore certification remains T11. No down migration or
automatic production rollback is supplied or claimed here.

## Verification and limits

Use installed PostgreSQL 17 on a disposable database whose name contains `test`.
Commands run after shared build; Windows uses `npm.cmd` where PowerShell blocks
the unsigned npm.ps1 shim.

```sh
npm --prefix packages/database run build
npm --prefix packages/database run test:search
npm --prefix packages/database run test:search:migration
```

`test:search` requires migrated TEST_DATABASE_URL. The upgrade command requires
a separate **empty** TEST_SEARCH_MIGRATION_DATABASE_URL; it deploys all 15 v1.3.1
migrations, seeds synthetic auth/version/receipt/job/outbox/extraction/profile
records, deploys T02, verifies preservation/empty search tables and redeployment,
and checks rollback. It never resets a database. Temporary migration directories
are bounded to the database package. Existing Phase 3 upgrade tests now account
for the additional null job reference, preserving their assertions.

The CI workflow retains all existing service/build/regression gates and adds these
SQL suites plus a separate search-upgrade database. No Elasticsearch service or
paid-model call is added. Local results and infrastructure limits are reported
below; final-commit remote CI is not claimed.

| Verification                                                              | Result                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh PostgreSQL migration chain                                          | PASS: 16 migrations on an isolated PostgreSQL 17.3 cluster; no production/developer database or original storage used.                                                                     |
| Search identity/persistence suite                                         | PASS: 14 tests including real ownership/FKs, concurrency, revision/publication fences, rollback, v3 outbox, retries, canonical output and fanout CAS.                                      |
| v1.3.1 → T02 upgrade                                                      | PASS: seeded prior records preserved, no search backfill, redeployment and rollback; one real migration test.                                                                              |
| Existing Phase 3 upgrade regression                                       | PASS: one real migration test.                                                                                                                                                             |
| Existing database processing and AI suites                                | PASS: 27 processing and 21 AI tests, including real PostgreSQL.                                                                                                                            |
| API unit tests                                                            | PASS: 45 suites, 518 passed and one existing skipped test.                                                                                                                                 |
| API HTTP tests                                                            | PASS: 15 suites, 281 passed; database doubles, not real-SQL certification.                                                                                                                 |
| Targeted existing SQL API regression                                      | PASS: four suites, 42 passed, seven skipped; version/document/status/outbox coverage. Broker/Redis/file-inspection dependent cases were not executed.                                      |
| New v3 SQL outbox/worker integration                                      | PASS: one real PostgreSQL integration test with publisher double; canonical publication once and missing-handler rejection with zero attempts/completion. Not live RabbitMQ certification. |
| Legacy parser/serialization characterization                              | PASS: the baseline parser rejects all three v3 search types; v1 and all six v2 envelopes serialize byte-for-byte identically. This does not certify a full binary downgrade.               |
| Schema/type/lint/build                                                    | PASS: database schema/build/typecheck/lint, API lint/typecheck/build/full formatting, and T02 source/test/Markdown/YAML formatting.                                                        |
| Database-wide formatting                                                  | PASS: initial checkout CRLF failures in `ai.ts` and `ai-scheduling.ts` resolved by LF normalization, with no Git content diff; full package formatting passes.                             |
| Live RabbitMQ/Redis/Qdrant/Elasticsearch, Compose, browsers and remote CI | Not Executed by T02. Docker daemon unavailable; no new search service was deployed. Existing deterministic transport/provider tests are not live-service passes.                           |

Initial focused tests exposed a v2-only retry selector and compound-upsert fanout
race; both were fixed and rerun. Test fixtures were corrected to respect existing
PDF page-count/archive constraints and creation/claim timing; the new integration
test respects existing PENDING job status after outbox publication. These are not
new catalog/lifecycle semantics.

Final documentation review resolves 339 local targets and 28 heading anchors;
Git whitespace checks pass. Historical migration files and release snapshots,
lockfiles, frontend manifests and base Compose remain unchanged. The isolated
test cluster is stopped after verification; no developer database, files or
volumes were migrated or removed. No commit, tag, push or release occurred.

## Deferred scope and next task

T03 wires document/version/metadata/association mutation enrollment, immediate
SQL revocation, restore and durable fanout processing. T04 adds Elasticsearch
transport/configuration; T05 implements model-independent extraction/indexing;
T06 onward deliver search APIs, ranking, UI and maintenance. Full Phase 5 remains
unfinished; no acceptance/release is implied by this foundation.

**Next: T03 — Search enrollment, lifecycle fencing and durable fanout.** Connect
indexed mutations to existing jobs/outbox atomically, preserve upload replay,
revoke stale revisions immediately, keep cleanup eligible and scan organization
deletions in bounded resumable batches without remote I/O inside transactions.
