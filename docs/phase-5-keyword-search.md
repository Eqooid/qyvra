# Phase 5 T06 — Authorized keyword search API

Status: **Approved T06 first-page API implemented and locally verified; live acceptance pending.**
Verification date: **14 October 2026**, uncommitted working tree including T01–T05.
`VERSION` remains `1.3.1`; Phase 5 is not released. The
[approved plan](phase-5-search.md#t06--authorized-keyword-search-api),
[projection ADR](decisions/ADR-007-rebuildable-keyword-search.md),
[T02](phase-5-data-foundation.md), [T03](phase-5-search-enrollment.md),
[T04](phase-5-elasticsearch.md) and [T05](phase-5-lexical-publication.md) own the
schema, lifecycle, private transport and verified publication boundaries.

**T07 increment (15 October 2026):** [fixed keyword continuation and hybrid retrieval](phase-5-hybrid-search.md)
now extend this endpoint. The first-page-only statements below preserve T06's
recorded task boundary; the linked T07 contract describes current cursor behavior.

**T08 increment:** [typed safe highlights, private suggestions and exact page sources](phase-5-search-evidence.md)
add optional evidence fields without changing document ranking or authorization.

## Scope and pagination task boundary

T06 adds the authenticated keyword endpoint, strict DTOs, pre-query SQL filters,
bounded metadata/page retrieval, canonical hydration, deterministic document
ordering and explicit partial coverage/failure behavior. No model provider,
embedding, vector query or RAG request is part of this path.

The broad task prompt asks for pagination, but the more specific approved
[T07 scope](phase-5-search.md#t07--hybrid-candidates-document-fusion-and-bounded-result-windows)
assigns Redis windows, cursor validation and **keyword continuation** to T07.
T06 therefore implements a bounded first page, not another pagination framework:
`paginationAvailable=false`, `nextCursor=null`; a syntactically valid cursor is
rejected with 409. No signed offset pretending to freeze Elasticsearch rankings,
server result cache or PIT is introduced. T07 must add owner/session/query/filter/
generation-bound expiring windows and page reauthorization. Full cursor acceptance
is not claimed by T06.

## Endpoint and request

`POST /api/v1/search/keyword` requires the existing session cookie,
`X-CSRF-Protection: 1`, and the existing Origin rules. Ownership comes only from
`SessionAuthGuard` and `CurrentUser`. Qyvra currently isolates private vaults by
stable `users.id`; there is no separate tenant entity or client-selected tenant.
The response uses the existing `{data, meta: {requestId}}` envelope and no-store
policy. OpenAPI registers typed input and response models and shared errors.

```json
{
  "query": "REF/AB-1",
  "match": "terms",
  "limit": 10,
  "sort": "relevance",
  "filters": {
    "mimeType": "application/pdf",
    "createdFrom": "2026-10-01",
    "createdTo": "2026-10-31"
  }
}
```

| Field                                                    | Validation/behavior                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `query`                                                  | Required literal text, NFC and trim, 1–4,000 UTF-16 units. Reject malformed surrogate pairs, controls and more than 64 Unicode letter/number runs. No wildcard/regex/script/query language is executed.                                                      |
| `match`                                                  | `terms` (default) or `phrase`; prefix/suggestions are not public options.                                                                                                                                                                                    |
| `limit`                                                  | Integer 1–20, default 10. Null/string coercion is rejected.                                                                                                                                                                                                  |
| `sort`                                                   | Only `relevance`; no arbitrary fields or ranking weights.                                                                                                                                                                                                    |
| `documentIds`                                            | Optional 1–50 distinct UUIDs, normalized to lowercase; every ID must be owned, active and not deleted. Foreign/missing/archived/deleted IDs produce the same 404. Legacy no-version documents are authorized resources but have no eligible file projection. |
| `filters.categoryId`                                     | UUID; foreign or nonexistent categories produce no matches.                                                                                                                                                                                                  |
| `filters.tagIds`                                         | 1–10 distinct UUIDs, all-of matching against owned associations.                                                                                                                                                                                             |
| `filters.documentType`                                   | Existing uppercase identifier convention, at most 50 characters.                                                                                                                                                                                             |
| `filters.status`                                         | UPLOADED, PROCESSING, READY, PARTIALLY_READY or FAILED; ARCHIVED/DELETING are excluded.                                                                                                                                                                      |
| `filters.mimeType`                                       | Current version's application/pdf, image/png or image/jpeg.                                                                                                                                                                                                  |
| `filters.filename`                                       | Nonblank literal case-insensitive current filename substring, at most 200 units; `%`, `_` and backslash are escaped for SQL matching.                                                                                                                        |
| `filters.dateFrom/dateTo`, `expirationFrom/expirationTo` | Existing inclusive calendar date semantics.                                                                                                                                                                                                                  |
| `filters.createdFrom/createdTo`, `updatedFrom/updatedTo` | Inclusive UTC calendar days on document timestamps; the upper bound is exclusive midnight of the following day.                                                                                                                                              |
| `cursor`                                                 | Reserved T07 continuation token. Malformed syntax is 400; any well-formed supplied token is 409 in T06.                                                                                                                                                      |

Reject inverted ranges, invalid calendar dates, null optionals, unsupported values
and unknown fields at both the HTTP DTO and service boundary. A filter applies
before candidate selection, not just after the top results have been retrieved.

## SQL authorization and lifecycle

`KeywordSearchRepository` selects current immutable versions of owned active
documents, applies the complete request filter set and explicit document scope,
then joins desired state to the ready projection. Eligibility requires:

- Exact document/version/owner and desired revision, with the current version
  selected by version number.
- No archive, deletion or DELETING state.
- A SERVING generation matching the operator-configured fingerprint and T04
  compatible physical names/schema/mappings.
- READY projection, metadata readiness, verification timestamp and records hash.
- Current `search_metadata_hash` equality, including organization membership.

Only those exact scopes enter Elasticsearch. More ready scopes than the configured
ceiling produce 400 and require narrower filters; no arbitrary vault subset is
silently selected. Coverage counts are computed from owned SQL-filtered eligible
versions, not from Elasticsearch hit totals.

After remote retrieval, one short PostgreSQL **repeatable-read transaction** checks
the serving generation again, recalculates scope/coverage and hydrates candidates
through the same predicates. Generation replacement/retirement returns 409 to
restart. Archived/deleted/replaced/invalidated candidates are omitted. Canonical
metadata comes from documents/version rows; text comes from owned canonical
extraction only after expected-record membership, source hash, exact page/segment
identity and deterministic scalar-offset checks. SQL reads only matching segments
of at most 8,192 scalars, not full PDFs. There is no application N+1 authorization
loop or network call inside this transaction.

This is authorization as of the final SQL snapshot, not an atomic distributed
transaction spanning ES and later lifecycle mutations. A newly published revision
or other scope change during retrieval marks the returned first page truncated.
Revocation after the final snapshot is observed by subsequent requests/source
access checks. No cached authorization or extracted snippets are retained.

Stale physical ES records need not be deleted for this boundary to exclude them.
T10 still owns physical cleanup, lost-index reconciliation and operator repair;
T06 performs neither repair nor indexing during a search request.

## Lexical query and deterministic results

The existing `LEXICAL_STORE` DI provider is reused; no controller/service creates
another client. Queries use explicit literal `multi_match`, authenticated `userId`,
generation and exact document/version/projection/revision filters. No query_string,
user DSL, aggregation or arbitrary index selection is accepted.

Metadata fields are title^3, description, issuer^2, referenceNumber^3 and filename^2;
page queries target text only. Terms require analyzed terms in a field, with an
additional phrase boost of 2. Phrase mode uses phrase matching. A server-owned
exact `referenceExact` term has boost 8 with punctuation-preserving NFKC/trim/lower
normalization. These are initial fixed weights, not a measured universal quality
claim. See [official multi-match semantics](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-multi-match-query).

Elasticsearch sorts by score descending, then exact document/projection IDs; page
queries additionally tie-break by page number and segment. The application groups
canonical hits by current document, chooses its highest eligible lexical score,
then uses document UUID code-point ties. A long PDF gains no score by adding its
page scores together. Return at most three representative matches per document.
[Official sort semantics](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/sort-search-results)
support the explicit keyword/numeric tie-breakers.

Raw ES scores remain **internal**: shared-index BM25 uses corpus statistics.
The public contract exposes ordinal `rank` and the label `lexical-bm25` instead of
raw scores or confidence. Rankings still depend on the shared index/analyzer;
broader relevance, language and resource budgets remain T11 evaluation work.

Responses contain document/version/projection IDs, version number, canonical title,
filename, MIME/type/status, category/tag IDs, rank and representative matches.
Metadata matches have no invented page/extraction reference. Page matches include
canonical extraction/page identity and half-open scalar offsets for the snippet.
Snippets are at most 400 Unicode scalars (at most 800 UTF-16 units), plain JSON
strings. Render them as text, never HTML; literal document markup is preserved
as data. No ES highlight payload, executable HTML, storage key, credential or
complete extracted artifact is returned. Metadata matched-field hints use
canonical literal tokens/phrases and exact-reference normalization; analyzer
alignment for advanced highlights remains T08.

```json
{
  "data": {
    "results": [],
    "coverage": {
      "eligibleDocuments": 3,
      "metadataReadyDocuments": 2,
      "textReadyDocuments": 1
    },
    "pagination": {
      "nextCursor": null,
      "hasMore": false,
      "paginationAvailable": false,
      "truncated": false
    }
  },
  "meta": { "requestId": "00000000-0000-4000-8000-000000000001" }
}
```

Coverage counts describe this owner's filtered publication coverage, **not keyword
match totals**. `hasMore` means additional authorized documents were found within
the bounded candidate retrieval beyond the page size. `truncated` means an
authorized raw-hit budget, page limit or changing SQL scope prevented a complete
first-page evaluation. Neither promises deep pagination or an exact match count.
Foreign/revoked hits never supply snippets, metadata, scores or hasMore counts.

## Configuration, failures and budgets

| Setting                                 | Default / ceiling                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEYWORD_SEARCH_ENABLED`                | false; enable only after T04/T05 live verification.                                                                                                                       |
| `KEYWORD_SEARCH_GENERATION_FINGERPRINT` | Required lowercase SHA-256 when enabled; independent from enrollment's BUILDING generation.                                                                               |
| `KEYWORD_SEARCH_TIMEOUT_MS`             | 10,000 / 60,000. Overall deadline includes SQL and remote operations.                                                                                                     |
| `KEYWORD_SEARCH_MAX_SCOPES`             | Adapter ceiling, normally 100 / 100; cannot exceed ELASTICSEARCH_MAX_SCOPES. Compose inherits the adapter setting unless explicitly set.                                  |
| `KEYWORD_SEARCH_RAW_HIT_LIMIT`          | 200 / 200 per index kind; page requests are also conservatively capped by the adapter response-byte budget (104 at the default 4 MiB). Independent from public page size. |
| `KEYWORD_SEARCH_CONCURRENCY`            | 4 / 32, per API process.                                                                                                                                                  |
| `KEYWORD_SEARCH_USER_PER_MINUTE`        | 30 / 300, per API process.                                                                                                                                                |
| `KEYWORD_SEARCH_GLOBAL_PER_MINUTE`      | 300 / 10,000, per API process.                                                                                                                                            |

API Compose forwards these settings; other runtimes retain their existing
responsibilities. T04's connection reuse, authentication/TLS, request/response
caps and private network continue to apply. No new service, index mapping,
dependency, migration or infrastructure deployment is introduced by T06.

Disabled serving, missing/incompatible indexes and search infrastructure failures
return 503, never a silent empty fallback. A valid empty scope still checks backend
availability and mapping compatibility. Deadlines return 504; admission is 429;
validation/scope exhaustion 400; authentication/Origin/CSRF 401/403; foreign explicit
document scope 404; cursor or serving change 409. Unexpected SQL failures retain
the existing sanitized 500 envelope. Logs contain stable failure categories only,
not queries, document text, credentials, URLs or raw SDK/database errors.

The SQL driver also has its existing query timeout. Overall timeout rejects the
response but holds the concurrency slot until abandoned work settles; it does
not pretend Prisma supports cancelling all in-flight SQL. Admission is currently
process-local, following the existing semantic-service convention. T07 owns the
broader window/admission review; no distributed quota guarantee is claimed here.

## Verification and outstanding gates

Executed on Node 24.9.0 and native PostgreSQL 17 using disposable test databases on
loopback 55435. Both fresh databases applied all 17 migrations. Do not run suites
with global serving-generation/recovery operations concurrently against one database.

| Actual command/check                                                                                                                                                                            | Result                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API npm lint, format:check, typecheck, build (shared storage/database hooks)                                                                                                                    | PASS. Backend and worker artifacts compile.                                                                                                                      |
| Full API Jest unit suite, `node node_modules/jest/bin/jest.js --runInBand`                                                                                                                      | PASS: 624 tests, 1 skipped, 51 suites; final targeted snippet/rank/byte-budget refinements passed the focused rerun below.                                       |
| Full API HTTP E2E, `node node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand`                                                                                                 | PASS: 296 tests, 16 suites. Existing suites use documented SQL/service doubles; this is not Compose E2E.                                                         |
| Integration selector `(keyword-search\|search-publication\|pdf-extraction\|search-enrollment\|search-contracts\|ai-processing\|documents\|outbox).integration-spec.ts$`, real TEST_DATABASE_URL | PASS after database isolation: 77 tests, 4 skipped, 8 suites. Includes real parser, SQL sessions/HTTP, filters and lifecycle; ES is simulated in ordinary cases. |
| Final focused keyword service/config/private ES adapter unit rerun                                                                                                                              | PASS: 74 tests, 3 suites after the final response-byte-budget and ordinal-rank refinements.                                                                      |
| Final keyword HTTP rerun, `--config apps/api/test/jest-e2e.json --testPathPattern=keyword-search.e2e-spec.ts$`                                                                                  | PASS: 15 tests.                                                                                                                                                  |
| Final native keyword SQL/parser/session rerun, `--config apps/api/test/jest-integration.json --testPathPattern=keyword-search.integration-spec.ts$`                                             | PASS: 14 tests; optional real-ES case skipped.                                                                                                                   |
| Database Node processing/AI/search regression suites, `--test-concurrency=1`                                                                                                                    | PASS: 76 tests against a separate migrated disposable database.                                                                                                  |
| `node --test infrastructure/test/search-compose.test.cjs`; runtime harness syntax                                                                                                               | PASS: one topology contract, private ES and preserved services.                                                                                                  |
| `node infrastructure/test/search-runtime.cjs`                                                                                                                                                   | BLOCKED before container build/start: Docker engine named pipe absent.                                                                                           |
| Optional real-ES keyword matching/ordering/isolation/restore case                                                                                                                               | SKIPPED without TEST_ELASTICSEARCH_URL. No live ES matching quality or failure certification.                                                                    |
| Full authenticated upload→broker→worker→keyword Compose workflow, live restart/outage faults and remote CI                                                                                      | NOT EXECUTED.                                                                                                                                                    |

An initial concurrent run shared one test database between application and database
regression processes, causing serving-state/reconciliation fixture interference.
Corrected independent-database reruns passed; no application guard was weakened.

`keyword-search.service.spec.ts` covers invalid DTOs, unknown fields, Unicode,
limits, plain snippets, SQL-only output, foreign/stale hits, errors, deadline/admission
and the T07 cursor boundary. Adapter tests capture owner/scopes, exact-reference
boosts, safe DSL and stable sorts. The new HTTP suite covers authentication,
Origin/CSRF, no-store envelopes and typed OpenAPI. Native integration verifies
filters before retrieval, canonical page spans, two-owner isolation, exact current
version/metadata/publication fencing, cleanup lag, scope limits and actual SQL
session authentication through the endpoint. An optional live case publishes via
T05 into isolated ES indexes, then verifies actual keyword/phrase results, ownership,
ties and restore without physical cleanup. Cleanup touches only compatible test
generation indexes. CI/harness wiring includes it when both test services exist;
adding that wiring does not claim a successful CI run.

- [x] Authenticated typed endpoint and safe private adapter integration.
- [x] Full SQL filter/scope authorization and canonical revalidation.
- [x] Deterministic bounded first-page ranking and explicit coverage.
- [x] Controlled failures, resource limits and model independence.
- [x] Local SQL/parser/HTTP/unit/build regression evidence.
- [ ] Live ES and full Compose backend workflow acceptance.
- [ ] Final reviewed CI evidence.

T06 is not marked fully accepted while live gates remain outstanding. Cursor/window
pagination is deliberately T07 work, not a completed T06 capability. Frontend,
autocomplete, advanced highlights/source routes, hybrid/vector retrieval, RAG changes,
OCR and historical backfill remain excluded.

Next: **T07 — Hybrid candidates, document fusion and bounded result windows**.
Objective: **combine authorized lexical and existing semantic results predictably**,
including approved keyword continuation, fixed windows, page reauthorization and
strict failure behavior. T04–T06 live acceptance remains a required release gate.
