# Phase 4 T06 — Embedding generation and durable checkpoints

PDF extraction, deterministic chunks, citation provenance, provider-agnostic embedding
generation and PostgreSQL vector checkpoints are **Implemented**. Qdrant/index execution (T07), ingestion (T08), semantic retrieval (T09), RAG (T10) and citation navigation (T11) are implemented in their owning slices. T06 itself adds no automatic upload enrollment. No new HTTP endpoint,
agent framework, migration, npm dependency or provider credential is introduced by T06.

[Architecture](phase-4-ai-rag.md) | [Data foundation](phase-4-data-foundation.md) |
[Processing](phase-4-processing.md) | [Chunk generation](phase-4-chunk-generation.md)

Current next-stage status: [T07 indexing, activation and cleanup](phase-4-vector-indexing.md) are implemented. This guide retains the T06 completion evidence; [T09 retrieval](phase-4-semantic-search.md), [T10 RAG](phase-4-rag-answers.md) and [T11 frontend](phase-4-ai-frontend.md) are implemented.

## Owned provider contract and concrete adapter

`EmbeddingProvider.embed` takes an immutable profile, ordered ID/text inputs, document/query
purpose and cancellation signal; it returns ID/vector results. It exposes no provider SDK
types, HTTP responses or raw errors. Query purpose is an extension contract; query orchestration
and retrieval are not implemented. Future local/Ollama adapters can implement this same
boundary without changing the durable job system. There is no provider fallback.

The first adapter uses Node 24 native `fetch` with the OpenAI-compatible embeddings HTTP
contract. It sends exactly model, ordered input strings, `encoding_format: float` and optional
dimensions. It does not send Qyvra user/document/chunk IDs or an instruction as a chat prompt.
Returned numeric indices map vectors to the original input IDs; response array order is not
trusted. Returned model must match the configured profile model. Redirects are rejected.
The schema follows the [official embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create).
No SDK retry loop, SDK dependency, browser, model server or AI framework is required.

## Profile and input identity

Reuse T02 immutable `EmbeddingProfile` and `embeddingProfileFingerprint`. Provider, model,
operator-pinned revision, dimensions, profile version, Cosine distance, normalization,
tokenizer/version and document/query instructions all participate in the fingerprint.
Endpoint, credentials, timeout, batching and retries do not. The worker accepts only the
explicitly configured fingerprint and never substitutes a model based on dimensions alone.

This adapter supports provider `openai-compatible`, tokenizer `cl100k_base`, tokenizer version
`tiktoken-1.0.22` and normalization version `qyvra-embedding-input/v1`. That normalization keeps
canonical chunk text unchanged, prefixing a nonempty profile document instruction followed
by exactly one LF. Query purpose uses the pinned query instruction instead. `inputHash` is
SHA-256 of the exact UTF-8 string sent after that transformation. It is persisted together
with chunk ID and profile ID. Text is never rewritten or truncated to meet provider limits.

Profiles are not automatically seeded. An operator must provision an immutable T02 profile
with `embeddingProfileFingerprint`, select its fingerprint in worker configuration and use
its ID in an explicit T03 run. Example semantic identity for a compatible model:
`openai-compatible`, `text-embedding-3-small`, 1536 dimensions, profile version 1,
`qyvra-embedding-input/v1`, `cl100k_base` / `tiktoken-1.0.22`, empty document/query instructions,
and an operator-managed model revision. Operators must verify endpoint/model compatibility
and provider retention/residency before enabling off-host disclosure. A mutable provider
alias cannot prove a pinned model revision: response model checks detect label changes,
not silent upstream weight drift. Drift requires suspending that profile and a new identity.

## Batching, validation and resource bounds

Only a complete owned chunk set from the completed `GENERATE_CHUNKS` predecessor is eligible.
Load a bounded page of chunks by zero-based ordinal, including checkpoints for the selected
profile. Verify count/order, meaningful text, each existing input hash, dimensions and vector.
Batch size is the minimum of configured batch size, floor(max batch tokens / max input tokens)
and floor(500000 / dimensions), with a minimum of one. This conservative budget is deterministic;
it may use fewer inputs than configured. The adapter counts the actual transformed input using
the pinned tokenizer, including instructions, and checks individual and aggregate token limits.
The 500000-value cap bounds vector serialization/memory and short PostgreSQL transactions.

Every result in a provider batch must pass validation before any row in that batch is written:
exact count, expected distinct IDs/indices, matching model, exact dimensions, numeric finite
values and a nonzero vector. Reject missing/duplicate/foreign results, NaN/Infinity, padding,
truncation and all-zero output. JSON body reads are bounded to min(32 MB, inputs × dimensions ×
32 + 65536) bytes, even without Content-Length. An abortable request/body timeout is at most
half the worker lease. No partial malformed response is checkpointed; earlier valid batches remain.

## Durability, concurrency and recovery

The existing `ProcessingRepository.heartbeat` rechecks authoritative document/current-version/
desired-run eligibility immediately before each provider call and renews the matching live lease.
No database transaction spans a network call. A timeout fits inside the renewed lease.
After full response validation, the new repository `checkpoint` method locks document then job,
rechecks lifecycle/run and the live lease token, invokes a database-only callback, and checks the
lease again before committing. A stale worker cannot checkpoint, complete or enable indexing.

Each atomic batch inserts actual `double precision[]` vectors into existing immutable
`ChunkEmbedding` rows, unique `(chunkId, embeddingProfileId)`, with owner/version foreign keys,
dimensions, exact input hash and completion timestamp. An existing compatible row is preserved;
an incompatible row fails closed. Interrupted transactions roll back the whole batch. SQL
finite/nonzero/dimension and complete-parent constraints remain the final database boundary.
Vectors are private durable data and subject to PostgreSQL access/backup retention controls.

Subsequent executions skip compatible checkpoints. A crash after an external request but before
SQL commit can repeat provider work/billing; a crash after checkpoint but before acknowledgement
does not repeat that completed chunk. This is at-least-once execution, not exactly-once billing.
Identical profile/chunks can reuse vectors across runs. Changed profile/model/revision/dimensions/
instructions create new profile identities; changed chunk/extraction generations create new chunk
IDs. Old provenance/checkpoints remain isolated. Preserve an existing ready index during a rebuild
as established by T03/T05; T06 never pretends a newly generated vector has been indexed.

After all required checkpoints validate, the router's existing `complete` transaction checks the
count and atomically completes the embedding job, creates the BUILDING vector manifest and one
`INDEX_VECTORS` job/outbox intent. No Qdrant call occurs. Unimplemented indexing remains explicit
`HANDLER_NOT_IMPLEMENTED` at the T06 checkpoint. T07 now registers the real verified indexing handler; see [its current lifecycle](phase-4-vector-indexing.md).
No empty/whitespace chunk gets a vector; extraction/chunk no-text outcomes block this stage.

## Failure policy and observability

429, 408, provider 5xx, network errors and request/body timeouts are retryable. Credentials/permission
errors, other rejected requests, incompatible profiles, token limits and malformed vectors are
terminal safe categories. Known database uniqueness/FK/check violations are terminal checkpoint
errors; temporary persistence failures use the existing retry infrastructure. No response body,
exception cause, secret, input text or vector is stored in failures/logs.

The only shared retry extension is an optional bounded `retryAfterMs` (0–3600000) on retryable
handler results. Numeric seconds or HTTP-date Retry-After is normalized by the adapter. Existing
`ProcessingRepository.fail` persists availableAt using max(existing bounded backoff, hint), with
the same attempts/exhaustion/recovery/outbox path. There is no new queue, job table or retry loop.
An invalid entire batch is terminal and never advances downstream. AI failures do not affect originals.

Structured logs contain safe job/version/profile/provider/model/version, attempt, batch size,
committed chunk count, duration and failure category. Redis `EMBEDDING` progress is optional and
computed only after compatible checkpoints are counted/committed; progress loss cannot change success.
PostgreSQL stage state and checkpoints are authoritative. No token usage/cost is fabricated.

## Configuration and deployment

All settings use existing startup validation and `ConfigurationService.embedding`:

| Variable                        | Default / rule                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `EMBEDDING_ENABLED`             | false; opt-in, no credentials required for ordinary startup/build                        |
| `EMBEDDING_ENDPOINT`            | Required when enabled; full POST URL, HTTPS, no credentials/query/fragment               |
| `EMBEDDING_PROFILE_FINGERPRINT` | Required when enabled; 64 lowercase hex digits, exact immutable profile                  |
| `EMBEDDING_API_KEY`             | Optional private bearer secret; authenticated providers require operational provisioning |
| `EMBEDDING_ALLOW_HTTP`          | false; explicit exception for a protected private local compatible endpoint              |
| `EMBEDDING_BATCH_SIZE`          | 32, range 1–128, further reduced by token/vector budgets                                 |
| `EMBEDDING_MAX_INPUT_TOKENS`    | 8191, range 1–8192; operator must verify actual model limits                             |
| `EMBEDDING_MAX_BATCH_TOKENS`    | 100000, up to 300000 and at least max input tokens                                       |
| `EMBEDDING_TIMEOUT_MS`          | min(30000, half worker lease); positive, at most half lease                              |
| `EMBEDDING_SEND_DIMENSIONS`     | true; disable for compatible models without this request field                           |

Compose injects these settings into the worker only; API, outbox and frontend receive no provider
key. The worker image uses existing Node/WASM dependencies and requires no key while building.
The Compose private bridge supports outbound HTTP(S); operators must restrict egress to the exact
configured endpoint, protect local HTTP with network policy, and use TLS across trust boundaries.
The URL is trusted operator configuration, never document/user input. HTTP redirects cannot move
credentials to another host. Qdrant remains absent/private/planned. No provider can authorize access.

## Verification and remaining scope

Tests use deterministic provider fakes and a local HTTP server, with real PostgreSQL checkpoints;
normal tests require no paid API call or external provider key. Worker-container verification uses
the compiled real HTTP adapter against an in-container local server with external networking disabled.
Live paid-provider quality, residency, rate limits, costs and revision stability require separately
gated operator verification; no paid provider call is claimed by this task.

T07 should implement private Qdrant integration, confirmed idempotent upserts, complete manifest
activation, lifecycle cleanup/reconciliation and rebuilds from these durable vectors. Retrieval,
RAG, final citations, agents, OCR, LangChain/LangGraph, MCP/Hermes and local model orchestration
remain outside T06. Phase 4 is not release-complete merely because embedding generation works.

## T06 file inventory and verification record — 6 October 2026

Eight files created:

- `apps/api/src/modules/ai/embedding-provider.ts` and `embedding-provider.spec.ts`.
- `apps/api/src/infrastructure/embeddings/openai-compatible.provider.ts` and `openai-compatible.provider.spec.ts`.
- `apps/api/src/infrastructure/worker/embedding-generation.handler.ts`.
- `apps/api/test/embedding-generation.integration-spec.ts`.
- `apps/api/test/embedding-container-smoke.cjs`.
- This guide, `docs/phase-4-embedding-generation.md`.

Twenty-three files modified by T06 (earlier T01–T05 working-tree changes preserved):

- `.env.example`, `docker-compose.yml`.
- `apps/api/src/configuration/{settings,environment,environment.spec,configuration.module}.ts`.
- `apps/api/src/infrastructure/worker/{processing-message-handler,worker.module}.ts`.
- `apps/api/test/worker.integration-spec.ts`.
- `packages/database/src/processing-repository.ts`.
- `README.md`, `docs/README.md`, `docs/architecture.md`, `docs/database.md`, `docs/api.md`,
  `docs/roadmap.md`, `docs/specification.md`, `docs/compose.md`, `docs/deployment/environment-variables.md`,
  `docs/phase-4-{ai-rag,data-foundation,processing,pdf-extraction}.md`.

No migration, table, dependency, lockfile, Dockerfile or historical release snapshot changed in T06.
The only architecture concretizations are the versioned input transformation, conservative batch
budgets, intermediate lease-fenced checkpoint boundary and bounded hint in the existing retry API.
These follow T01–T05; no parallel job system or competing vector representation was introduced.

| Executed check                                                                                         | Result                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `npm.cmd --prefix apps/api run build`                                                                  | Shared storage/database generation/build and Nest production build passed                                |
| API `tsc --noEmit --incremental false`; database `npm.cmd ... run typecheck`                           | Passed                                                                                                   |
| API/database `npm.cmd ... run lint`; Prettier on all changed TypeScript and canonical documentation    | Passed                                                                                                   |
| Complete API Jest unit suite, with disposable `TEST_REDIS_URL`                                         | 32 suites, all 324 tests passed                                                                          |
| Final focused embedding contract/real HTTP adapter unit check                                          | 2 suites, 23 tests passed, including sparse/nonfinite vectors                                            |
| Affected PostgreSQL integration suites: extraction, chunking, embedding, AI processing, status, outbox | 6 suites, 55 tests passed, 5 optional broker cases skipped in that invocation                            |
| T06 checkpoint integration coverage across full and focused runs                                       | All 16 cases verified, including separately enabled real RabbitMQ duplicate-delivery case                |
| Dedicated worker/RabbitMQ regression coverage                                                          | All 5 cases verified across full and corrected context-only runs; embedding handler registration checked |
| `npm.cmd --prefix packages/database run test:pipeline`                                                 | All 27 tests passed: claiming, fencing, retries, recovery, outbox and lifecycle                          |
| API complete e2e suite                                                                                 | 15 suites, all 281 tests passed                                                                          |
| `migrate:deploy` on fresh `qyvra_t06_api_test`                                                         | All 14 existing migrations applied; no new migration needed                                              |
| Production PostgreSQL query-budget checkpoint test                                                     | Real 1536-dimensional vectors committed with 500 ms query timeout                                        |
| Markdown links and `git diff --check`; Compose configuration                                           | Passed; release snapshots unchanged                                                                      |

The initial new fixture lacked required PDF page metadata and was corrected. The lifecycle fixture
was corrected to update both archive fields required by existing invariants. The reprocessing test
was corrected to pass canonical request fields rather than spreading a persisted row ID. An initial
worker-context invocation lacked required `DATABASE_URL`; its four other broker checks passed,
and the failed context-only check passed after supplying that environment variable. Tests and
constraints were not weakened. No unrelated failing suite remains from these checks.

Existing passing checks were not repeated after documentation-only edits. Unchanged frontend
build/browser suites and historical migration rollback suites were not rerun; there is no new
schema or frontend behavior in T06. Optional paid-provider verification was deliberately not run.

The final Docker runtime build passed. Image `qyvra-t06-worker-test` has identity
`sha256:17a35c91cec33c007164f98a88de473394252fa8100a1a5dffec8f0c98734b11`.
The container embedding smoke passed with external networking disabled and a 512 MiB memory
limit: compiled worker/provider imports, local HTTP, WASM token limits, Unicode and explicit
vector index/ID mapping. No paid call/key was used. All 275 local documentation links/anchors
passed. Disposable test broker/Redis containers were removed and the host test PostgreSQL
instance was stopped gracefully; the existing application stack was left running.

T06 is complete within its scope. Remaining operational risks are duplicate provider billing
before an uncommitted checkpoint, upstream model drift despite unchanged aliases, provider
privacy/retention approval and PostgreSQL checkpoint storage/backup growth. Validate live
provider deployment separately before enabling real processing. T07 was not started.
