# Phase 4 T07 — Qdrant indexing, activation and lifecycle cleanup

[Documentation index](README.md) | [Canonical AI/RAG contract](phase-4-ai-rag.md) |
[Processing](phase-4-processing.md) | [Embedding checkpoints](phase-4-embedding-generation.md)

**Implemented:** worker-owned vector indexing, verified batch checkpoints, atomic
SQL activation, manifest-scoped cleanup, periodic late-write reconciliation and
internal artifact-only rebuild/replay operations. Extraction, chunks and embeddings
remain the implemented T04–T06 stages. [Upload/restore/reprocess entry points and backfill](phase-4-ingestion.md) are implemented in T08. [T09 retrieval](phase-4-semantic-search.md), [T10 grounded answers](phase-4-rag-answers.md) and [T11 citations/frontend](phase-4-ai-frontend.md) are implemented; OCR remains **Planned**.
No public AI endpoint, search operation or frontend capability is added here.

## Boundary, dependencies and collections

`VectorStore` is the Qyvra-owned derived-index interface: ensure collection, upsert,
verify expected points, count an owned manifest, and remove an owned manifest.
Only the infrastructure adapter imports the native REST SDK. Worker handlers load
authoritative PostgreSQL state; HTTP upload handlers never invoke vector IO.

The dependency is pinned to `@qdrant/js-client-rest` **1.19.0**, the maintained
official TypeScript REST client with CommonJS support. Compose pins Qdrant
**v1.19.2**. Direct SDK integration avoids an AI framework. See the
[official client](https://github.com/qdrant/qdrant-js) and
[server release](https://github.com/qdrant/qdrant/releases/tag/v1.19.2).

The SDK pins Undici 7.29.0 upstream. A scoped npm override upgrades only this
SDK's HTTP dependency to **7.29.1**, the compatible security patch documented by
the [Undici maintainers](https://github.com/nodejs/undici/releases/tag/v7.29.1).
The final audit has no Qdrant/Undici findings. Existing unrelated package findings
remain recorded; this task does not perform a broad dependency migration.

T03's canonical collection name remains
`qyvra_chunks_<embedding profile UUID without hyphens>_v1`. One shared-owner
collection has a fixed-dimensional unnamed dense **Cosine** vector. Collection
metadata must match the immutable profile ID, profile version and payload schema
version 1. Dimensions, distance and metadata are checked on every bootstrap;
an incompatible existing collection fails safely and is never silently recreated.
Concurrent create attempts reread and validate the resulting collection.

Keyword payload indexes cover `userId`, `documentId`, `documentVersionId`,
`chunkSetId`, `indexManifestId`, `embeddingProfileId`; integer indexes cover
`embeddingProfileVersion`, `payloadSchemaVersion`. Bootstrap creates missing
indexes and rejects conflicting index types. No alias or remote readiness flag
replaces PostgreSQL publication. Future index schemas require a separately
reviewed collection generation/name change.

## Point identity and payload

One point corresponds to one immutable chunk in one manifest/profile. UUIDv5 uses
the fixed Qyvra namespace `d580c8e7-b8f5-5acf-9fe5-62725451bdd9` and UTF-8 JSON:
`["qyvra-vector-point/v1", chunkId, embeddingProfileId, indexManifestId]`.
Repeated writes to the same build replace the same points. Replacement manifests
have distinct IDs so an old worker cannot overwrite the replacement generation.
The canonical chunk ID remains its PostgreSQL UUID.

The exact allowlisted payload is:

| Field                                           | Source                                                       |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `userId`, `documentId`, `documentVersionId`     | Composite owned PostgreSQL lineage                           |
| `chunkId`, `chunkSetId`, `ordinal`              | Immutable complete chunk generation                          |
| `indexManifestId`                               | PostgreSQL index build manifest                              |
| `embeddingProfileId`, `embeddingProfileVersion` | Immutable profile                                            |
| `payloadSchemaVersion`                          | `1`                                                          |
| `pageNumbers`                                   | Sorted distinct pages from the chunk's truthful source spans |

There is **no text, title, filename, storage key, credential, prompt, raw provider
error or vector-store authorization flag** in the payload. Source offsets/full
page spans remain authoritative in PostgreSQL for future citation construction.
Qyvra currently has user ownership, not a separate tenant entity. A future tenant
model must extend authoritative ownership and mandatory filters together.

## Indexing and activation

`INDEX_VECTORS` requires its completed matching `GENERATE_EMBEDDINGS` predecessor,
complete chunk set, immutable compatible profile and actual durable embeddings.
Each batch loads owned ordered chunks and verifies their checkpoint dimensions,
finite nonzero vectors and exact normalized-input hashes. Invalid/missing data
cannot complete indexing. No embedding provider is called during indexing.

Batch size is capped at 256 points and 500,000 vector values. The adapter scales
and normalizes vectors before transport to avoid float32 overflow/underflow from
extreme finite checkpoint values. PostgreSQL retains the original vectors.
Qdrant Cosine vectors are verified against normalized expected values with a
`1e-5` float32 tolerance, alongside exact ID and allowlisted payload equality.

For every batch: heartbeat authoritative eligibility/lease → verify existing
points → upsert missing/mismatched points with `wait=true` → require `completed`
response → heartbeat → verify actual remote IDs, vectors and payload → persist
monotonic `confirmedPointCount` and `checkpointOrdinal` through the shared fenced
checkpoint transaction. SQL transactions contain no remote IO. Even a previously
checkpointed prefix is verified and repaired on retry: Qdrant may have lost data.

After all batches, a second bounded verification pass and exact owned-manifest
count must match the entire expected generation. Only then does the router's
existing `complete()` transaction revalidate current ownership/version/desired
run/live lease, set the manifest **READY**, complete the job, publish the
`VersionReadyIndex` pointer and mark the run READY. Any SQL failure rolls back
these publication effects together. Full vectors are never sent through RabbitMQ.

An eligible prior same-version/profile READY manifest remains published while a
replacement is BUILDING. Successful activation swaps the SQL pointer, marks the
old manifest REMOVAL_PENDING, supersedes its run and creates cleanup/outbox work
atomically. A failed replacement leaves the previous pointer intact. A separate
profile does not share a collection or vectors; serving-profile selection remains
the future retrieval contract. Index completion does not change original-document
access, extraction content or canonical chunk identity.

## Crashes, cleanup and lifecycle

At-least-once delivery remains the Phase 3 contract. Crashes before SQL checkpoint
rewrite the same point IDs; crashes after checkpoint resume verified batches;
crashes before activation leave BUILDING unserved. Duplicate completion/delivery,
claim locking and expired-lease recovery use the existing repository/outbox model.
Redis percentages derive only from confirmed batches and are disposable.

Archive, soft delete and newer-version scheduling immediately remove SQL ready
references and cancel ineligible unfinished AI work under the document lock.
`REMOVE_VECTOR_INDEX` remains eligible for those historical/archived/deleted
versions. The handler checks that the manifest is REMOVAL_PENDING with no active
pointer, derives scope from SQL, deletes with the conjunction of **all** ownership,
document/version, chunk-set, manifest, profile/version and schema fields, waits
for confirmation, verifies zero remaining points, then commits REMOVED/job
completion under the shared lease fences. Missing collections and already absent
points are idempotent cleanup success. Shared collections are never deleted by
production cleanup. Restore alone never republishes a removed index.

Reconciliation also retires inactive FAILED/STALE manifests. A REMOVED manifest
older than ten minutes is rescheduled for exact-scope cleanup in a fresh job
generation. This periodic tombstone sweep catches a remote write that arrives
after an earlier deletion, even if its stale worker dies without recording it.
Scans are bounded by the existing recovery batch limit and rotate candidates;
one active cleanup per version remains enforced. Retain manifest metadata while
late-write reconciliation is required. Failed/exhausted cleanup stays visible;
automatic reconciliation does not reset its retry budget.

**Permanent document/original purge remains outside Phase 4.** Raw PostgreSQL
cascade deletion is not a remote-delete protocol. An operator must first revoke
eligibility, quiesce old writers/in-flight remote operations, finish and verify
all manifest cleanup, and only then hard-delete PostgreSQL/original data. Do not
remove manifests before this procedure; otherwise authoritative cleanup scope
is lost. A future permanent-purge API requires a reviewed retained-tombstone
contract. Derived deletion never cascades upward into original documents.

## Internal rebuild and cleanup replay

Trusted operational code can call
`ProcessingRepository.requestVectorRebuild(userId, indexManifestId)` after restoring
PostgreSQL or losing Qdrant. This is **not** a public HTTP endpoint. Verify the
owned current active version, latest successful integrity verification, extraction
checksum, complete immutable source generation and embedding checkpoints first.

The method creates a new run with the exact existing immutable configuration,
then records completed artifact-reuse stages referencing the actual persisted
extraction, chunk set and embeddings. SQL checks revalidate their dependencies,
configuration and completeness; these stages perform no algorithm/provider work
and have no execution outbox messages. The existing pipeline creates the new
manifest plus indexing job/outbox. Repeating a request while that compatible
rebuild is BUILDING reuses it. Prior publication survives until replacement.
This concretizes T01's rebuild guarantee without changing T02's schema or creating
a competing workflow. No re-extraction, chunking or embedding calls are required.

For exhausted cleanup, trusted operational code can call
`replayVectorRemoval(userId, indexManifestId)` after fixing the dependency. It
rejects foreign/active READY manifests, creates a controlled new cleanup generation
and never restores retrieval eligibility. Existing active cleanup is reused.

## Failure, security and configuration

Qdrant timeouts/network failures, a collection disappearing during reads/writes,
408/429/5xx, ambiguous writes/counts and transient
SQL failures use shared bounded PostgreSQL retry/recovery. Authentication failures,
invalid requests, incompatible collections/profiles, invalid embeddings and
ownership/provenance violations are terminal safe categories. Raw SDK responses,
URLs, API keys, document contents and vectors are not logged. Structured index
logs contain job, manifest, profile, attempt, duration and point count; failures
contain only sanitized categories. Retry exhaustion cannot authorize an index.

| Setting                   | Default / validation                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `VECTOR_INDEX_ENABLED`    | `false`; enable in worker when ready                                               |
| `QDRANT_URL`              | Required when enabled; absolute HTTP(S) origin, no credentials/path/query/fragment |
| `QDRANT_API_KEY`          | Private optional service credential; use authentication in production              |
| `QDRANT_ALLOW_HTTP`       | `false`; production HTTP requires explicit private-network opt-in                  |
| `QDRANT_TIMEOUT_MS`       | 10,000 ms (clamped default to half lease), positive, at most half worker lease     |
| `VECTOR_INDEX_BATCH_SIZE` | 64; 1–256, further bounded by vector dimensions                                    |
| `QDRANT_VOLUME_NAME`      | Compose persistent volume naming override                                          |

Compose supplies the URL/key only to the worker and the Qdrant service. The
service is on a dedicated internal network shared only with the worker, with no
host port or Nginx route; it has a persistent volume, disabled
telemetry and an HTTP `/readyz` healthcheck using Bash in the pinned image. API,
outbox and web receive no Qdrant key. Worker readiness still means safe broker
consumption; a Qdrant outage is a retryable stage dependency and does not prevent
users reading original documents or make core API readiness fail. Production
requires private network controls and service authentication; terminate TLS at
a private proxy or configure Qdrant TLS and use HTTPS, unless an explicitly
accepted private HTTP boundary is deployed. Never disable TLS verification.

Future retrieval must use trusted user/profile/eligible-manifest filters and
PostgreSQL reauthorization before loading text. The model never authorizes
content. Internal point verification reads deterministic SQL-derived point IDs
and rejects any payload mismatch; it exposes no user search capability.

## Verification and completion record

**T07 is complete.** Verified 6 October 2026 with synthetic text/vectors and isolated local services;
no paid providers or production documents were used. No T07 migration, new table,
new task type, new RabbitMQ envelope, public route or agent capability was needed.
The existing INDEX_VECTORS/REMOVE_VECTOR_INDEX vocabulary now has real handlers.

### Files created

- `apps/api/src/modules/ai/vector-store.ts`, `vector-store.spec.ts`
- `apps/api/src/infrastructure/vectors/qdrant-vector-store.ts`, `qdrant-vector-store.spec.ts`
- `apps/api/src/infrastructure/worker/vector-index.handler.ts`, `vector-index.handler.spec.ts`, `vector-removal.handler.ts`
- `apps/api/test/vector-indexing.integration-spec.ts`, `vector-container-smoke.cjs`
- `docs/phase-4-vector-indexing.md`

### Files modified

- `apps/api/package.json`, `apps/api/package-lock.json`: native SDK and scoped patched Undici override.
- `apps/api/src/configuration/settings.ts`, `environment.ts`, `environment.spec.ts`, `configuration.module.ts`: validated private vector-index settings.
- `apps/api/src/infrastructure/worker/worker.module.ts`: shared adapter and real handler factories/routing.
- `apps/api/test/worker.integration-spec.ts`: verify both handlers in the independent worker context.
- `packages/database/src/processing-repository.ts`, `processing-pipeline.ts`: lease-fenced index checkpoints, artifact-only rebuild, cleanup replay and late-write sweep generations.
- `.env.example`, `docker-compose.yml`: opt-in worker config, pinned private index service, internal network, persistent volume and healthcheck.
- `README.md`, `docs/README.md`, `docs/architecture.md`, `docs/database.md`, `docs/api.md`, `docs/specification.md`, `docs/roadmap.md`: current implementation scope and links.
- `docs/compose.md`, `docs/deployment/environment-variables.md`: private deployment/configuration.
- `docs/phase-4-ai-rag.md`, `docs/phase-4-data-foundation.md`, `docs/phase-4-processing.md`, `docs/phase-4-pdf-extraction.md`, `docs/phase-4-chunk-generation.md`, `docs/phase-4-embedding-generation.md`, `packages/database/README.md`: current T07 status and preserved prior completion evidence.
- `docs/decisions/ADR-004-profile-isolated-vector-index.md`: accepted implementation of the existing decision; no new ADR or redesign.

Historical release snapshots/migrations were preserved. Earlier uncommitted
T01–T06 work was retained. Ignored `.tools/t07-*` files contain local verification
logs and synthetic smoke fixtures, not production artifacts.

### Commands and results

| Verification                                                                                                             | Result                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd --prefix apps/api install --save-exact @qdrant/js-client-rest@1.19.0`, followed by scoped override installation | Installed SDK with Undici 7.29.1; unrelated dependencies preserved                                                                                                                            |
| Database `migrate:deploy` against clean `qyvra_t07_api_test`                                                             | All 14 existing migrations applied; no new T07 migration                                                                                                                                      |
| API/shared `build`, API and database `typecheck`, `lint`, `format:check`                                                 | Passed                                                                                                                                                                                        |
| API Jest unit suite, then corrected adapter fixture's targeted rerun                                                     | 35 suites verified, 338 passing tests and one optional live-Redis test skipped; adapter rerun 5/5                                                                                             |
| New `vector-indexing.integration-spec.ts` with PostgreSQL, Qdrant and RabbitMQ                                           | Final complete run 13/13 passed, no skips                                                                                                                                                     |
| Database `test:pipeline` with PostgreSQL                                                                                 | 27/27 passed; stored-file integrity, locking, outbox, dependencies, retry/recovery and lifecycle retained                                                                                     |
| API integration selection `ai-processing                                                                                 | chunk-generation                                                                                                                                                                              | embedding-generation | pdf-extraction | processing-status | outbox` | Six suites passed, 56 tests passed; five optional broker fixtures skipped in that initial run |
| Live broker/outbox and worker regression checks in separate broker vhost                                                 | Outbox 4/4 and worker 5/5 verified; worker context includes both new handlers                                                                                                                 |
| API `test:e2e` configuration                                                                                             | 15 suites, 281/281 passed                                                                                                                                                                     |
| `docker compose -p qyvra-t07-vector-check config --quiet` and isolated Qdrant `up --no-deps`                             | Passed; authenticated service healthy, internal network true, no published ports                                                                                                              |
| `docker build --target runtime -f infrastructure/docker/api.Dockerfile -t qyvra-t07-worker-test .`                       | Final image built successfully, user `node`, SHA256 `f6c31cea5f04d72d86395b98da8b58d3d58dfb0830689bf9b236493f7c7ee14a`                                                                        |
| Final image `vector-container-smoke.cjs write` → real Qdrant restart → `check` over internal Compose DNS/network         | Passed: actual SDK/key handling, huge finite-vector normalization, idempotent upsert, exact payload/vector verification, persistent volume, scoped cleanup, missing-collection classification |
| `npm audit --json` after scoped HTTP patch                                                                               | No Qdrant/Undici findings; 56 unrelated existing findings remain (3 low, 16 moderate, 36 high, 1 critical)                                                                                    |
| Markdown local-link checks, `git diff --check`, release-history diff inspection                                          | Passed; release snapshots unchanged                                                                                                                                                           |

Early checks exposed a default-timeout validation regression and test fixture
typing/setup errors; these were corrected and the affected checks passed. A live
test initially hit a SQL read timeout because separate suites shared a database
while holding document locks; the final complete indexing suite ran without
competing database suites and all thirteen cases passed. Its 30-second per-case
budget covers multiple complete SQL/Qdrant lifecycles; production request/lease
limits remain enforced. Assertions and existing tests were preserved.

Already passing expensive extraction/chunk/retry/API suites were not repeatedly
rerun after test-only, documentation or scoped HTTP-dependency changes. The actual
patched SDK was verified again against Qdrant/RabbitMQ and in the final image.
T07-owned disposable containers/volumes were removed and the host test PostgreSQL
cluster was stopped; the existing Qyvra Docker stack was preserved.

Known boundaries: PostgreSQL and Qdrant cannot commit atomically; Qdrant can fail
after a verified SQL activation. This does not grant unauthorized content access.
Future retrieval must report index dependency failure safely; the internal rebuild
operation restores derived data. Tombstone/history retention and permanent purge
remain an operational scaling decision. No autonomous actions, AI framework,
semantic/hybrid search, reranker, query embedding, LLM, RAG or final citation
renderer is implemented by T07. Recommended T08: wire owned upload/restore and
explicit reprocessing entry points plus bounded operational backfill to the
existing pipeline; do not begin retrieval/RAG prematurely.
