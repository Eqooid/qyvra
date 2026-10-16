# Phase 5 T07 — Hybrid candidates, document fusion and bounded result windows

Status: **Implemented; local verification recorded below, live acceptance pending.**
Verification date: **15 October 2026**. `VERSION` stays `1.3.1`; v1.4.0 remains the
Phase 5 target. No release, model provisioning or deployment occurred.

[Approved plan](phase-5-search.md#t07--hybrid-candidates-document-fusion-and-bounded-result-windows) |
[Ranking decision](decisions/ADR-008-cross-index-hybrid-ranking.md) |
[T06 keyword baseline](phase-5-keyword-search.md) | [API](api.md)

**T08 increment:** [safe lexical evidence and source navigation](phase-5-search-evidence.md)
add request-local hints and optional bounded ES hint refreshes on continuation.
Those reads never refill/rescore/rerank windows, and Redis still stores no text or
highlight ranges. Existing T07 verification statements below remain historical.

## Architecture and API

SearchModule now owns `HybridSearchService`, document ranking and the existing
keyword route's fixed-window orchestration. `POST /api/v1/search/hybrid` is additive;
`POST /api/v1/search/keyword` keeps its request and result fields and gains cursor
continuation. Both use `KeywordSearchDto`, authenticated sessions, trusted owner
and session context, Origin/CSRF checks and no-store response envelopes. A caller
cannot choose an index, collection, provider, ranking weights or raw query DSL.
The existing `/search/semantic` remains semantic-only, capped at 20 chunks, without
new filters/window fields. RAG still calls that existing semantic service.

Keyword and Hybrid are separate routes, **not a client mode switch**. Reject an
unknown `mode` field with 400. Shared input supports NFC plain query (1–4000 UTF-16
units, at most 64 word runs), terms/phrase matching, relevance-only sorting,
limit 1–20/default 10, explicit owned document IDs, and all T06 metadata filters.
Unknown fields, null optionals, malformed IDs/dates, inverted ranges and unsupported
values remain invalid. Repeat the same query/filter/limit with a supplied cursor.

```json
{
  "query": "renewal agreement",
  "match": "terms",
  "limit": 10,
  "filters": { "mimeType": "application/pdf" }
}
```

Keyword returns `{results,coverage,pagination}`. Hybrid adds `mode: "hybrid"` and
uses `ranking: "document-rrf60-v1"`. Each result is a canonical current document
with its immutable version, filename/title/type/status/category/tag metadata,
fixed-window ordinal `rank` and at most three matches. Raw scores, engine documents,
vectors, storage paths, authorized-match totals and owner internals are excluded.
Semantic-only results do not invent a lexical projection ID.

Matches discriminate metadata/page/chunk. Existing keyword matches retain bounded
plain snippets and extraction/page/scalar-offset provenance. Chunk matches contain
`chunkId`, `chunkSetId`, `indexManifestId`, `embeddingProfileId` and canonical scalar
snippet offsets. Snippets are plain strings, at most 400 Unicode scalars, never
HTML. Preserve at least one representative from each available leg; no generated
answer or advanced highlight/source endpoint is added.

## Candidate sources and compatibility

`KeywordSearchService.candidates` uses the T06 private lexical adapter and the same
SQL projection/hash/revision checks. Its internal server-owned budget allows 100
document groups without weakening the public page-size DTO. Metadata/page raw-hit
caps remain independently bounded by configuration and response-byte budgets.
Collapse by highest eligible match score; stable document UUID ties. Preserve
internal source rank, score, user/version identity and at most three minimal record
references. No additional ES client is instantiated.

`SemanticSearchService.candidates` is an intentional internal boundary on the same
service/provider instances. It validates the selected SQL profile fingerprint,
recomputes immutable identity, checks Cosine and uses the existing query embedding
purpose/instructions/tokenizer/dimension validation. `QdrantVectorStore.check` is a
read-only collection/profile/dimension/schema check, including empty scope. The
existing search operation retains mandatory user/profile/version/manifest filters.
No collection creation, ingestion, re-embedding or provider fallback occurs.

The candidate boundary uses at most 100 raw vector hits, SQL-hydrates them through
current owned READY manifests, and retains existing minimum-score and manifest caps.
Collapse chunks to each document's highest eligible cosine score, then UUID ties,
with at most three exact chunk references. `LexicalDocumentCandidate` and
`SemanticDocumentCandidate` keep source-specific scores/ranks distinct internally.
No LLM text generation is called. Existing OpenAI-compatible and native Ollama
factories/tokenizer limits are reused; dimensions alone never establish compatibility.
Actual cloud/local model inference is **not verified by mock provider tests**.

## Shared filters, authorization and lifecycle

`KeywordSearchRepository.filteredDocuments` reuses the complete T06 eligible
predicate, including category/all tags, type/status, literal filename, MIME and
inclusive UTC date ranges. It selects at most the configured SQL scope cap (default
100 for hybrid; overflow requires narrowing with 400). Keyword preserves T06's
READY-projection scope cap rather than scanning all unindexed documents. These filtered document identities
constrain semantic manifests **before** Qdrant selection; the lexical leg uses the
same filters before ES selection. No arbitrary vault subset is silently selected.

Both engines remain candidate sources. After retrieval, a short PostgreSQL
repeatable-read transaction reloads filtered current document versions, lexical
READY projections with exact revision/hash/expected-record membership, and semantic
READY profile/manifests/chunk lineage. It checks serving generation and hybrid
profile selection in the same snapshot. Canonical metadata/text alone supply output.
Before the first window is stored, drop revoked references, recompute distinct
source ranks and fuse the remaining documents. Later pages never refill or rerank.

Archive, deletion, DELETING status, version replacement, changed filters, lexical
metadata hashes/publication invalidation and semantic manifest revocation exclude
results even when external records remain. A semantic match may remain eligible
without a lexical publication; its own READY RAG manifest is required. A lexical
match always needs its verified publication. Generation/profile cutover requires
restart (409). Current Qyvra has private `users.id` vault isolation; this task does
not invent a separate tenant/ACL model. Every engine query and SQL hydration uses
trusted user identity.

This snapshot is the request's authorization decision, not a distributed transaction
or guarantee against lifecycle changes after the snapshot. No external calls occur
inside it. Database failure never falls back to remote payload authorization.

## Deterministic fusion and fixed windows

ADR-008 is accepted for this bounded implementation. Freeze equal-weight RRF:
`sum(1 / (60 + rank_leg))`, one-based **distinct document** ranks and zero absent
contributions. Do not add BM25 and cosine scores. Repeated pages/chunks add no votes.
Exact fused ties use code-point document UUID ordering. The fixed mathematical
fixtures cover reciprocal ranks, ties, duplicate delivery and single/empty legs;
they do not constitute a judged relevance benchmark or language-quality tuning.

| Bound                     | Implemented policy                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Per-leg document window   | 100                                                                                                      |
| Semantic raw hits         | 100; no unbounded backfill                                                                               |
| Lexical raw hits          | Existing configurable cap <=200 per index kind; page budget also obeys adapter bytes                     |
| Union window              | <=200 documents; current shared SQL scope is <=100                                                       |
| Representative references | <=3 per leg/document; output <=3 total                                                                   |
| Page size / depth         | 1–20, traversing the finite window; no deep engine pagination                                            |
| Window TTL                | 300 seconds, never extended by reads                                                                     |
| Redis serialized payload  | <=256 KiB                                                                                                |
| Redis quotas              | <=8 live windows/owner, <=256 globally per Redis deployment (<=64 MiB serialized payloads plus overhead) |
| Authorization             | Bounded batched SQL reads; no application N+1 loop                                                       |

`SearchWindowStore` uses the existing Redis npm client and validated `REDIS_URL`,
connect/command timeouts. It has a lazy reused connection, no offline queue or
automatic reconnect loop, a five-second reconnect cooldown, and shutdown disposal.
Atomic Lua admission uses Redis TIME and a single bounded hash containing both
payloads and expiring owner/window field identities. At most 256 field names are
scanned; content is read only for the selected window. Hash-level eviction removes
payloads and quota membership together, preventing orphaned payloads after quota
index eviction. Individual deadlines are checked in Lua; the container hash expires
after 305 idle seconds. Keys share the `{search-windows}` hash slot. Never flush Redis. Quota denial
has the same explicit unpaginated first-page behavior as a Redis outage.

Windows contain authorized candidate identities, immutable references/revisions,
source ranks, query/filter digest, generation/profile binding, hashed session,
ranking version, expiration, page size and random signing metadata. **No raw query,
snippet, document metadata, embeddings or cached authorization decisions.** Every
page rehydrates SQL before displaying anything. Protect Redis as existing private
application infrastructure; possession of cache state never authorizes source reads.

Opaque cursors contain a random window locator, bounded offset and HMAC-SHA256 tag
using that window's independent random nonce. Bind owner/session, normalized
query/filter sets/defaults/page size, route mode, ranking version and server-owned
budgets/configuration. Tokens/signing material are never logged. Offset modification,
query/filter/session changes, expiry, eviction or incompatible selection return
400 for malformed syntax or 409 restart for an unusable valid cursor. Replays are
idempotent at the same fixed positions; canonically reauthorized content may change.

Pages traverse fixed slots. Revocations can yield short or empty pages; remaining
authorized slots determine `hasMore` and `nextCursor`. Never backfill or rerank a
materialized window. `rank` may have gaps after revocation. Exhaustion means the
end of this bounded window, **not globally exhaustive search**. Coverage reports
owned SQL document/publication readiness, not Elasticsearch/Qdrant match counts.

## Failure policy, configuration and observability

`HYBRID_SEARCH_ENABLED=false` is the only new environment setting. Enabling requires
validated keyword and semantic serving. It requires matching query embedding and
Qdrant configuration, independently of the text-generation/RAG enable flags.
Keyword still works with all AI functionality disabled. Compose forwards this flag
to the API only; existing workers, networks, stores and dependencies remain intact.
No migrations or dependency upgrades are introduced.

Hybrid is strict: unavailable/incompatible ES, Qdrant or embedding profile/provider
fails 503/504; provider input-budget failure is 400 and throttling is 429. A healthy
leg with no eligible matches is valid. Never silently label keyword fallback as
hybrid. Admission uses existing keyword user/global/concurrency budgets; source
services retain their own admission. Request deadline is keyword timeout in keyword
mode, or max(keyword, semantic timeout) in hybrid, bounded by existing 60-second
validation. Work slots remain occupied until started work settles; provider/vector
SDK timeouts still bound in-flight work where cancellation is unavailable.

Initial Redis failure returns authorized results with `paginationAvailable:false`,
`nextCursor:null`, `hasMore` from authorized retained slots and `truncated:true` if
more were available. If no continuation is needed, no Redis write is required.
Continuation Redis failure is **503**, including unconfigured Redis; missing/expired
window on a healthy Redis is 409. SQL errors use the existing sanitized 500 path.
No failure becomes a fake empty successful hybrid response.

Structured events record mode, bounded authorized leg counts, retrieval/fusion and
SQL authorization durations, final result counts, continuation availability and
sanitized failure category. They contain no raw query, content, cursor, credentials
or document/user metric labels. Existing semantic embedding/vector timings remain.
No percentile latency, production throughput or cross-language ranking claim is made.

## Verification and acceptance

Local commands ran with Node 24.9.0 and PostgreSQL 17 on isolated loopback port 55435. A fresh `qyvra_phase5_t07_test` applied all 17 existing migrations.

| Actual command/check                                                                                                                                                                                | Result                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| API `npm run lint`, `format:check`, `typecheck`, `build`                                                                                                                                            | PASS, including shared storage/database and worker compilation                                                                              |
| API `node node_modules/jest/bin/jest.js --runInBand`                                                                                                                                                | PASS: 651 tests, 2 skipped, 54 suites; includes OpenAI/Ollama adapter fixtures and semantic/RAG/worker regressions                          |
| Integration selector `(keyword-search\|search-publication\|search-contracts\|search-enrollment\|pdf-extraction\|ai-processing\|documents\|outbox).integration-spec.ts$` with real TEST_DATABASE_URL | PASS: 78 tests, 4 skipped, 8 suites; new hybrid case uses real SQL/READY lineage and simulated engines/query embeddings                     |
| Full HTTP regression suite, `node node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand --silent`                                                                                   | PASS: 297 tests, 16 suites; documented SQL/service doubles, not Compose E2E                                                                 |
| Final keyword/hybrid native SQL integration rerun after keyword scope compatibility adjustment                                                                                                      | PASS: 15 tests; optional real-ES case skipped                                                                                               |
| Final focused keyword/hybrid/semantic/ranking/window/config rerun                                                                                                                                   | PASS: 101 tests, 1 live-Redis case skipped, 6 suites; includes cache allow-list, provider errors, admission and keyword-scope compatibility |
| Final cache/ranking/orchestration check after single-hash quota hardening                                                                                                                           | PASS: 28 tests, 1 live-Redis case skipped, 3 suites; selected lint/format checks passed                                                     |
| Keyword/hybrid HTTP guard/DTO/OpenAPI focused suite                                                                                                                                                 | PASS: 16 tests, using SQL/service doubles                                                                                                   |
| `node --test infrastructure/test/search-compose.test.cjs`                                                                                                                                           | PASS: one private topology contract                                                                                                         |
| `node --check infrastructure/test/search-runtime.cjs`                                                                                                                                               | PASS                                                                                                                                        |
| Compose `config --quiet` with explicit synthetic configuration-only secret paths                                                                                                                    | PASS; renders without starting services                                                                                                     |
| `docker info`                                                                                                                                                                                       | BLOCKED: Docker engine pipe missing; no containers started                                                                                  |
| Real Redis window quota case                                                                                                                                                                        | SKIPPED without TEST_REDIS_URL                                                                                                              |

An initial SQL fixture used a parser identity inconsistent with its canonical
extraction; the existing database guard rejected it. The fixture now uses the
artifact's exact identity and the full rerun passed. Continuation with unconfigured
Redis correctly returns 503; the previous first-page-only HTTP expectation was
updated to the T07 contract. No production constraint was relaxed. Final cache-boundary review also replaced a
semantic reference object spread with an explicit identifier allow-list; regression
tests assert that real-shape SQL sources cannot copy text/filenames into windows.

Infrastructure checks are reported separately from test doubles. Docker engine named pipe is absent in this
session: real ES/Qdrant/Redis, live provider inference, full authenticated upload-to-
hybrid Compose workflow, restart/outage injection and remote CI are **not verified**.

Run API lint/format/typecheck/build and unit tests from `apps/api`. PostgreSQL tests
use a disposable `TEST_DATABASE_URL`; never production data. The keyword integration
suite now includes a real SQL/extraction/READY semantic manifest/fusion/lifecycle
case with **simulated external stores/providers**. Existing real-Qdrant semantic/RAG
suites remain opt-in and skipped without `TEST_QDRANT_URL`. The Redis adapter's
optional quota/round-trip test requires `TEST_REDIS_URL`; its cleanup removes only
its own random keys and quota members. No mocked test substitutes for live service
acceptance. CI wiring is not evidence of a successful CI run.

- [x] Typed bounded legs, document RRF and canonical SQL reauthorization.
- [x] Owner/session/query/generation/profile-bound fixed keyword/hybrid continuation.
- [x] Strict hybrid failure and explicit disposable Redis behavior.
- [ ] Applicable real ES/Qdrant/Redis/model-backed workflow and judged relevance acceptance.
- [ ] Final CI/release review. Phase 5 is not released.

Next: **T08 — Safe highlights, private autocomplete and lexical source navigation**.
Objective: **make matches understandable and source references independently authorized**.
Frontend, autocomplete, advanced highlights, lexical source endpoints, physical
index cleanup, OCR, reranking and hybrid RAG answer generation remain deferred.
