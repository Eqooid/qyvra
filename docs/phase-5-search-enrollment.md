# Phase 5 T03 — Search enrollment, lifecycle fencing and durable fanout

Status: **Implemented and locally verified; live transport verification outstanding.** Phase 5 remains
unreleased; `VERSION` remains `1.3.1`, with `v1.4.0` the planned target.
The owning scope is [T01](phase-5-search.md#t03--search-enrollment-lifecycle-fencing-and-durable-fanout),
built on [T02](phase-5-data-foundation.md). No Elasticsearch indexing, deletion,
text extraction, search endpoints or frontend functionality is added here.

## Enrollment and transaction boundaries

`SearchEnrollmentService` delegates database-only work to the shared
`SearchEnrollmentRepository`. Documents, categories, tags and the existing
outbox recovery process import its small module; it does not import semantic
retrieval or AI provider modules. Enable enrollment with
`SEARCH_ENROLLMENT_ENABLED=true` and a lowercase 64-character
`SEARCH_GENERATION_FINGERPRINT` identifying a provisioned non-retired
`SearchIndexGeneration`. Startup rejects missing/retired generations. Defaults
are disabled; neither startup nor migration creates a generation. API and outbox
must share this policy; base Compose forwards both settings to both runtimes.

| Trigger | SQL transaction behavior |
| --- | --- |
| Initial upload | After version, integrity job and initial tag associations, create desired state, BUILDING projection, INDEX_SEARCH job and v3 outbox intent before completing the receipt. |
| New version upload | Select the immutable newest owned version, advance desired revision, clear publication, cancel old build/extraction jobs, retain old cleanup intent, enroll the new projection. |
| Metadata/category/tag association PATCH | Compare canonical metadata; advance and replace incompatible projection within the same mutation transaction. |
| Archive or soft-delete | Clear publication and advance revision, cancel build/extraction work, retire live manifests and schedule cleanup even if enrollment is disabled. Duplicate no-op lifecycle requests do not advance again. |
| Restore | Recheck current version and active lifecycle; create a new revision instead of reactivating an old remote pointer. Existing integrity/AI restore scheduling remains in its transaction. |
| Organization deletion | Delete and create an owner-bound fanout checkpoint atomically; recovery compares canonical membership in bounded batches. |

An eligible version is the latest version of an owned document with no
`deletedAt`, no archive flag, and status other than ARCHIVED/DELETING. Every
supported uploaded MIME type is eligible for metadata enrollment; PDF extraction
is deferred. Catalog documents without versions stay unenrolled. No historical
backfill or new public reprocessing operation is introduced.

Document ownership is validated under the existing document row lock. SQL FKs and
deterministic projection identity continue to bind owner, document, version,
generation and revision. Document/version, associations, search state, processing
job and outbox changes commit together. Scheduling failure rolls them back,
including the completed upload receipt and integrity intent. Storage compensation
and upload reservation behavior remain owned by the existing upload service.
There is no RabbitMQ, Elasticsearch, storage or provider I/O inside these hooks.

## Canonical metadata and lifecycle fences

Additive migration `20261014010000_search_lifecycle_fencing` introduces
`search_metadata_hash(uuid)` and two publication guards; it adds no tables,
columns, backfill or remote work. T02 entities, FKs and indexes are reused.
This is a narrow addition to T01's initial “migrations only in T02” assumption:
canonical association fencing requires executable SQL that T02 did not provide.
The verified T02 migration is preserved, rather than edited retroactively.

Hash format `qyvra.search-metadata.v1` is SHA-256 over PostgreSQL JSONB array text
encoded as UTF-8: document/owner/version IDs, title, description, document type,
status, issuer, reference, category ID, document/expiration dates, document
created/updated UTC timestamps, immutable version number, filename, MIME type,
size, version created UTC timestamp and sorted tag IDs. Names of categories/tags
are omitted, so renames require no fanout. The shared database client explicitly
sets UTC session time, preventing local database timezone interpretation from
disagreeing with v3 ISO timestamps. Use the SQL hash function rather than a second
application JSON serializer. The function is volatile so guards recompute after
acquiring the authoritative document lock.

Desired revision advances by one with a conditional owned update. Publication
must point to the current eligible version/revision, a READY manifest in a SERVING
generation, and the current canonical hash. T03 guards require the hash for READY
manifest/publication writes; the existing job eligibility check now compares it
before claims, completions, retries and recovery. Revision changes clear the
pointer before changing old manifests to REMOVAL_PENDING. Retired generation,
old version/revision, changed membership and archived/deleted documents cannot
successfully publish stale work. Cancellation is terminal supersession rather
than a retryable infrastructure error; existing cancelled-job redeliveries are
acknowledged after identity validation.

Tag deletion cascades associations without updating every document timestamp.
Canonical membership checks apply immediately, while checkpoint processing later
advances affected revisions. A READY pointer can still reference an obsolete
hash during fanout lag; the future authorized search query **must revalidate the
current hash and lifecycle**, as T01 requires. A racing publication transaction
does not replace that read-time requirement. Existing v1.3.1 APIs do not read the
lexical index, and T03 exposes no external search content.

Assigned categories still cannot be deleted: the existing restrictive FK produces
the existing conflict response. Only a successful unassigned-category deletion
creates a checkpoint. T03 does not silently unassign documents or change this API
policy. Tag deletion creates a checkpoint in its deletion transaction.

## Durable fanout, idempotency and delivery

The existing `ProcessingRecovery` loop calls the bounded search reconciler after
legacy retry/pipeline reconciliation. There is no second persistent scheduler.
Each pass handles one pending checkpoint and at most `min(batchSize,100)` owned
document states ordered by document UUID after its durable cursor. It commits
all batch jobs/revisions and the checkpoint CAS together. Cursor advancement is
monotonic; concurrent stale checkpoint writers roll back and yield to a later
pass. The final short/empty batch marks completion. Duplicate deletion events
converge through the existing unique owner/reason/resource constraint.

Another bounded pass rotates already enrolled states by reconciliation timestamp,
repairing missing job/outbox intent or incompatible metadata/generation. It does
not scan unenrolled/historical versions. A third bounded pass ensures cleanup
work for pending manifests. All locks are document-first; checkpoint CAS happens
after document work. PostgreSQL constraints and transactions supply deduplication;
there are no in-memory deduplication caches or distributed locks.

Unchanged enrollment reuses the deterministic version/generation/revision
projection and active job, preserving correlation and attempts. Missing intent is
recreated with the same job lineage and dispatch sequence, respecting retry due
time. Exhausted/deterministic failures are not automatically reset. Failed or
cancelled cleanup stays observable for later operator recovery, rather than
creating an endless succession of jobs.

INDEX_SEARCH and REMOVE_SEARCH_INDEX use T02 v3 `processing.execute` messages:
identifiers, generation, revision, correlation and dispatch sequence only. Job and
outbox creation is atomic. Existing publisher confirmation, leased dispatch,
publication backoff and v1/v2 handling remain unchanged; a repeated publication
reuses message/job/correlation identity. No queue, exchange or routing key is added.

T03 production dispatcher capability registration is empty for search: v3 rows
stay durably PENDING, with no publication attempt consumed, while legacy messages
continue to dispatch. The dispatcher accepts an explicit typed internal capability
list for later actual handler wiring and focused transport tests; there is no
operator switch that pretends a handler exists. T05 and later must wire only
implemented job types. The worker validates v3 identity and conditionally cancels obsolete work under
the document lock, acknowledging supersession only after durable cancellation.
Database failures retry the delivery. Eligible v3 messages reaching the current worker are
rejected without claiming/completing the job; cancelled stale deliveries are safe
duplicates. No fake successful handler is registered.

## Cleanup, recovery and limitations

Old BUILDING/READY/FAILED manifests become REMOVAL_PENDING. An ordinary
REMOVE_SEARCH_INDEX job and outbox intent are ensured for each eligible cleanup
slot. Existing active-job uniqueness is per version/job type; multiple retired
manifests on one version therefore wait durably in REMOVAL_PENDING while one
removal job occupies that version's slot. Recovery schedules the next manifest
after the active slot is released. Generic document cancellation excludes both
REMOVE_VECTOR_INDEX and REMOVE_SEARCH_INDEX.

This persists deletion intent; **it does not delete anything from Elasticsearch**.
Remote records, if present from another runtime, may remain until implemented
cleanup handlers run. SQL authorization, exact version/generation/revision and
canonical hash validation are mandatory for all future search reads. Parser,
verified remote publication/removal, remote consistency repair, operator replay,
bulk historical enrollment, mapping/serving cutover and search APIs remain later
tasks. T03's SQL generation-change reconciliation is not a complete remote rebuild.

Recovery after restart uses persisted checkpoints, manifests, jobs and outbox
records. A failed publication retains PENDING intent/backoff. Missing workers do
not consume held messages or complete jobs. Errors contain stable codes and
identifiers, never credentials, document text or sensitive metadata.

## Verification and acceptance

Verification on 14 October 2026 used disposable native PostgreSQL 17 databases.

| Check | Actual result |
| --- | --- |
| Fresh migration deployment | All 17 migrations applied successfully; no developer database used. |
| T02-to-T03 seeded upgrade | 1 passed; enrolled rows/jobs/outbox/checkpoint preserved; repeated deployment succeeds. |
| v1.3.1-to-current seeded upgrade | 1 passed; prior authoritative rows preserved without enrollment/backfill. |
| Search SQL persistence/contracts/enrollment | 28 passed, including rollback, concurrent enrollment/edit/archive, stale result cancellation, checkpoint failure/concurrent recovery and generation fencing. |
| API search application hooks/contract bridge | 5 passed across 2 suites; real SQL with simulated publisher, upload/version receipt replay, atomic scheduling/deletion failure, restore/delete, held delivery and missing handlers. |
| Existing processing/AI database regressions | 48 passed. |
| HTTP contract E2E (mocked service boundaries) | 281 passed, 15 suites; no real browser claim. |
| API unit tests | 519 passed, 1 skipped, 45 suites; latest worker/outbox/configuration changes additionally passed a focused 115-test rerun. |
| API PostgreSQL lifecycle/organization/upload/download/status/outbox/AI regressions | 88 passed, 8 skipped; skipped cases require live RabbitMQ. |
| Database/API format, lint, TypeScript | Passed. |
| Documentation and workflow checks | 330 local link file targets exist; referenced commands/next task/VERSION checked; workflow YAML parses and `git diff --check` passes. |
| Shared database/storage and API production builds | Passed; includes worker/recovery source. |
| Docker Compose configuration | `docker compose config --quiet` passed; client warned that its external configuration file was inaccessible. |
| Live Docker/broker verification | Blocked: Docker engine named pipe absent; no TEST_RABBITMQ_URL/live Redis service supplied. |
| Elasticsearch/provider/browser/CI execution | Not run; Elasticsearch and new search/browser flows are outside T03. Existing provider unit compatibility tests ran; no live provider claim or CI pass is made. |

Synthetic publisher failures and worker handoff tests do not constitute live
RabbitMQ verification. SQL transaction rollback preserves observability and intent;
remote index cleanup remains unimplemented. The test fixtures' invalid version
upload scope, copied checksum and backward injected clock were corrected during
verification; no known introduced test failure remains.

Acceptance for implemented T03 scope:

- [x] Atomic current-version upload/metadata/association enrollment and receipt replay.
- [x] Revision/canonical-hash fencing and durable stale cancellation.
- [x] Archive, restore, soft-delete and version replacement; cleanup is not cancelled.
- [x] Owner-bound bounded checkpoint fanout, rollback and concurrent recovery.
- [x] Recoverable job/outbox identity and held unimplemented search delivery.
- [x] Relevant executable local tests/checks pass; historical releases preserved.
- [ ] Live broker/worker restart and Docker runtime checks remain a deployment gate;
      no local substitute is represented as equivalent coverage.

Documentation created: this guide. Updated: root README and Unreleased changelog,
Phase 5 plan, roadmap, documentation index, ADR-007 implementation status,
architecture/database/API references, development testing and database package
README. Environment examples and base Compose forward opt-in enrollment policy;
CI adds enrollment and seeded-upgrade commands without claiming CI execution.

Next: **T04 — Private Elasticsearch adapter and deployment configuration**.
Implement bounded lexical transport and explicit tested mappings, including the
approved private authenticated deployment and failure categories.

## Live recovery continuation

The [current ledger](phase-5-live-verification.md) records passed broker-outage
upload recovery, worker-stop pending-work recovery, stale external index exclusion
during archive, restore/deletion, and controlled Elasticsearch outage behavior.
These supplement the prior direct-handler maintenance results; they do not claim
a hard crash during every rebuild/publication phase or complete hybrid acceptance.
