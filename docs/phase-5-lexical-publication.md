# Phase 5 T05 — Model-independent PDF text and verified lexical publication

Status: **Implemented and locally verified; live acceptance pending.**
Verification date: **14 October 2026**, uncommitted working tree including T01–T04.
`VERSION` remains `1.3.1`; Phase 5 is not released. The approved
[T01 plan](phase-5-search.md#t05--model-independent-pdf-text-and-verified-lexical-publication),
[T02 schema/contracts](phase-5-data-foundation.md),
[T03 fencing](phase-5-search-enrollment.md) and
[T04 private adapter](phase-5-elasticsearch.md) remain the governing contracts.

## Worker and persistence boundaries

`SearchIndexHandler` implements `INDEX_SEARCH`; `SearchTextExtractionHandler`
implements `EXTRACT_SEARCH_TEXT`. Both register in the existing independent
`WorkerModule` and consume identifier-only v3 contracts through the existing
consumer, claim, lease, retry and completion machinery. The production relay now
advertises those two implemented capabilities. `REMOVE_SEARCH_INDEX` remains
durably held: T10 owns operational cleanup/reconciliation. No placeholder handler
completes removal work.

Deploy matching worker handlers **before** enabling the new relay capabilities
and enrollment. Older workers cannot consume active v3 search work safely. Keep
`SEARCH_ENROLLMENT_ENABLED=false` until a compatible non-retired SQL generation is
provisioned and the private Elasticsearch configuration is verified. API/worker
need T04 runtime credentials; the relay needs none. No network calls occur inside
SQL transactions. Optional index outages leave ordinary document APIs independent.

`packages/database/src/search-processing.ts` adds an explicit search branch,
separate from the AI single-successor map. Metadata publication is independent of
file verification. For PDFs, its completed `INDEX_SEARCH` job schedules extraction
only after the latest owned `VERIFY_STORED_FILE` job completes. Integrity completion
also resumes this branch when metadata finished first. Existing bounded enrollment
reconciliation repairs a missing branch after completed metadata; it does not scan
historical unenrolled documents or reset exhausted work.

Extraction completion atomically records the canonical artifact on its job,
advances the desired revision, revokes the old pointer, retires the previous
projection, creates a complete replacement BUILDING projection referencing that
artifact, and schedules another INDEX_SEARCH job plus outbox. This is necessary
because SQL forbids altering a published manifest. An extraction/integrity terminal
failure instead creates a metadata-only replacement with explicit FAILED or
UNSUPPORTED coverage. Metadata becomes available again after that replacement is
verified; there can be a temporary gap while its new revision builds.

The existing 17 migrations, composite ownership keys, per-version active-job
uniqueness and revision guards suffice. **T05 introduces no table, index or migration**
and edits no historical migration. A manifest checkpoint now supports INDEX_SEARCH
under the existing leased SQL repository.

## Shared PDF extraction

`infrastructure/extraction/pdf-extraction.ts` shares bounded storage reading,
immutable checksum verification, parser invocation, cache lookup and artifact
commit between the AI and lexical entry points. The AI entry point retains all
existing desired AI-run checks. Lexical work requires no AI run, embedding profile,
tokenizer, OpenAI, Ollama, Qwen or model request.

The existing disposable PDF.js **6.4.299** parser uses extractor identity
`pdfjs / 6.4.299-qyvra-layout-v1 / nfc-lf-v1`. Production retains the Linux network/
CPU guard, Node permissions and heap limit. Stored-file keys come from the exact
owned immutable version, pass the storage validator and have its generated owned
prefix. Fresh extraction checks byte count, SHA-256 and PDF signature before parsing.
Storage open/read and parser execution have deadlines; streams and subprocesses
are destroyed on timeout. Parser diagnostics and document contents are never logged.

Existing extraction ceilings apply unchanged: configured file bytes, pages,
Unicode scalar characters, UTF-8 text bytes, heap and elapsed time. Default ceilings
are 50 MiB input, 500 pages, 5,000,000 scalars, 20,000,000 text bytes, 256 MiB parser
heap and 30 seconds extraction time. Worker/container limits bound aggregate work;
the dedicated worker's prefetch remains the concurrency control.

Normalization remains NFC, well-formed Unicode, LF, normalized horizontal space,
trimmed lines and removal of unsafe controls. Canonical pages are separated by two
LF characters, including blank pages; offsets count Unicode scalars. Empty,
image-only and scanned PDFs return the existing explicit `OCR_REQUIRED` outcome.
Encrypted PDFs are unsupported; malformed PDFs fail. No OCR is introduced, and
textless documents never receive READY text coverage.

The extraction fingerprint includes immutable checksum and extractor/normalization
identity. A matching owned artifact is reused without opening storage or invoking
the parser again. Reuse validates provenance, limits, scalar count and content hash.
AI/search commits use native conflict-ignoring insert followed by immutable artifact
comparison (text, hash, counts and canonical page spans). Concurrent preparation
converges on one ID; conflicting output never overwrites the winner.

## Deterministic lexical representation

T04's strict schema and physical generation names are unchanged. Each projection
contains one metadata record and, for text coverage, deterministic page segments.
`lexical-projection.ts` splits each nonempty page at **8,192 Unicode scalar**
boundaries without overlap, tokenizer limits or embedding chunk identities. Blank
segments produce no invented text. Canonical offsets/page numbers remain intact.
The manifest is capped at 10,000 records, also enforced in SQL.

IDs remain `<projection UUID>:metadata` and
`<projection UUID>:page:<page number>:<zero-based segment>`. Ownership, document,
immutable version, revision and generation fields bind every record. Metadata uses
the SQL metadata hash; pages use the canonical extraction content hash. Sorted tag
IDs, deterministic record order and recursively sorted JSON keys produce the
SHA-256 `recordsHash`. The same revision and canonical content produce identical
writes on retry. Bulk batches account for both record count and actual UTF-8
action/source bytes, including normalized exact-reference fields.

## Verified publication and fencing

1. Load the leased job and trusted document/version/projection/generation lineage.
2. Build and validate records against T04 contracts. Under the document lock and
   current lease, persist exact expected IDs/count/hash **before any remote write**.
   These identifiers retain cleanup intent even after a partial publication.
3. Outside SQL, inspect/create only compatible missing private indexes, then write
   deterministic bounded batches with `refresh=wait_for`. Inspect every bulk item;
   partial errors and uncertain outcomes do not establish successful publication.
4. `LexicalStore.verifyPublication` uses actual search, rather than realtime mget.
   Exact owner/generation/document/version/projection/revision filters accompany
   every request. Verify exact total cardinality in both indexes (including zero
   pages), then bounded ID batches with exact source comparison. Missing/extra IDs,
   modified text or metadata, approximate totals, failed shards, timeout and foreign
   lineage fail closed. No raw user DSL enters this boundary.
5. Recheck the authoritative lease/lifecycle around external stages. Completion
   takes the document lock, validates current version/revision/generation/canonical
   metadata hash and lease again, checks the exact checkpoint manifest and locks/rechecks the generation row, sets verified
   READY, and installs the pointer only for a SERVING generation. Job completion
   and branch scheduling commit in that same short transaction.

Elasticsearch documents cannot roll back with SQL. The SQL ready pointer is the
visibility/authorization gate; physical writes alone never authorize results.
Archive, deletion, replacement, organization changes and generation retirement
make old work ineligible. A worker observing this persists CANCELLED before
acknowledging obsolete v3 work. Immutable revision-specific IDs isolate late writes.
Any future T06 search must revalidate authoritative SQL ownership/current revision/
metadata hash, not trust indexed ownership fields or READY alone.

`refresh=wait_for` waits for search visibility; a successful bulk HTTP response or
realtime mget alone is not the protocol. See the
[official refresh semantics](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/refresh-parameter)
and [search total-hit contracts](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-search).

## Outcomes, status and recovery

Transport errors keep T04 sanitized SEARCH_* categories. Unavailability, timeout,
rate limit and capacity use bounded PostgreSQL backoff/retry; incompatible schema,
credentials and malformed contracts are terminal. Missing/corrupted immutable
originals and malformed/encrypted PDFs retain existing extraction failure codes.
Parser/storage transient failures retry within existing limits. Exhaustion is
observable, not silently rescheduled forever. Failed index jobs mark their
unpublished BUILDING projection FAILED while retaining its exact remote manifest.

After a crash or uncertain write, the existing interrupted-lease and retry/outbox
recovery republishes deterministic IDs and verifies the complete projection again.
SQL commit failure leaves no READY pointer. Duplicate delivery after completion
acknowledges the existing outcome; competing live claims perform one logical build.
Redis remains disposable. Existing progress stages PREPARING, EXTRACTING, INDEXING,
VERIFYING and FINALIZING describe the lexical stages without adding a status route.

The existing owned processing response has an additive optional `search` object:
`metadataReady`, `textCoverage`, `projectionStatus`. It is returned for enabled,
eligible current enrolled revisions only. Readiness requires the serving pointer
and current SQL metadata fence; text coverage is independent of AI readiness.
An INDEX_SEARCH completion with UNSUPPORTED/FAILED text coverage means verified
metadata only, never successful searchable PDF content.

Retired projections remain REMOVAL_PENDING and T03 reconciliation persists exact
removal jobs. **Physical Elasticsearch cleanup is not implemented or claimed here.**
Late writes may leave orphan records, and lost-index validation/reconciliation,
cleanup confirmation, operator repair/backfill and generation cutover remain T10.
Until those tasks and T06 authorization are accepted, raw Elasticsearch access
must remain private; no public search route is activated.

## Verification evidence and acceptance gate

Local commands use Node 24.9.0 and the existing independent npm packages. Native
PostgreSQL 17 ran on loopback port 55435 in an isolated trusted test cluster; the
fresh `qyvra_phase5_t05_test` database applied all 17 migrations without reset.

| Check                                                                                                                                                      | Actual result                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| API/database formatting, linting, TypeScript; shared storage/database and Nest production build                                                            | PASS. Worker/outbox share the Nest build.                                                                                                 |
| Prisma validate, fresh migrate:deploy, migrate status                                                                                                      | PASS; 17 migrations, schema up to date, no new T05 migration.                                                                             |
| Full API unit run: `node node_modules/jest/bin/jest.js --runInBand`                                                                                        | PASS: 578 passed, 1 skipped, 49 suites. Later byte-budget/status cases receive a focused rerun.                                           |
| Focused final byte-budget and lexical-status unit rerun                                                                                                    | PASS: 13 tests, 2 suites.                                                                                                                 |
| Database processing/AI/search Node suites, `--test-concurrency=1`                                                                                          | PASS: 76 tests against real PostgreSQL.                                                                                                   |
| Jest integration selection `(search-publication\|pdf-extraction\|search-enrollment\|search-contracts\|outbox\|documents\|processing).integration-spec.ts$` | PASS: 60 tests, 3 skipped, 7 suites. Includes 17 T05 SQL/parser cases; Elasticsearch transport is simulated for these.                    |
| Final T05 SQL/parser rerun: `search-publication.integration-spec.ts`                                                                                       | PASS: 20 tests, 1 live Elasticsearch test skipped. Includes generation-status publication/retirement races and owned/stale status checks. |
| HTTP E2E: `node node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand`                                                                     | PASS: 281 tests, 15 suites, SQL/storage doubles at documented boundaries. Not Compose E2E.                                                |
| `node --test infrastructure/test/search-compose.test.cjs`; runtime script syntax                                                                           | PASS: private authenticated topology and existing-service preservation. No running engine required.                                       |
| `node infrastructure/test/search-runtime.cjs`                                                                                                              | BLOCKED: Docker engine named pipe absent, before building/starting containers. No live ES/broker/container verification.                  |
| Live SQL/PDF-to-ES test and broker suites                                                                                                                  | NOT EXECUTED/SKIPPED without explicit live infrastructure configuration.                                                                  |
| Real upload→outbox→RabbitMQ→worker→ES Compose workflow, production sandbox/container resource behavior and live restart faults                             | NOT EXECUTED; acceptance remains pending.                                                                                                 |
| Remote CI                                                                                                                                                  | NOT EXECUTED; workflow configuration is not passing-run evidence.                                                                         |

The new T05 integration suite covers real parser success, blank/encrypted/malformed
PDF outcomes, independent metadata publication, AI/search preparation races,
archive during extraction, restore/delayed messages, archive/delete/version/
generation during publication, membership/hash fencing without a mutation hook,
partial writes, full-manifest retries, duplicate claims, SQL rollback and expired
lease recovery. The optional real-ES case uses isolated generation indexes and
cleans only compatible test-owned resources. The runtime harness includes it when
both TEST_DATABASE_URL and TEST_ELASTICSEARCH_URL are available. CI provisions a
disposable PostgreSQL service and builds the parser sandbox; it has not run here.

- [x] Shared model-independent extraction and immutable canonical convergence.
- [x] Real search handlers, metadata-first independent branch and versioned delivery.
- [x] Deterministic manifests, bulk interpretation, search-visibility verification.
- [x] SQL lease/lifecycle fencing, retry and partial coverage behavior.
- [x] Local automated regression and build evidence.
- [ ] Live Elasticsearch/broker/Compose PDF workflow and deployment acceptance.
- [ ] Remote CI evidence on the final reviewed change set.

T05 is **not marked fully accepted** while those live gates remain outstanding.
No dependency upgrade, new model integration, public search, frontend, OCR,
ranking/highlighting, vector/RAG behavior change or historical backfill is included.

Next: **T06 — Authorized keyword search API**. Objective: **expose current owned
lexical document results with canonical snippets**. T04/T05 live acceptance remains
an explicit prerequisite to certifying real search behavior.
