# Phase 5 T10 - Backfill, rebuild, reconciliation and operator recovery

Status: **PARTIAL acceptance: implementation and local checks complete; live recovery gates pending.**
Date: **15 October 2026**. `VERSION` stays `1.3.1`; Phase 5 is not released.

[Approved plan](phase-5-search.md#t10--backfill-rebuild-reconciliation-and-operator-recovery) |
[Generation decision](decisions/ADR-009-search-maintenance-generations.md) |
[Lexical publication](phase-5-lexical-publication.md) | [Deployment](phase-5-elasticsearch.md)

## Architecture and prerequisites

Use the existing PostgreSQL processing jobs, v3 contracts, transactional outbox,
RabbitMQ routing, worker leases/retries, parser and private Elasticsearch adapter.
No public administration endpoint, new queue/service, dependency or model is added.
`SearchMaintenanceService` is operator orchestration, deliberately absent from
HTTP modules. `SearchMaintenanceScheduler` is shared SQL-only orchestration used
by the CLI and existing outbox recovery loop. Original binaries, immutable file
versions, Qdrant collections, embeddings and RAG configuration are not changed.

Apply migration **20261015010000_search_maintenance** with the existing migration
command, build the database package/API and roll out matching API/outbox/worker
binaries. The runtime image includes both maintenance scripts. Keep search private
and authenticated using the existing deployment. Enable Elasticsearch, search
enrollment with the matching fingerprint, outbox and workers before applying
backfill/rebuild/reconciliation. A disabled transport holds search outbox work;
it does not acknowledge cleanup as successful. Keyword/Hybrid serving flags stay
independent and default off. The CLI checks enabled compatible enrollment before
starting these mutating scans, preventing conflict with disabled-policy revocation.

The migration replaces fingerprint-only generation uniqueness with
`(fingerprint, generation)` uniqueness. Mapping/extraction fingerprints keep their
existing meaning and bytes; physical names already include the generation number.
Existing schema/HTTP/message contracts remain intact. The generation factory now
uses the compound key. Normal enrollment prefers SERVING over BUILDING for the
configured profile, so creating a shadow does not redirect uploads. This is an
internal client/schema rollout requirement, not a public API change.

## Operator authorization

Every CLI command connects using existing validated server configuration and checks
membership in the PostgreSQL **`qyvra_search_operator`** role. An application user
ID or `--operator` string does not authorize maintenance. There is no HTTP route
through which an ordinary account can invoke it. `--operator` is a validated audit
label; actual authorization comes from trusted host access and DB credentials.

A DBA provisions a NOLOGIN authorization role and grants it to a dedicated trusted
operator login with the required existing database writer privileges, for example:

```sql
CREATE ROLE qyvra_search_operator NOLOGIN;
GRANT qyvra_search_operator TO qyvra_operator;
```

`qyvra_operator` is an already provisioned server login, not an application account.
Do not grant this role to the ordinary production API login or expose its
credentials to browser configuration. The migration does not create roles or need
CREATEROLE. Production privilege provisioning is an operator deployment step;
local PostgreSQL superusers satisfy membership only after the named role exists.
Use existing secret handling for `DATABASE_URL` and Elasticsearch credentials;
never put passwords in CLI arguments or captured command output. Use the compiled
API runtime on a trusted host or in the existing API image with operator secrets.

## Commands and dry-run

Run from `apps/api` after building, with existing server environment configured.
Use `npm.cmd` on PowerShell where npm script execution is restricted. Substitute
actual lowercase UUIDs for placeholders. Unknown/duplicate options, arbitrary
index names, ambiguous scopes and unbounded numeric values are rejected.

```sh
# SQL/Elasticsearch read-only previews: no enrollment, operation row or index creation.
npm run search:maintenance -- generation --number 2 --operator ops:alice
npm run search:maintenance -- backfill --generation GENERATION_UUID --owner USER_UUID --operator ops:alice
npm run search:maintenance -- reconcile --generation GENERATION_UUID --owner USER_UUID --operator ops:alice

# Explicitly create compatible BUILDING generation/indexes; never deletes/recreates an index.
npm run search:maintenance -- generation --number 2 --operator ops:alice --apply

# Historical current-version enrollment for one explicit owner.
npm run search:maintenance -- backfill --generation SERVING_UUID --owner USER_UUID --operation OPERATION_UUID --batch 10 --max-batches 1 --operator ops:alice --apply
npm run search:maintenance -- status --operation OPERATION_UUID --operator ops:alice
npm run search:maintenance -- resume --operation OPERATION_UUID --batch 10 --operator ops:alice --apply
npm run search:maintenance -- cancel --operation OPERATION_UUID --operator ops:alice --apply

# Global shadow enrollment. Serving data remains selected until verified cutover.
npm run search:maintenance -- rebuild --generation BUILDING_UUID --all-owners --operator ops:alice --apply
npm run search:maintenance -- verify --generation BUILDING_UUID --operator ops:alice
npm run search:maintenance -- cutover --generation BUILDING_UUID --confirm-generation BUILDING_UUID --all-owners --operation CUTOVER_UUID --operator ops:alice --apply

# Definite repair scheduling and exact-manifest cleanup.
npm run search:maintenance -- reconcile --generation SERVING_UUID --owner USER_UUID --operator ops:alice --apply
npm run search:maintenance -- cleanup --generation GENERATION_UUID --owner USER_UUID --operator ops:alice --apply

# Bounded, read-only physical identity inspection; no PDF/title text is returned.
npm run search:maintenance -- scan --generation GENERATION_UUID --owner USER_UUID --kind metadata --batch 10 --operator ops:alice
```

All commands default to dry-run unless `--apply` is explicitly accepted. `verify`
and `scan` are read-only, including external index inspection. Dry-run reconciliation
verifies canonical expected publications and describes proposed repair; other scan
previews list bounded eligible identifiers, not an exhaustive action forecast.
`generation --apply` creates only compiled compatible names/mappings in a BUILDING
generation. It refuses provisioning a SERVING/RETIRED generation. Rerunning a
partially provisioned BUILDING generation safely completes missing indexes;
incompatible existing indexes fail instead of being deleted.

Read-only preview `--after DOCUMENT_UUID` continues a UUID keyset. Physical `scan`
returns `next`; pass its JSON array to `--after` (projection UUID alone for metadata;
projection UUID/page/segment for pages). These physical cursors are explicit
read-only inspection cursors, not repair authorization or point-in-time snapshots.
Concurrent external writes can require a repeated inspection pass. Unknown/extra
physical identities are report-only and never silently deleted.

Applied scans always resume **SQL operation checkpoints**, not a supplied `--after`.
`resume` does not resume a CUTOVER: repeat the `cutover` command with its operation
ID and exact generation confirmation. Duplicate completed operation IDs return
their saved outcome. A new scan pass uses a new operation ID. Cancel returns an
affected-row count; zero means an active lease or terminal state prevented a change.

## Backfill and durable progress

The new `search_maintenance_operations` table owns operation UUID, kind, initiator,
optional owner scope, generation FK, UUID cursor, UTC timestamps, state, counters,
sanitized last failure, lease token/expiry and structured outcome. Owner scope has
an explicit FK. A partial unique index permits **one RUNNING maintenance operation**
across all owners/kinds. This is audit/checkpoint persistence, not a second job
system. Existing category/tag fanout checkpoints remain unchanged.

Scan documents by ascending UUID with `createdAt <= operation.createdAt`, bounded
to 1–25 documents per batch. Default batch is 10; one invocation runs one batch
unless `--max-batches 1..10` is explicit, with 250 ms between batches. Counters track
examined documents, scheduled work, skipped documents, discrepancies and failures.
Skipped includes ineligible, already-ready or already-pending work; it does not
mean publication success. Rebuild BLOCKED/STALE outcomes increment failure counts.

Each document's eligibility check, enrollment, job/outbox creation and checkpoint
advance commit together. PostgreSQL document locks and existing uniqueness enforce
idempotency. A failure leaves the current cursor unchanged, retains earlier commits
and records a safe failure code. Leases last 120 seconds and renew between documents;
expired attempts cannot commit checkpoints under a replacement token. Retrying
completed input never creates duplicate logical enrollment.

Only active, nondeleted highest file versions are enrolled. Normal enrollment
handles concurrent new uploads; edits/version replacement/archive/deletion are
rechecked under the document lock. New documents beyond the fixed scan cutoff and
mutations after a scanned document require normal enrollment or another bounded
pass. No unbounded offset scan or Redis-only checkpoint exists. Signal interruption
stops between bounded document operations, releases the lease and leaves the
checkpoint resumable; in-flight remote verification can take up to its deadline.

## Rebuild and verified cutover

BUILDING projections use existing immutable version/generation/revision identities.
Compatible canonical extraction is reused. Otherwise PDF shadows schedule existing
integrity verification, then model-independent extraction, then full lexical
publication. A BUILDING extraction branch attaches its artifact before its first
immutable publication, so it does not advance/revoke the serving document revision.
The existing recovery loop wakes shadows waiting for integrity or another active
version job. No file bytes or remote network calls occur in enrollment transactions.

An immutable FAILED shadow cannot be rewritten under the same identity. Recover
through a fresh compatible generation rather than unpublishing valid serving data.
For ordinary serving FAILED projections, explicit reconciliation can fence them
and enroll a fresh revision; automatic recovery does not reset exhausted budgets.

Scan COMPLETED means **enrollment scan complete**, never rebuild complete. `verify`
requires every currently eligible document's current version/revision in the target
to have a READY verified manifest and READY or explicitly UNSUPPORTED text coverage.
PENDING/FAILED coverage blocks cutover. Image/textless supported outcomes are
accounted as metadata-only; corrupt PDFs are not silently declared complete text.
Reconstruct canonical content, check manifest hash and verify the exact search-visible
record set through Elasticsearch. An HTTP write success or realtime mget alone is
insufficient. Both target mappings must already exist and be compatible.

Verification streams one document at a time and stores at most **1,000 publication
proofs**. Larger vaults fail closed with capacity, requiring a reviewed larger-scale
cutover strategy. Index operations use 60-second abort deadlines and existing
adapter limits. Cutover records an operation before external verification, renews
its lease, and records verification/SQL failures durably. A retry repeats verification.

After external verification, a bounded SQL-only transaction takes a short catalog
mutation fence (`SHARE` locks on documents/versions/tags), locks eligible document
rows, revalidates all current identities/revisions/canonical hashes and target
manifests, then retires the old serving generation, selects the target and switches
ready pointers atomically. Normal read-only search remains available; writes can
wait during this at-most-30-second transaction. There is no network call under the
fence, no Elasticsearch alias switch and no claim of a distributed transaction.
Deadlock/timeout/lease conflicts roll back SQL changes and leave a resumable failed
cutover record. Edits after verification invalidate the proof and force a fresh pass.

Highly active corpora can need repeat shadow scans or an operator mutation window
to converge. A fresh rebuild pass catches changes behind the earlier cursor before
cutover. Old data is not immediately deleted. Existing result-window generation
bindings reject continuation after cutover with the existing 409 restart contract.

## Reconciliation, cleanup and rollback

`reconcile` scans owned SQL documents durably. Definitive missing indexes/expected
records or wrong canonical content fence the still-current SQL publication and
schedule fresh work through the existing outbox. A concurrent archive/deletion/
version change cannot reactivate it. Outage, timeout, incompatible mapping or
ambiguous visibility/cardinality failure stops without invalidating healthy state.
Repair does not change original files, owner IDs, document versions or AI artifacts.

`scan` separately inspects bounded owner/generation-filtered physical identities
without title/body fields. It classifies unknown projections, identity/hash
mismatch, extra records, stale publication, retired generation, cleanup-pending,
eventual publication, shadow-ready or known manifest. Unknown/extra/ambiguous
records are report-only. It never accepts arbitrary DSL/index names, deletes whole
indexes or invents ownership for unknown records. Exact publication verification
also rejects extra records even where a physical inspection cursor is insufficient
to exhaustively enumerate corrupted duplicate sort keys.

`REMOVE_SEARCH_INDEX` is now a real registered worker capability. It checks the
current job lease and SQL projection state, refuses active ready pointers, deletes
only exact manifest IDs in batches of 25, verifies absence and only then commits
REMOVED/job completion. Missing indexes are already absent. Retryable failures
remain durable retries; terminal incompatibility remains observable. No broad
delete-by-query or index deletion occurs. REMOVED means the **known SQL manifest's
records** were absent at verification, not that all possible unknown remote data
was discovered or removed.

Immediate lifecycle invalidation can schedule cleanup. Retired generations retain
their projections for at least **24 hours**. Existing recovery then schedules
bounded exact removals (up to ten candidates per poll) and periodically rechecks
REMOVED projections after the same retention interval, covering uncertain late
writes. Automatic recovery does not revive failed/cancelled cleanup budgets;
explicit `cleanup --apply` audits a bounded replay. A document with more than 25
old projections can need additional cleanup passes. Search authorization continues
to use SQL even while physical cleanup lags. Canonical historical text/artifacts
are retained under existing source-read authorization, not deleted with the index.

Cutover outcome records the previous generation UUID and retained-data policy.
Retirement remains irreversible under existing SQL guards: **no instant reverse
cutover** is offered. To roll back derived content, create a fresh compatible
generation, rebuild from authoritative current SQL/artifacts, verify and cut over
forward. Keep original data/backups and matching binaries; do not reset the vault
or restore stale lifecycle pointers. Different mapping/extractor schema migrations
and direct resumption of retired generations are not implemented. Restoring an old
fingerprint-only database/client contract is unsafe once duplicate profile
generations exist; do not attempt an automatic destructive downgrade.

## Troubleshooting and observability

The CLI emits JSON operation IDs, counters, timestamps and outcomes, never document
text, file paths, query text or credentials. Failed scans keep the last durable
cursor, failure count/code and released/expired lease. `status` reads the saved
row. If a crash preceded printing its ID, a trusted operator can inspect the one
RUNNING row in `search_maintenance_operations` by initiator. Recover failed cutovers
with the same ID/confirmation, or cancel before starting another scan.

- Authorization rejected: provision/grant the named operator role on the target
  database login; an audit label is insufficient.
- Enrollment/configuration mismatch: enable existing compatible enrollment and
  worker/outbox transport consistently; do not change the generation fingerprint
  merely to create another physical index.
- Busy operation/lease: inspect the existing operation; resume after expiry or
  cancel only when no active lease exists. Do not edit checkpoints manually.
- Scan complete but verify fails: inspect pending/failed jobs, text coverage and
  current revisions; rerun the shadow scan for mutations after its cursor.
- Unknown/extra index data: retain report-only findings for operator investigation;
  build a clean generation and cut over rather than deleting unrelated data.
- Cutover conflict: serving selection remains unchanged unless a valid concurrent
  lifecycle change independently revoked a document. Reverify; never force pointers.
- Missing index: owned reconciliation schedules repair; workers recreate compatible
  indexes and verify publication. Healthy SQL is not blindly relabelled complete.

## Verification ledger

Recovered evidence from the interrupted T10 implementation (not rerun solely for
this continuation):

- Fresh PostgreSQL application: all **18 migrations applied** successfully.
- Populated upgrade test: first 17 migrations + fixture version + T10 migration;
  full immutable version row unchanged, operation table initially empty, correct
  replacement uniqueness index. **1 passed**, isolated database cleaned afterward.
- Database search contracts/persistence/enrollment regression: **28 passed**.
- API unit suite: **709 passed, 2 skipped, 57 suites** (includes provider/RAG,
  search/highlight/pagination, processing, messaging and new operator/scan tests).
- PostgreSQL/parser integration selection: **48 passed, 3 skipped** across
  maintenance, publication and keyword suites. Elasticsearch is a controlled double
  in these SQL suites. Tests cover rollback, lease contention, idempotency, immutable
  PDF extraction/reuse, exact cleanup, role isolation, cutover failure/rollback and
  archive after external verification. The live maintenance suite was skipped.
- CLI argument tests: **4 passed**.

Continuation checks, 15 October 2026 (commands below run from `apps/api` unless
otherwise stated; no dependency installation, migration replay or Docker rebuild):

| Command                                                                                                                                                                       | Actual result                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/infrastructure/search/elasticsearch-store.spec.ts src/modules/search/search-maintenance.service.spec.ts` | 45 passed; covers final physical-scan validation and maintenance boundaries                                     |
| `node node_modules/jest/bin/jest.js --config test/jest-integration.json --runInBand --runTestsByPath test/search-maintenance.integration-spec.ts`                             | 12 passed with real PostgreSQL and simulated Elasticsearch, including newly completed cleanup outage/retry test |
| `node node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand --runTestsByPath test/keyword-search.e2e-spec.ts`                                                 | 18 passed; HTTP auth/DTO/OpenAPI, SQL/search doubles                                                            |
| `node --test scripts/search-maintenance-args.test.cjs`                                                                                                                        | 4 passed after CLI formatting                                                                                   |
| `npm.cmd run lint`                                                                                                                                                            | Passed                                                                                                          |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false`                                                                                                           | Passed against freshly built shared packages                                                                    |
| `npm.cmd run build`                                                                                                                                                           | Passed; shared storage/database generation/build and API/outbox/worker compilation                              |
| `node node_modules/prettier/bin/prettier.cjs --check "src/**/*.ts" "test/**/*.ts"`                                                                                            | Passed                                                                                                          |
| `node --check scripts/search-maintenance.cjs` and `node --check scripts/search-maintenance-args.cjs`                                                                          | Passed                                                                                                          |
| Root: `node --test infrastructure/test/search-compose.test.cjs`                                                                                                               | 1 passed; static private authenticated topology regression                                                      |
| Root: `docker --config .tools/docker-public compose -f docker-compose.yml -f docker-compose.search.yml config --quiet`                                                        | Passed using synthetic configuration values/file references; no containers started                              |

The first continuation SQL test attempt failed all 12 cases because the stopped
native test database was unreachable. Starting the existing local cluster (no
schema/data reset) and repeating that suite produced the 12 passes above. The
`pg_ctl start` restricted-token launch failed on Windows; direct `postgres.exe`
startup recovered the existing cluster. Neither failure was hidden as a test pass.

The recovered 48-test selection and continuation 12-test maintenance suite overlap;
their counts must not be summed as distinct coverage. Unchanged database migration,
full API unit, keyword SQL and publication SQL checks were preserved rather than
repeated. No frontend code changed, so T09 browser evidence was not rerun or
represented as T10 live evidence.

Final documentation check: **449 local link targets across 14 changed guides and
indexes exist**; fragment anchors were not automatically checked. `git diff --check`
passed (checkout line-ending warnings only). The existing native test cluster was
stopped cleanly after testing, without deleting data. `VERSION` is still `1.3.1`;
no commit, push, release or deployment occurred.

## Acceptance review

| Requirement                                                           | Status and evidence                                                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical backfill, durable checkpoints, bounded/resumable execution | COMPLETE implementation/local SQL verification; keysets, rollback, duplicate enrollment and leases tested                                                  |
| Isolated generation rebuild and verified SQL cutover                  | COMPLETE implementation/local verification; parser reuse, serving preservation, final audit rollback and archive race tested; 1,000-document bound applies |
| Reconciliation and safe repairs                                       | COMPLETE implementation/local verification; definite missing records repaired durably, outages preserve state, ambiguous physical records report-only      |
| Operator access, ownership and lifecycle fencing                      | COMPLETE implementation/local verification; PostgreSQL role rejection and exact owner/manifest cleanup tested                                              |
| Retry/recovery and observability                                      | COMPLETE implementation/local verification; saved operation counters/errors, durable job retries and exact cleanup retry tested                            |
| Real Elasticsearch loss/visibility/partial writes and cutover         | BLOCKED: Docker engine unavailable; separately gated live suite skipped                                                                                    |
| Live RabbitMQ outage, restart and multi-worker recovery               | BLOCKED: Docker engine unavailable; unit/SQL doubles do not replace these gates                                                                            |
| Documentation and local checks                                        | COMPLETE; current guides/indexes updated without release snapshot changes                                                                                  |
| Full T10 acceptance                                                   | PARTIAL until applicable live gates above pass; no T10 completion/release claim                                                                            |

Live Docker remains blocked by the missing `docker_engine` pipe. No successful
Elasticsearch, RabbitMQ outage/restart, Docker image build, Nginx/browser or live
provider result is claimed in T10. The isolated `infrastructure/test/search-runtime.cjs`
runner now includes `search-maintenance-live.integration-spec.ts` when a migrated
disposable `TEST_DATABASE_URL` is supplied. It exercises real authenticated ES,
controlled isolated index loss, repair, rebuild and cutover with direct worker
delivery; this does **not** prove broker transport. Never supply a production
database. Existing volume/name guards and exact test-index cleanup remain required.

Continuation checkpoint: once Docker is available, start the existing disposable
PostgreSQL test cluster, supply its migrated `TEST_DATABASE_URL`, and run
`node infrastructure/test/search-runtime.cjs` from the repository root. This is
the first remaining live adapter/maintenance verification, not a request to rerun
backfill against an existing corpus. Then execute and record the plan's separate
broker interruption, worker restart/two-worker and mutation-race scenarios before
closing T10 acceptance. No live result has yet justified marking those gates passed.

T10 is not marked fully accepted while live gates remain pending. Next is
**T11 — Acceptance Review, Documentation Finalization, and Release Readiness**:
assess the integrated candidate and prepare v1.4.0 without publishing. That task
must close applicable live deployment, broker/restart, concurrency, model, search
quality and browser gates, and record final reviewed-commit CI separately.

## 16 October live evidence supplement

The [continuation ledger](phase-5-live-verification.md) records the successful
real-ES maintenance integration selection within 45 passing tests. This advances
rebuild/reconciliation evidence without certifying full RabbitMQ outage/restart,
all concurrency scenarios or browser acceptance. Reuse completed operations;
do not repeat backfill or cutover during checkpoint recovery.

## Live recovery continuation

The [current ledger](phase-5-live-verification.md) records passed broker-outage
upload recovery, worker-stop pending-work recovery, stale external index exclusion
during archive, restore/deletion, and controlled Elasticsearch outage behavior.
These supplement the prior direct-handler maintenance results; they do not claim
a hard crash during every rebuild/publication phase or complete hybrid acceptance.
