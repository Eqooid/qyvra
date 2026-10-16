# Phase 5 T08 - Safe highlights, private autocomplete and lexical source navigation

Status: **Implemented; local verification recorded below, live acceptance pending.**
Date: **15 October 2026**. `VERSION` remains `1.3.1`; v1.4.0 remains a target,
not a release. No migrations, dependencies, new services or frontend changes.

[Approved scope](phase-5-search.md#t08--safe-highlights-private-autocomplete-and-lexical-source-navigation) |
[T06](phase-5-keyword-search.md) | [T07](phase-5-hybrid-search.md) |
[ADR-007](decisions/ADR-007-rebuildable-keyword-search.md) | [API](api.md)

## Safe lexical evidence

Keyword and hybrid lexical matches keep `snippet`, `matchedFields`, page/extraction
and offset fields. Add optional `ranges`, `segments`, `field`, `segmentId` and
`source` metadata. No document fusion, source score, per-leg budget, representative
match cap or cached rank changes. Semantic-only chunk matches retain their existing
provenance and do not gain fabricated lexical marks.

The private ES adapter requests unified highlights for approved metadata fields
(title/description/issuer/reference/filename) or page text. Each field permits one
fragment, requested size 200, with controlled random 128-bit marker pairs and the
default text encoder. No HTML encoder or client-provided tags/DSL. Decode only those
exact markers; reject unbalanced/nested/empty marks, oversized fragments, more than
32 marks or markers splitting surrogate pairs. At most one 800-scalar/2400-unit
fragment per approved field is retained internally. Raw highlight structures never
become API responses.

After authoritative SQL tuple/revision/hash/manifest hydration, align the entire
unmarked fragment **uniquely and exactly** with its canonical field/page segment.
Convert validated UTF-16 boundaries into Unicode scalar positions. Repeated or
changed fragments and malformed ranges are discarded. There is no inference that
ES highlights prove the complete boolean query. Invalid/absent hints produce the
existing plain canonical snippet, empty ranges and an unmarked text segment.

The chosen canonical excerpt is at most 400 Unicode scalars. `ranges` use zero-based
half-open scalar offsets **relative to snippet**, sorted, nonoverlapping and bounded
by snippet length (<=32 ranges). `segments` partition exactly that snippet into
`{text,matched}` pieces (<=65). Page `startOffset/endOffset` remain absolute scalar
positions in the immutable extraction; metadata offsets, when present, refer to
`field`. Combining accents count separately; offsets are not graphemes or UTF-16
code units. Literal scripts, HTML and marker-looking PDF content remain plain text.
Consumers must render text/escaped React children and `<mark>` from matched flags,
never `dangerouslySetInnerHTML` or untrusted highlight markup.

```json
{
  "kind": "page",
  "snippet": "First page",
  "field": "text",
  "ranges": [{ "start": 0, "end": 5 }],
  "segments": [
    { "text": "First", "matched": true },
    { "text": " page", "matched": false }
  ]
}
```

Primary candidate queries still reject failed shards, timed-out/partial results
and invalid candidate contracts. Malformed optional hints alone do not fail search.
A server/transport contract or capacity error with highlighting allows **one**
otherwise-identical plain search attempt, with all authorization filters retained.
No timeout/outage/auth retry loop or fabricated empty success is introduced.

T07 stores no highlights, snippets or queries in Redis. Initial hints remain
request-local. Continuation can fetch hints for at most the selected page's 60
lexical references using mandatory owner/scopes plus exact record IDs, before the
final SQL snapshot. Its optional total deadline is min(1000 ms, ES timeout).
Hint failure returns plain evidence; PostgreSQL authorization failures still fail
closed, and lifecycle/generation checks remain authoritative. These read-only hint
queries do not refill, rescore or reorder the fixed window. Final hydration
reauthorizes canonical sources again after any remote call.

## Private autocomplete

`POST /api/v1/search/suggestions` uses existing session, Origin and
`X-CSRF-Protection: 1` guards and no-store response envelopes. It is enabled by
`KEYWORD_SEARCH_ENABLED`, independently of AI/hybrid/embedding providers.

```json
{ "prefix": "Ren", "limit": 5, "filters": { "mimeType": "application/pdf" } }
```

| Request             | Contract                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| prefix              | NFC/trimmed plain text, 2-200 UTF-16 units, at least one Unicode letter/number; shared <=64 word-run complexity bound |
| limit               | Integer 1-10, default 5                                                                                               |
| filters/documentIds | Same strict owned current-version metadata filters and explicit document narrowing as T06                             |
| other fields        | Reject query/DSL/index/model/cursor/owner and unknown options; no suggestion pagination                               |

Returns `{suggestions:[{text,type,documentId,documentVersionId}]}` where type is
`title`, `referenceNumber` or `issuer`. Text is canonical SQL content, safely clipped
to <=200 UTF-16 units at scalar boundaries, without control characters or malformed
surrogates. It is plain JSON text, not HTML. Deduplicate by NFKC/lowercase text after
authorization, using engine order and fixed field priority title/reference/issuer.
No scores, totals, filenames, body terms or global vocabulary are returned.

Use the existing private adapter, current SERVING generation, mandatory user and
exact verified projection/version/revision scopes. Raw metadata candidates are
bounded by min(50, configured lexical cap); output is <=10. SQL applies all filters
before selection and revalidates current ownership/lifecycle/hash/publication
before returning any suggestion. Canonical token-prefix validation excludes
unapproved fields and stale/forged indexed text. It is a conservative presentation
guard, not a claim of perfect cross-language analyzer equivalence.

T04's frozen `suggestText` mapping also includes filenames. T08 therefore uses
structured `multi_match`/`bool_prefix` directly over title/issuer/reference fields,
not that combined field. No mapping fingerprint change or silent schema rewrite.
No wildcard/regex DSL, terms aggregation, completion dictionary, query-history
persistence or suggestion cache is added. Rebuild/analyzer tuning belongs to later
operational/relevance work. Existing query deadlines and keyword shared admission
budgets apply. Disabled/missing/unavailable or incompatible ES is 503, deadline 504,
invalid input/scope 400, inaccessible explicit documents 404, admission 429; SQL
uncertainty uses the existing sanitized 500 envelope. Outages are not empty results.

## Exact lexical source navigation

Page matches include a stable source reference with document/version/extraction IDs,
one-based page, zero-based segment, `sourceId` and same-origin authenticated `href`.
The immutable source ID is `{extractionId}:page:{page}:segment:{segment}`. `segmentId`
also identifies the specific projection page record. IDs are references, **not
bearer authorization tokens**; no index URLs, storage keys or public document links.

`GET /api/v1/documents/{documentId}/versions/{versionId}/extractions/{extractionId}/pages/{pageNumber}/segments/{segment}`

Uses the existing session guard and GET source conventions. Reject request body or
query parameters, invalid UUIDs, nondecimal integers, page outside 1-10000 or segment
outside 0-10000 with 400. Foreign/missing/unpublished/ineligible tuples share 404.
The service performs one bounded SQL read; no ES, filesystem or model access.

SQL binds parent ownership, active/nondeleted/non-DELETING lifecycle, exact immutable
PDF version and canonical extraction source checksum. It verifies exact page spans
and segment identity against a previously verified lexical publication's expected
record manifest. That projection must retain metadata readiness, READY text coverage,
verification timestamp/hash, a READY/REMOVAL_PENDING/REMOVED status and a
SERVING/RETIRED generation. Unpublished AI-only extractions cannot create lexical
navigation merely by knowing their IDs.

Return canonical IDs, historical version number/filename, current owned document
title, page/segment, plain `excerpt`, UTF-8 SHA-256 `excerptHash`, absolute scalar
`startOffset/endOffset` and nullable next/previous segment integers. Read at most
8192 scalars (<=16384 UTF-16 units) per segment, deterministically relative to the
page's canonical start. Empty/missing/out-of-range segments return 404. Large pages
use bounded segment reads, not unrestricted extraction export.

**Historical policy is the specific approved T01 decision:** new search/autocomplete
only discovers current eligible publications, while an already issued exact source
can resolve retained historical canonical text, matching `CitationSourceService`.
Version replacement or generation retirement alone is not access revocation for
that retained source. Archive, deletion, ownership/access loss or loss of retained
verified provenance invalidates navigation immediately at the SQL read. No assertion
that old content is current, physically indexed, or still downloadable is made.
T10 retention/cleanup must preserve the provenance required for retained reads or
make unavailable references return 404. No PDF viewer/preview redesign or historical
binary download endpoint is introduced; current-file download remains unchanged.

## Bounds, security and compatibility

All engine queries retain trusted `users.id` filters; PostgreSQL remains the only
authorization authority. Qyvra currently uses private-user vaults rather than a
separate tenant ACL model. No unauthorized counts, metadata, highlights or source
content may reach output. SQL failure never falls back to cached/remote ownership.
There are no source or suggestion caches, new migrations, queues, frameworks,
providers, dependencies or worker/enrollment changes. Existing public semantic/RAG
and download/version/source contracts remain intact.

Structured optional-enrichment warnings contain failure category only, never query,
PDF text, cursor, marker key, credentials or raw infrastructure exceptions. Existing
request timing/admission and T07 events remain. No live quality/latency/throughput
claim is inferred from mocks or unit tests.

## Verification and remaining gates

Executed locally with Node 24.9.0 and native PostgreSQL 17, disposable database
`qyvra_phase5_t08_test` on loopback 55435. No production resources were used.

| Actual command/check                                                                                                                                                               | Result                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| API `npm.cmd run lint`, `format:check`, `typecheck`, `build`                                                                                                                       | PASS in final rerun, including shared storage/database and worker builds                                                      |
| API `node node_modules/jest/bin/jest.js --runInBand`                                                                                                                               | PASS: 693 tests, 2 skipped, 56 suites; later prefix/Unicode refinements passed focused checks below                           |
| Final focused selector `(keyword-search.service\|safe-highlights\|lexical-source.service\|elasticsearch-store\|hybrid-search.service).spec.ts$`                                    | PASS: 122 tests, 5 suites                                                                                                     |
| Full HTTP `--config test/jest-e2e.json --runInBand --silent`                                                                                                                       | PASS: 299 tests, 16 suites; service/SQL doubles are not live backend E2E                                                      |
| Final keyword/suggestions/source HTTP focused rerun                                                                                                                                | PASS: 18 tests                                                                                                                |
| Native SQL integration selector `(keyword-search\|search-publication\|search-contracts\|search-enrollment\|pdf-extraction\|ai-processing\|documents\|outbox).integration-spec.ts$` | PASS: 80 tests, 4 skipped, 8 suites; real parser/SQL/publications/session/source reads, ES/provider doubles in ordinary cases |
| Fresh disposable `npm.cmd --prefix packages/database run migrate:deploy`                                                                                                           | PASS: all 17 existing migrations; no T08 migration                                                                            |
| `node --test infrastructure/test/search-compose.test.cjs`                                                                                                                          | PASS: one private topology contract                                                                                           |
| Compose `config --quiet` with explicit synthetic configuration-only secret paths; runtime harness syntax                                                                           | PASS, no containers started                                                                                                   |
| Docker `info`                                                                                                                                                                      | BLOCKED: Docker engine named pipe missing                                                                                     |
| Real ES highlight/private-prefix case                                                                                                                                              | SKIPPED without TEST_ELASTICSEARCH_URL; no live highlight/analyzer/quality claim                                              |

An initial negative source fixture tried to mutate a verified manifest and was
correctly rejected by its immutability guard. The fixture now creates a separate
unpublished extraction. Its Prisma JSON input typing and a test-formatting issue
were fixed, and the final SQL/type/lint/format reruns passed. No database guard
was weakened and no unrelated failure is hidden.

The full unit run includes existing OpenAI/Ollama, RAG, worker, messaging, lifecycle
and download/version regressions; provider fixtures are not live model inference.
Native coverage includes foreign suggestions, hash drift, archives/deletion, exact
page offsets, invalid pages/segments, unverified extraction rejection, historical
version/retired-generation policy and real SQL session-authenticated source HTTP.

Use disposable migrated
`TEST_DATABASE_URL` only. Native SQL/parser tests are distinguished from simulated
ES/query providers. The opt-in real ES case now checks actual highlight ranges and
private prefix queries when `TEST_ELASTICSEARCH_URL` is supplied; it has not run
without that service. Docker engine is unavailable in this session, so live
ES/Qdrant/Redis/broker/model-backed Compose/browser workflows and remote CI are
not verified. No local test stands in for those acceptance gates.

- [x] Typed safe lexical evidence and unchanged document fusion/window ranking.
- [x] Private bounded suggestions with current SQL publication authorization.
- [x] Exact bounded canonical page reads and explicit historical-source policy.
- [ ] Applicable live ES/highlight/prefix and complete Compose workflow acceptance.
- [ ] Final reviewed CI/release evidence. T08 is not marked fully accepted.

Next: **T09 - Search frontend and browser source workflows**.
Objective: **provide usable Keyword/Hybrid modes without disrupting the catalog/Q&A**.
Frontend, private suggestion UI, PDF viewer work, advanced semantic highlighting,
OCR, hybrid RAG answers and T10 backfill/rebuild/physical cleanup remain deferred.
