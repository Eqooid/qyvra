# Phase 4 T08 — Upload enrollment, reprocessing, restore and backfill

**Implemented:** asynchronous PDF enrollment, owned reprocessing receipts, earliest-stage
artifact reuse, restore enrollment and bounded operational backfill. T03–T07 handlers,
leases, retries, outbox, activation and cleanup remain the execution infrastructure.
[T09 semantic retrieval](phase-4-semantic-search.md), [T10 grounded RAG](phase-4-rag-answers.md)
and [T11 citation navigation](phase-4-ai-frontend.md) are implemented. The
[T12 verification record](phase-4-verification.md) covers end-to-end recovery and
security. Historical release snapshots are unchanged.

`AiIngestionService.scheduleInTransaction` is the canonical application boundary.
Upload/new-version persistence and AI run enrollment share the existing document/version/
upload-receipt transaction. Integrity remains the first durable prerequisite. HTTP does
not read extracted content, call providers, publish RabbitMQ messages or contact Qdrant.
Scheduling failure rolls back enrollment and the upload transaction; existing storage
compensation applies. A broker/provider/index outage after commit is handled by workers.
Existing multipart contracts and original-document access remain unchanged.

Only active, nondeleted, latest versions with authoritative `application/pdf` MIME qualify.
Images remain integrity-only. The PDF parser still validates the actual original.
Uploading a new version immediately revokes older versions' semantic eligibility and
queues their exact manifest cleanup, preserving their immutable provenance. A prior
same-version/profile index remains eligible during a rebuild until atomic activation.

## Configuration and deployment

Enrollment is opt-in: `AI_INGESTION_ENABLED=false` by default.
When enabled, `AI_INGESTION_PROFILE_FINGERPRINT` must be 64 lowercase hexadecimal
characters identifying an already provisioned immutable `EmbeddingProfile`. API startup
checks that the profile exists. Provision it using the [T06 identity contract](phase-4-embedding-generation.md#profile-and-input-identity).
API and worker must use identical `CHUNK_SIZE_TOKENS` and `CHUNK_OVERLAP_TOKENS`.
Enable worker embeddings and vector indexing before enabling enrollment; its
`EMBEDDING_PROFILE_FINGERPRINT` must equal the ingestion fingerprint. Validation rejects
different fingerprints when both ingestion and embedding configuration are enabled.
The API needs the fingerprint and chunk configuration, **no provider or Qdrant secrets**.
Existing worker prefetch, lease, batch, retry and timeout limits bound execution.
There is no fleet-wide worker readiness check in the HTTP transaction.

## Owned reprocessing contract

`POST /api/v1/documents/:documentId/versions/:versionId/ai/reprocess` returns 202
with the normal envelope and safe `{runId, generation, status}` receipt. Session
authentication, Origin/CSRF policy, UUID paths, UUIDv4 `Idempotency-Key` and strict
body validation apply. Body defaults to `{ "mode": "repair" }`; unknown fields,
ownership IDs, provider URLs, credentials and arbitrary jobs/configuration are rejected.
Missing/foreign/deleted sources return 404, historical/archived/unsupported versions
and conflicting active work/key modes return 409, disabled/unprovisioned enrollment
returns a sanitized 503. No alternate AI-status API is introduced.

| Mode         | Behavior                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repair`     | Reuse an equivalent building run or eligible ready result; otherwise start at the earliest missing compatible artifact. An explicit owned request can replay a failed generation. |
| `extraction` | Schedule extraction and downstream work; integrity must still succeed.                                                                                                            |
| `chunking`   | Reuse matching extraction; schedule chunks and downstream work.                                                                                                                   |
| `embedding`  | Reuse matching extraction/chunks; schedule embeddings and indexing.                                                                                                               |
| `index`      | Reuse matching extraction/chunks/vectors; create a new manifest and index it. Missing prerequisites fall back to the earliest missing stage.                                      |

Stage modes schedule real execution; they do not delete immutable artifacts or force
paid regeneration under an unchanged identity. Existing handlers reuse identical
fingerprints/checkpoints. A parser/chunk/profile identity change is required to change
canonical output. Provider weight drift requires a new profile, not rewriting vectors.
Explicit stage requests conflict with active builds; repair coalesces equivalent work.
Repeated identical keys return the same run even after completion or deployment changes.
Authorization and current lifecycle eligibility are rechecked before receipt replay.

`ai_reprocessing_requests` stores `(versionId,key)`, mode, owned run reference and
timestamp. Its composite foreign key prevents cross-owner/run/version associations.
Receipts remain for the version lifetime; no provider secrets or document text are stored.
Migration `20261006010000_ai_reprocessing_requests` adds only this request-receipt table,
not jobs or another workflow engine. Its `down.sql` removes receipts; disable the endpoint
before rollback and recognize that old keys then lose replay guarantees.

## Earliest-stage reuse and recovery

Under the document lock, the scheduler snapshots the trusted extractor/chunker/profile
configuration and uses one current building run per version. It verifies source checksum,
canonical extraction fingerprint and completed outcome; chunk fingerprint/configuration,
extraction hash and complete-set state; and exact profile/input hashes for every embedding.
Only verified real artifacts receive completed reuse-stage records (zero execution attempts).
Existing SQL constraints recheck ownership, lineage and complete outputs. The next missing
stage gets its normal job/outbox atomically. Qdrant-only rebuilds make no embedding calls.
The SQL ready manifest determines completion; scheduling does not synchronously inspect
remote index health. A lost Qdrant collection requires explicit index repair/rebuild.

Automatic repair/backfill never resets an equivalent failed run's exhausted retries or
deterministic no-text outcome. Explicit owned reprocessing creates a new generation.
Changed configuration can create a compatible new generation after terminal work.
No stages are falsely completed when their artifacts are missing.

T03 recovery repairs already enrolled building runs, leases and outbox gaps. Backfill
enrolls existing eligible versions; it does not replace recovery or run provider calls.
All scheduling paths serialize on the existing document lock. PostgreSQL uniqueness,
job claiming, lease fencing, successor transactions and idempotent remote point IDs
continue to handle redelivery, concurrency and interrupted publication. Redis is disposable.

## Archive, restore, deletion and cleanup

Archive/soft delete immediately remove SQL ready mappings, cancel unfinished AI work
and durably schedule T07 exact-manifest removal. Retain immutable extraction, chunks and
embeddings for provenance and reuse. Restore (including existing soft-delete restore)
uses the same scheduler inside its lifecycle transaction: complete compatible retained
artifacts lead directly to a new indexing manifest, never direct activation of old remote
points. Cancelled integrity work is replayed first when necessary. Old pending/inflight
cleanup only targets the old manifest and cannot delete the restored generation.
Unsupported originals keep existing integrity restore behavior.

Permanent purge has no public API and remains outside the canonical Phase 4 product
scope. The existing [T07 cleanup-before-purge policy](phase-4-vector-indexing.md) applies:
revoke eligibility, finish/replay removal, quiesce/fence all writers and reconcile remote
absence **before** removing manifest tombstones or hard-deleting authoritative rows.
Do not bypass that policy with an unconditional business-row cascade. T08 adds no
autonomous destructive purge. Ordinary archive/soft delete cleanup uses shared bounded
retry/recovery; removal exhaustion remains visible and supports existing operator replay.

## Bounded backfill

After building the API, run from `apps/api`:

```sh
npm run ai:backfill -- --batch 25 --max 100
npm run ai:backfill -- --apply --batch 25 --max 100 --after <last-version-uuid>
```

The first command is **dry-run**. `--apply` enrolls work; batch is 1–100 (default 25),
maximum scanned per invocation is 1–10,000 (default 100). The trusted CLI uses validated
database/configuration settings and no public endpoint. Each line emits the processed
batch, safe run receipts, counts and UUID cursor. Content, vectors and credentials are
never emitted. Resume from the last successful line's cursor; a crash before output can
be handled by repeating the previous batch safely. Errors are sanitized and exit nonzero.

For Compose, after provisioning/enabling the matching profile:

```sh
docker compose exec api node /app/infrastructure/docker/database-command.cjs node scripts/ai-backfill.cjs --batch 25 --max 100
```

Pagination uses ascending version UUIDs with an exclusive keyset cursor, selecting only
current owned versions of active PDF documents. Lifecycle/version eligibility is rechecked
under lock. Complete compatible results, equivalent active work and deterministic failures
are reused/skipped. A competing incompatible build is reported as skipped. Each candidate
commits independently; no unbounded transaction/scan or synchronous provider execution.
Worker concurrency controls execution costs. Records created/restored before an already
advanced UUID cursor require another sweep from the beginning. This is a resumable scan,
not a snapshot or a promise that concurrently inserted records are included.

## Verification

`ai-ingestion.integration-spec.ts` uses real PostgreSQL, local storage, PDF parsing and
Qdrant, with a deterministic test embedding provider (no external paid API). It covers
atomic upload enrollment/rollback, upload receipt replay, concurrent request/backfill
coalescing, owned HTTP authentication/CSRF/validation, pagination/dry-run/reruns, terminal
no-text protection, all explicit starting modes, configuration-change chunk reuse, and
legacy backfill through activation, archive/restore races, reindex replacement/cleanup,
new-version exclusion and soft-delete/restore. Existing T03–T07 regression suites remain.
Operational verification results and remaining limits are reported with T08 completion.

At the T08 checkpoint, retrieval, RAG and frontend controls were future work.
They are now implemented in [T09](phase-4-semantic-search.md),
[T10](phase-4-rag-answers.md) and [T11](phase-4-ai-frontend.md).
OCR remains **Planned**; autonomous agents remain outside Phase 4.

## T08 file inventory and verification record — 6 October 2026

Created in T08 (earlier T01–T07 uncommitted work was preserved):

- `apps/api/src/modules/ai/ai-ingestion.service.ts`
- `apps/api/src/modules/documents/ai-reprocessing.controller.ts` and `.spec.ts`
- `apps/api/test/ai-ingestion.integration-spec.ts`
- `apps/api/scripts/ai-backfill.cjs`
- `packages/database/src/ai-scheduling.ts`
- `packages/database/prisma/migrations/20261006010000_ai_reprocessing_requests/migration.sql` and `down.sql`
- `docs/phase-4-ingestion.md`

Modified in T08:

- `.env.example`, `README.md`, `docker-compose.yml`, `infrastructure/docker/api.Dockerfile`
- `apps/api/package.json`; configuration `settings.ts`, `environment.ts`, `environment.spec.ts`, `configuration.module.ts`
- Document module `documents.module.ts`, `documents.service.ts`, `upload.repository.ts`
- `packages/database/prisma/schema.prisma`, `src/index.ts`, `src/processing-repository.ts`
- Canonical docs `README.md`, `api.md`, `architecture.md`, `compose.md`, `database.md`,
  `specification.md`, `roadmap.md`, `phase-4-ai-rag.md`, `phase-4-processing.md`,
  `phase-4-vector-indexing.md`, `deployment/environment-variables.md`

No dependency, RabbitMQ envelope, queue, worker handler, agent framework or historical
migration/release snapshot was added or changed by T08. The new receipt table concretizes
T01's idempotent reprocessing contract; there is no architecture deviation. Explicit
stage execution retains the established immutable-artifact reuse semantics.

| Verification executed                                                                    | Result                                                                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| API/shared builds (`npm --prefix apps/api run build`, database build)                    | Passed                                                                                   |
| API/database TypeScript, ESLint, Prettier and Prisma format checks                       | Passed                                                                                   |
| API unit suite (`jest --runInBand`)                                                      | 36 suites, 341 passed; one optional live Redis test skipped                              |
| Final targeted environment/reprocessing unit checks                                      | 2 suites, 89 passed                                                                      |
| API end-to-end suite (`jest --config test/jest-e2e.json --runInBand`)                    | 15 suites, 281 passed                                                                    |
| Final T08 ingestion integration suite, actual PostgreSQL/storage/PDF/Qdrant              | 6 passed, no skips                                                                       |
| T03–T07 extraction/chunk/embedding/index/orchestration/status integration regressions    | 6 suites, 65 passed; five optional broker/Redis cases skipped in that run                |
| Shared database pipeline/persistence/repository/rules                                    | 27 passed in isolated database                                                           |
| Actual RabbitMQ outbox suite                                                             | 4 passed, no skips                                                                       |
| Actual RabbitMQ worker suite in a dedicated vhost                                        | 5 passed, no skips                                                                       |
| All 15 migrations against clean databases; new migration down/up SQL                     | Passed                                                                                   |
| Host backfill CLI dry-run/apply/repeat/exclusive-cursor resume                           | Passed; one enrollment, then zero duplicate scheduling                                   |
| Final runtime image, unprivileged container CLI against test PostgreSQL                  | Passed; `node`, image `33e2375f9a5e7521961a4836c139e93252fad70ced567776758a59c379c812a3` |
| `docker compose config --quiet`, canonical local documentation links, `git diff --check` | Passed                                                                                   |

The initial recovery-suite run shared a database with concurrently populated integration
fixtures and timed out during a global recovery scan. Re-running in its own clean database
passed all 27 assertions without weakening tests or production limits. Fixture setup errors
(repository-local storage, immutable MIME mutation, required PDF page count and version
upload scope) were corrected before the passing final ingestion runs.

Unchanged passing broad suites were not repeatedly rerun after isolated scheduler/reporting
refinements; final affected integration, targeted unit, type/lint/format and container checks
were executed. Real paid embedding calls, live Redis and full production throughput/cost
acceptance were not exercised. The complete lifecycle fixture uses the real embedding
handler with a deterministic test provider and real PostgreSQL/Qdrant, never fabricated
final index state. T08-owned test containers are disposable; the existing application stack
and historical release files are preserved. No T09 implementation was started.
