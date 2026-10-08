# T09 — Authorized semantic retrieval and search API

**Implemented** in Phase 4 / v1.3.0; verified locally on 7 October 2026.
Grounded RAG answers and server-validated citations are implemented in [T10](phase-4-rag-answers.md). Frontend search/citation rendering remain
**Planned**. T09 adds no migrations, dependencies, queues, processing jobs or vectors
to PostgreSQL. T01–T08 durable ingestion and activation remain unchanged.

## Request and result contract

`POST /api/v1/search/semantic` requires an authenticated session and
`X-CSRF-Protection: 1`. Browser Origin must satisfy the existing owned-resource
policy. Query parameters and unknown body properties are rejected. Responses use
the existing `data`/`meta.requestId` envelope and `Cache-Control: no-store`.
The generated OpenAPI at `/api/v1/docs-json` describes the DTO and result schema.

```json
{
  "query": "Where is the renewal date?",
  "limit": 8,
  "documentIds": ["owned-document-uuid"]
}
```

`query` is trimmed, nonempty and at most 4000 JavaScript UTF-16 code units. Unicode
text is preserved, without pretending character length equals model tokens; the T06
adapter independently enforces its exact tokenizer/input budget. `limit` defaults
to 8 and accepts integer 1–20. Optional `documentIds` contains 1–50 distinct UUIDs,
normalized to lowercase. Every requested document must be owned, active and
nondeleted; inaccessible and missing references both return 404 before embedding.
Clients cannot submit an owner, tenant, profile, model, collection, vector, score
threshold or Qdrant filter.

Success contains `{ results: [...] }`. Each result contains canonical PostgreSQL
`documentId`, `documentVersionId`, `versionNumber`, `chunkId`, `chunkOrdinal`,
`chunkSetId`, `indexManifestId`, `embeddingProfileId`, authorized `title` and
`originalFilename`, exact `excerpt` and `excerptHash`, `pageSpans`, `startOffset`,
`endOffset`, and `score`. Offsets are half-open Unicode scalar ranges in the T04
canonical extraction; page spans retain truthful multi-page source intersections.
This is citation-ready provenance, not a generated answer or rendered citation.
No storage keys, owner IDs, embeddings or arbitrary remote payload fields appear.

## Execution and authorization

1. The controller resolves `users.id` from the trusted session. The service admits
   bounded interactive work and authorizes any explicit document narrowing in SQL.
2. Read `AiServingProfile(id=1)` and its immutable `EmbeddingProfile`. Require its
   full fingerprint to match API `EMBEDDING_PROFILE_FINGERPRINT`, recompute that
   fingerprint and require Cosine. A missing/incompatible selection fails closed.
3. Select only owned active **current-version** `VersionReadyIndex` mappings whose
   manifests are READY and chunk sets complete. No eligible index returns an empty
   result without provider or Qdrant calls. BUILDING/FAILED/STALE/removal-pending
   manifests are excluded. A retained previous READY mapping stays searchable
   during a replacement build, regardless of the desired run's BUILDING state.
4. Call the existing T06 `EmbeddingProvider` once with `purpose: query`, exact
   profile/query instruction and an abort signal. Validate cardinality, identity,
   dimensions, finite nonzero values. Query vectors exist only for this request.
5. Recheck eligible SQL scope after embedding. Search only the intersection with
   the original scope, avoiding newly revoked sources. The native Qdrant adapter
   checks collection profile/version/schema/dimensions/Cosine without writing.
6. Make one similarity query with mandatory AND filters for trusted `userId`, exact
   profile/version, schema 1 and the SQL-authorized active manifest IDs. Never
   perform an ownerless global search then attempt to authorize the winners.
7. Qdrant returns a payload allowlist of identifiers and scores, with vectors
   disabled. The adapter validates UUID references, owner/profile/manifest and the
   deterministic chunk/profile/manifest point UUID. Forged/malformed candidates
   are discarded; payload text/title/page claims are never used.
8. One bounded PostgreSQL statement joins exact candidate tuples to chunks,
   sets, current versions, documents, READY manifests, active mappings and the
   current serving selection. SQL owner/lifecycle checks precede selection of
   text. Missing, foreign, obsolete, forged or revoked references cannot hydrate.
9. Return score descending, canonical chunk-ID tie-break, deduplicated chunk IDs,
   at most requested limit. Stale candidates can produce fewer results or none;
   there is no refill loop or weakened filter.

No transaction is held across a provider/Qdrant call. The final hydration statement
is the authorization snapshot for returned content. A concurrent revocation
committed before that statement is observed; bytes already authorized/read cannot
be recalled if revocation occurs after publication. T10 must reauthorize sources
again before including content in any generation request.

Qyvra currently has user ownership, not a tenant entity. Tenant-aware membership
and a second mandatory trusted tenant filter remain a future model change. No
request-provided tenant identifier is accepted as authority.

## Bounds, scores and failures

Candidate overfetch is `min(100, limit * 5)` across the entire request. Hydration
is batched, with at most 100 candidate tuples; there are no per-chunk/database or
per-document/vector calls. Collection metadata is one extra read, not a similarity
query. Scope uses indexed ownership/profile mappings and an ordered SQL
`maxManifests + 1` limit. Defaults allow 250 active manifests, configurable up to 2000. Oversize owner-wide scope returns sanitized 503; callers can narrow with
owned document IDs. It never silently searches only a subset of the corpus.

This concretizes T01's bounded request/scope rule: larger-scope **batched merging
remains Planned**, rather than introducing multiple external queries/refill loops
in T09. The initial bounded rejection is an explicit deployment limit.

Cosine score is similarity, higher is better, not confidence or a probability.
`SEMANTIC_SEARCH_MIN_SCORE` is optional and applies only while the API's exact
configured profile equals the selected SQL profile. There is no invented universal
cutoff. Without a calibrated threshold this endpoint provides ranked nearest
matches, including weak matches; it does not assert sufficient evidence. Operators
must calibrate on an owned relevance corpus for each fingerprint before using a
threshold for evidence decisions. Production relevance evaluation is still required.

Interactive work has one provider attempt, one bounded search and a total deadline.
`SEMANTIC_SEARCH_TIMEOUT_MS` governs the interactive query embedding/request budget;
the worker's `EMBEDDING_TIMEOUT_MS` remains its document-batch execution budget.
Invalid requests/token overflow return 400; ownership failures 404; admission or
provider rate limiting 429; embedding/request deadline 504; SQL, unavailable
Qdrant/provider, missing collections or incompatible profiles return sanitized 503.
The existing exception envelope hides internal provider/database error messages.
Search never schedules jobs, repairs collections, rebuilds indexes or persists
query vectors. Ordinary document access continues independently.

Admission follows the existing authentication limiter's bounded in-process fixed
window approach: per authenticated user, global per process, and simultaneous
requests. Accounting keys are bounded by the global admitted budget each minute.
On deadline the embedding signal is aborted; admission remains occupied until any
underlying read settles, preventing detached timed-out work from bypassing the
concurrency bound. Qdrant reads additionally use the adapter timeout. Rate limits
multiply across replicas; shared gateway/Redis admission is a deployment extension,
not durable business state or a new billing system.

## Configuration and deployment

Search is opt-in (`SEMANTIC_SEARCH_ENABLED=false`). Enabling it requires configured
T06 embeddings and T07 Qdrant. API embedding credentials now enable **query** calls;
workers continue producing document embeddings. No worker module is imported into
the HTTP runtime. The query-only capability of the existing vector-store boundary
does not expose index creation or writes to the retrieval service.

| Setting                               | Default / constraint                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| `SEMANTIC_SEARCH_ENABLED`             | false; requires both adapters                                         |
| `SEMANTIC_SEARCH_MIN_SCORE`           | empty = no cutoff; finite calibrated cosine value −1…1                |
| `SEMANTIC_SEARCH_MAX_MANIFESTS`       | 250; positive, maximum 2000                                           |
| `SEMANTIC_SEARCH_TIMEOUT_MS`          | 35000; positive, maximum 60000                                        |
| `SEMANTIC_SEARCH_CONCURRENCY`         | 4; positive, maximum 32                                               |
| `SEMANTIC_SEARCH_USER_PER_MINUTE`     | 30; positive, maximum 300                                             |
| `SEMANTIC_SEARCH_GLOBAL_PER_MINUTE`   | 300; positive, maximum 10000                                          |
| `SEMANTIC_SEARCH_PROFILE_FINGERPRINT` | Compose API-only optional override of `EMBEDDING_PROFILE_FINGERPRINT` |

Provision immutable profiles with the established operator process. Index a
representative owned corpus and verify active READY mappings, profile dimensions,
collection metadata and provider model compatibility before selecting serving:

```sql
-- Trusted operator selection, never a client request; use a reviewed profile UUID.
INSERT INTO ai_serving_profile (id, embedding_profile_id, updated_at)
VALUES (1, '<reviewed-profile-uuid>'::uuid, now())
ON CONFLICT (id) DO UPDATE SET
  embedding_profile_id = EXCLUDED.embedding_profile_id, updated_at = now();
```

Set the API's matching full fingerprint and calibrated score policy. A mismatch
returns 503, never falls back to another model. The singleton selection is global
but each request remains owner scoped. Selecting a new profile can leave users
with no eligible indexes until their profile-specific builds are READY; ingestion
never auto-selects the serving profile. Reverting the pointer and matching API
configuration can serve retained compatible READY mappings again.

T08's API ingestion/embedding equality check now allows distinct enrollment and
query profiles when semantic serving is enabled, so a replacement build does not
force early serving activation. Worker configurations with search disabled retain
the original equality check, and handlers still enforce exact job profile identity.
Use the API-only Compose fingerprint override during a staged rollout; set separate
API endpoint/key configuration if different provider infrastructure is needed.

Compose adds only API membership to the existing **internal** `vector` network
and server-side embedding/Qdrant settings. Qdrant remains private with no host
port/Nginx route. Enable API-key authentication in production; private HTTP requires
existing explicit opt-in, otherwise use TLS. Browser bundles receive no credentials.

## Observability and verification

Structured events record input length, provider/model/profile identity, scope and
candidate/result counts, embedding/vector/total durations and safe failure category.
Existing correlation IDs join request logs. Query strings, excerpts, vectors,
payload text, credentials and provider response bodies are never logged. Search
adds no separate metrics backend; the structured event sink remains the existing
operational integration point.

Unit tests cover immutable profile/query purpose, vector validation, score/ranking,
deduplication, empty scope, revocation, overfetch, provider failures, timeouts and
bounded admission. Native-adapter tests inspect mandatory prefilters, projection,
read-only compatibility and forged identities. Real PostgreSQL/Qdrant HTTP tests
upload PDFs as two authenticated users, execute all real durable stages with a
deterministic test provider, verify owned content/provenance, forged references,
retained mappings, archive/restore races, new versions and soft deletion. The test
provider substitutes only the external embedding API, not durable or vector state.

Verification used host Node 24.9.0, PostgreSQL 17 in a fresh isolated
`qyvra_t09_api_test` database and a private loopback Qdrant v1.19.2 test container.
All 15 existing migrations applied successfully; no T09 migration is necessary.

| Executed check                                                                  | Result                                                                                                                                 |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| API `nest build` (host and final Docker build, including shared package builds) | Passed                                                                                                                                 |
| `tsc --noEmit --incremental false`                                              | Passed, including new tests                                                                                                            |
| API ESLint / Prettier source and test checks                                    | Passed                                                                                                                                 |
| Full API unit Jest suite                                                        | 37 suites, 369 passed, 1 optional live-Redis test skipped                                                                              |
| Full existing API E2E suite                                                     | 15 suites, 281 passed                                                                                                                  |
| Affected Swagger health/document E2E suites after module-list correction        | 2 suites, 75 passed                                                                                                                    |
| Final semantic integration suite with `TEST_CONTAINER_IMAGE` enabled            | 10 passed, 0 skipped; real authenticated uploads, extraction/chunking/checkpoints/activation, SQL/Qdrant retrieval and container query |
| T04–T08 and processing-status integration regressions                           | 6 suites, 69 passed, 5 optional broker/Redis cases skipped                                                                             |
| Correctly named T03 `ai-processing.integration-spec.ts`                         | 2 passed; duplicate outbox/delivery and shared retry/recovery                                                                          |
| Fresh PostgreSQL `prisma migrate deploy`                                        | 15 migrations applied                                                                                                                  |
| Final runtime Docker build and inspect                                          | Passed; `qyvra-t09-api-test`, user `node`, SHA-256 `4f72768b217fd306d91c1e00b50903b7f34c109a2f9827bc85e1545494fe4d59`                  |
| Native container provider/Qdrant query, OpenAPI and log privacy                 | Passed within the final 10-test integration run                                                                                        |
| `docker compose config --quiet`                                                 | Passed; Qdrant remains private                                                                                                         |
| Canonical Markdown link and final diff checks                                   | Passed                                                                                                                                 |

The first targeted test attempts exposed test-only TypeScript inference errors;
these were corrected before successful execution. The initial regression command
mistakenly included nonexistent `ai-pipeline.integration-spec.ts`; its six real
suites passed, then the intended `ai-processing.integration-spec.ts` passed
separately. No tests/assertions were disabled or weakened. Swagger's explicit
include list initially omitted SearchModule; the list and generated-schema
assertion were corrected and the final image rebuilt/retested.

The initial `git -c core.autocrlf=false diff --check` inspection misclassified the
workspace's existing CRLF lines as whitespace. The normal repository-configured
`git diff --check` passed; no unrelated line-ending rewrite was performed.

Unchanged full unit/E2E and passing pipeline suites were not repeatedly rerun
after the isolated Swagger registration/test change; affected Swagger checks,
builds, final semantic integration and source validation were used instead.
T08's live RabbitMQ tests were not repeated because T09 changes no jobs, outbox,
messages, consumers or recovery code. Live Redis and paid providers were not tested.
Real provider relevance calibration and production-scale/load/multi-replica
admission remain deployment verification, not evidence established by synthetic
equal-vector isolation tests. Existing user services/volumes were not reset.

To reproduce the final integration check, provision isolated PostgreSQL/Qdrant,
apply migrations, build the runtime tag, then set `TEST_DATABASE_URL`,
`DATABASE_URL`, `TEST_QDRANT_URL`, and `TEST_CONTAINER_IMAGE=qyvra-t09-api-test`:

```sh
# From apps/api; existing independent packages must be installed/built.
node node_modules/jest/bin/jest.js --config test/jest-integration.json \
  --runInBand --runTestsByPath test/semantic-search.integration-spec.ts
```

The container case uses loopback port 3019 and Docker Desktop's
`host.docker.internal` to reach the isolated host services. Tests create/clean
their owned records, private temporary storage and named API test container;
remove the isolated Qdrant container after verification.

## Files and exclusions

Created: five search-module TypeScript files (controller, service, repository,
module and service unit tests), `test/semantic-search.integration-spec.ts`, this
guide. Modified: API AppModule and Swagger registration, configuration contract/getter/validator/tests,
Qyvra vector boundary, native Qdrant adapter/tests, `.env.example`, Compose and
canonical documentation links/status. No Prisma schema, migration, package/lockfile,
worker processing, historical release snapshot or frontend changes in T09.

No RAG, prompts, LLM completion/chat, answer generation, final citations, search UI,
hybrid search, reranking, query rewriting/HyDE, OCR, agents, external tools/actions,
LangChain, LangGraph, MCP or Hermes. Recommended T10: bounded grounded RAG using
this authorized retrieval contract, independent generation-provider configuration,
context budgets, evidence abstention, source-token validation and owned citations.

The complete T09 project-file inventory (7 created, 21 modified) is:

| Created                                                                                           | Purpose                                            |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [search.module.ts](../apps/api/src/modules/search/search.module.ts)                               | Read-only query DI/adapters                        |
| [semantic-search.controller.ts](../apps/api/src/modules/search/semantic-search.controller.ts)     | Guarded DTO/API/OpenAPI                            |
| [semantic-search.service.ts](../apps/api/src/modules/search/semantic-search.service.ts)           | Bounded authorized retrieval                       |
| [semantic-search.repository.ts](../apps/api/src/modules/search/semantic-search.repository.ts)     | SQL scope and provenance hydration                 |
| [semantic-search.service.spec.ts](../apps/api/src/modules/search/semantic-search.service.spec.ts) | Deterministic unit/security/budget tests           |
| [semantic-search.integration-spec.ts](../apps/api/test/semantic-search.integration-spec.ts)       | Real HTTP/PDF/SQL/Qdrant/container tests           |
| This guide                                                                                        | Canonical behavior, configuration and verification |

| Modified                                                                                                                                                                                                                                                                                                                       | Change                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| [AppModule](../apps/api/src/app.module.ts), [Swagger registration](../apps/api/src/configure-swagger.ts)                                                                                                                                                                                                                       | Search feature/API discovery                                 |
| [settings](../apps/api/src/configuration/settings.ts), [configuration service](../apps/api/src/configuration/configuration.module.ts), [validation](../apps/api/src/configuration/environment.ts), [configuration tests](../apps/api/src/configuration/environment.spec.ts)                                                    | Opt-in policies and staged-profile compatibility             |
| [vector boundary](../apps/api/src/modules/ai/vector-store.ts), [native adapter](../apps/api/src/infrastructure/vectors/qdrant-vector-store.ts), [adapter tests](../apps/api/src/infrastructure/vectors/qdrant-vector-store.spec.ts)                                                                                            | Query capability, mandatory filters, candidate normalization |
| [.env.example](../.env.example), [Compose](../docker-compose.yml)                                                                                                                                                                                                                                                              | Search controls, API private network/credentials             |
| [root README](../README.md), [documentation index](README.md), [API](api.md), [architecture](architecture.md), [database](database.md), [roadmap](roadmap.md), [specification](specification.md), [Compose guide](compose.md), [Phase 4 contract](phase-4-ai-rag.md), [environment guide](deployment/environment-variables.md) | Accurate Implemented/Planned status and canonical links      |

Existing T01–T08 working-tree changes are preserved. Historical v1.0.0, v1.1.0
and v1.2.0 release/developer snapshots are unchanged. T09 is complete; T10 is subsequently implemented in [the grounded-answer guide](phase-4-rag-answers.md). No new ADR is required beyond the existing ownership/profile/index
decisions; the bounded-scope and API/worker configuration concretizations are
documented above.
