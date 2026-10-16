# ADR-008: Application-side document ranking across lexical and vector indexes

Status: **Accepted for T07 implementation; live relevance/runtime acceptance pending**
Proposed: 2026-10-13
Implementation review: 2026-10-15

## Context

[Phase 5](../phase-5-search.md) must combine Elasticsearch relevance with existing
profile-isolated Qdrant retrieval. Current semantic search returns at most 20
canonical chunks; RAG depends on its public search/revalidation behavior. BM25,
cosine similarity and fused ranks are different measures. Paging independent
searches after fusion can change ordering and duplicate results.

## Decision (accepted for T07 implementation)

Keep Qdrant, independent embedding/generation providers and the existing RAG
default. Introduce a bounded SQL-authorized semantic-candidate boundary without
changing public semantic limits or citation behavior. Apply identical canonical
metadata/current-version filters before both engines select their candidates.

Collapse each leg to distinct current document/version identities, ranked by
its highest eligible match and stable UUID ties. Fuse document ranks in application
code using `sum(1 / (60 + rank))`, equal initial weights, absent contributions zero
and fixed independent candidate windows. Representative page/chunk matches retain
their own exact canonical provenance; metadata-only hits never invent source IDs.
Hard raw-hit caps and truncation signals bound long-document duplicate costs.

[Elastic's RRF reference](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)
explains rank-based fusion and fixed windows. This ADR recommends application-side
fusion across two existing stores; no Elastic-native vector migration is proposed.

For continuation, keep bounded short-lived authorized IDs/revisions/ranks in Redis,
never snippets or authorization decisions. Bind opaque cursors to owner/session,
normalized-input digest, serving generation/profile and ranking version. Reauthorize
and hydrate SQL on every page; do not refill or rerank an existing window. Expiry
or configuration cutover requires restarting search. First-page Redis loss permits
explicitly unpaginated results; continuation failure is explicit. Redis remains
disposable and cannot authorize content.

Hybrid dependency failures fail explicitly. A healthy leg with no eligible matches
is valid; an unavailable leg is not a successful hybrid result. UI keyword fallback
requires an explicit mode selection. Hybrid RAG integration is deferred.

## Alternatives considered

- Raw weighted BM25/cosine sum: simple, but incomparable scales require calibration.
- Normalized score fusion: possible later with judged evidence; small candidate
  windows and flat scores can make normalization unstable.
- Elasticsearch-native RRF/vector retrieval: changes existing Qdrant boundaries
  and deployment/license choices; unnecessary for cross-engine rank fusion.
- Learned/LLM reranking: new model/cost/context/privacy surface outside this slice.
- Recompute fusion for each page: little cursor state but changing candidate ranks
  can skip or duplicate documents; independent engine cursors do not fix this.
- Durable SQL search sessions: unnecessary persistent product state for expiring
  search navigation. Redis windows hold disposable identifiers only.

## Consequences and acceptance

Rank fusion avoids interpreting scores as probabilities and maintains provider
independence. It discards score magnitude and requires measured candidate budgets,
document grouping and judged relevance tests. Redis windows add bounded navigation
state; they do not promise a content snapshot or exact total matches. Changes in
ownership/version/lifecycle invalidate sources even within an existing window.

T07 owns ranking, window expiry/isolation, identical filters, profile cutover,
partial-backend failure and public semantic/RAG regressions. T11 requires judged
lexical/semantic/hybrid evaluation with fixed models and measured resource limits.
No ranking-quality, browser, model or recovery verification occurred in this ADR.

## T07 implementation review

Accepted equal-weight RRF60, fixed 100-document legs, <=200-document union, five-minute
Redis navigation and strict hybrid outages. Frozen rank/dedup/tie fixtures are
implemented; raw-score normalization and learned reranking remain deferred. Windows
use atomic per-owner/global quotas and canonical SQL page hydration, not content
caching. Keyword gains the same continuation without embedding dependency.
See [implementation, bounds and actual verification](../phase-5-hybrid-search.md).
Live provider/store workflow, judged relevance and production latency acceptance
remain outstanding; acceptance here records a design decision, not a release.
