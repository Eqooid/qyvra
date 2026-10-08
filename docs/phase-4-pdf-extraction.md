# Phase 4 T04 — durable PDF text extraction

**PDF text extraction: Implemented.** [T05 deterministic chunks and citation provenance](phase-4-chunk-generation.md)
are now implemented; the T04 completion record below preserves its original checkpoint.
[T06 embeddings/checkpoints](phase-4-embedding-generation.md) and
[T07 Qdrant indexing/activation/cleanup](phase-4-vector-indexing.md) are implemented.
OCR remains **Planned**. [T08 opt-in upload enrollment](phase-4-ingestion.md),
[T09 semantic retrieval](phase-4-semantic-search.md) and [T10 grounded RAG](phase-4-rag-answers.md)
are implemented. At the original T04 checkpoint uploads scheduled integrity only;
T08 now enrolls eligible versions asynchronously when enabled. Internal explicit AI runs
using the extractor snapshot below can now execute `EXTRACT_TEXT` in the existing
worker. No extraction HTTP endpoint, separate queue or job system is introduced.

[Architecture](phase-4-ai-rag.md) | [Data](phase-4-data-foundation.md) |
[Durable orchestration](phase-4-processing.md) | [Roadmap](roadmap.md)

## Dependency and execution boundary

The exact dependency is Mozilla `pdfjs-dist@6.4.299` (Apache-2.0), using its
Node-compatible `legacy/build/pdf.mjs` text APIs directly. The modern build uses
typed-array methods missing from the existing Node 24.9 host; Mozilla's legacy
build supplies those compatibility shims. There is no browser, rendering, OCR,
canvas requirement, AI framework or provider SDK. Its optional canvas package is
not used for text extraction and native addons are denied in the parser process.
The [upstream release](https://github.com/mozilla/pdf.js/releases/tag/v6.4.299)
contains the fixes predating this pinned release; the
[viewer scripting advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)
also motivates using text APIs without a viewer or scripting. Pin upgrades together
with the extraction identity and fixture review.

`PdfTextExtractionHandler` depends on Qyvra's `Storage` and `PdfParser` interfaces.
`IsolatedPdfParser` starts one short-lived trusted Node subprocess with `spawn`,
fixed executable/module paths and numeric validated arguments, never a shell or a
document-controlled path. Original bytes enter over stdin; one bounded JSON result
returns over stdout. No temporary PDF file is created. Parser diagnostics are
discarded, not logged or persisted. The child inherits no environment credentials.

Linux's compiled `pdf-parser-guard` applies a CPU rlimit, `no_new_privs`, and seccomp
denying socket/socketpair creation (including alternate ABI bypass). Node permissions
permit reads of only parser code and the PDF.js package; writes, subprocess creation,
native addons and worker threads are denied. The parser additionally disables network
entry points, eval, font loading, WASM, image decoding and worker fetching. It receives
only bytes, never a URL. PDF JavaScript, attachments, annotations/actions and remote
resources are never executed or requested. Text reading uses PDF.js's in-process fake
worker within the isolated child, not another Qyvra processing runtime.

Production extraction requires Linux; non-Linux production worker configuration
fails at startup. Windows development/tests use Node permissions and disabled network
APIs, without claiming equivalent kernel network isolation. Linux host development
requires GCC/libc headers and `npm --prefix apps/api run pdf:sandbox:build`; copy the
built launcher into `dist/infrastructure/extraction/` for a host production build.
Docker builds the launcher in a compiler stage and copies only its executable into
the unprivileged runtime. A missing/failed sandbox is a sanitized infrastructure
failure, never an unsandboxed fallback.

## Canonical representation and provenance

The immutable run snapshot is `extractor=pdfjs`,
`extractorVersion=6.4.299-qyvra-layout-v1`, `normalizationVersion=nfc-lf-v1`.
The layout version is part of extractor identity; parser or layout/normalization
changes require a new snapshot, fingerprint and intentional run generation.

Pages are read sequentially, one-based, in PDF.js content-stream item order. Text
items use their supplied `hasEOL`; adjacent items without an end-of-line get a space.
This is deterministic text extraction, not a visual reading-order reconstruction.
Each page replaces malformed surrogate sequences with U+FFFD, normalizes Unicode
NFC, converts CRLF/CR and Unicode line/paragraph separators to LF, removes C0/C1 controls except LF/tab, collapses tabs and
Unicode space separators to one space, trims line edges and page edges, and preserves
internal line breaks, then reapplies NFC after removals. Pages join with exactly two LF characters. No wording, hyphens,
headers or repeated content are semantically rewritten or deduplicated.

`text` is canonical UTF-8 PostgreSQL text. `characterCount` and each half-open
`pageSpans` boundary count Unicode scalars, **not UTF-16 units or bytes**. Page spans
exclude the two-LF separators; empty pages retain zero-length spans, including
leading/trailing pages. `pageCount` is the parser's actual count. The original
upload's immutable page-count metadata is not overwritten. Future chunks must use
these offsets and original page numbers rather than guessing page locations.

`contentHash` is SHA-256 of canonical UTF-8 including separators. The extraction
fingerprint is SHA-256 of UTF-8 `JSON.stringify(["qyvra.extraction.v1", sourceChecksum,
extractor, extractorVersion, normalizationVersion])` in that exact order.
Operational limits do not change text identity. Successful artifacts record all
T02 provenance fields and creation time; source ownership comes from PostgreSQL.

## Durable lifecycle, publication and retries

The handler validates the claimed job/token/attempt, owned exact version, current
desired building run, highest version, active document, and completed exact-version
`VERIFY_STORED_FILE` predecessor before reading. MIME must be authoritative
`application/pdf`, the key must belong to the owned original prefix, and bytes must
start `%PDF-`. The bounded storage read rechecks size and SHA-256 to detect changes
after verification. PDF extension alone never establishes eligibility.

Parsing/storage IO occur outside database transactions. The returned `StageCommit`
publishes the immutable unique `(documentVersionId, extractionFingerprint)` artifact
and `extractionStatus=COMPLETED` inside T03's document-lock, lease and desired-run
fence. The same transaction completes the job and schedules one `GENERATE_CHUNKS`
job/outbox intent. Callback failure or stale ownership/lifecycle/lease rolls back all
publication. No chunks are generated by T04. Chunk execution remains unavailable
until T05; delivering that stage now produces `HANDLER_NOT_IMPLEMENTED` safely.

Duplicate delivery uses existing claims; duplicate completion skips the callback.
Intentional compatible reprocessing reuses the immutable artifact without storage
or parser work, after validating its identity and current content/page limits.
Concurrent completion cannot produce multiple artifacts or successors. Crashes before
publication retry through PostgreSQL leases; crashes after commit recover the completed
job and outbox. Redis contributes only a best-effort FINALIZING observation, never
completion authority. Logs contain IDs, snapshot, duration, attempt and counts, not text.

The compatibility summary is PENDING at scheduling/retry, PROCESSING on claim,
COMPLETED on artifact publication, UNSUPPORTED for unsupported/no-text/encrypted
outcomes, FAILED for other terminal outcomes. Only eligible extraction jobs change
it; full job/run history remains authoritative. Existing string DTOs/schema already
accept these values, so no migration or API shape change is needed.

| Outcome                                                                          | Durable behavior                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `UNSUPPORTED_FORMAT`                                                             | Non-PDF terminal; no read by extraction, no artifact/chunks.                                              |
| `OCR_REQUIRED`                                                                   | All-whitespace/no-text, empty/graphics/scanned PDF terminal; no artifact/chunks. OCR Planned.             |
| `PDF_ENCRYPTED`                                                                  | Password-required or encryption with empty password terminal; no guessing or password input.              |
| `PDF_MALFORMED`, integrity/metadata failure, missing original                    | Terminal sanitized failure; no partial publication.                                                       |
| `EXTRACTION_LIMIT_EXCEEDED`, `EXTRACTION_TIMEOUT`, `PDF_PARSER_RESOURCE_FAILURE` | Deterministic configured resource failure; terminal rather than repeating expensive work.                 |
| `STORAGE_READ_FAILED`, preparation timeout, parser unavailable/protocol failure  | Existing bounded PostgreSQL retry/backoff; exhaustion fails run.                                          |
| Database outage / worker interruption                                            | Existing worker delivery retry or expired-lease recovery; successful content and successor remain atomic. |

Original viewing/downloading remains independent of extraction failure. Archive,
soft deletion, purge or supersession invalidates publication through T03's existing
lifecycle fence; AI artifacts cannot delete authoritative originals.

## Configuration and deployment limits

| Setting                         | Default                     | Valid maximum / meaning                                                                                         |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PDF_EXTRACTION_MAX_BYTES`      | `UPLOAD_MAX_BYTES` (50 MiB) | 200 MiB; complete input and streamed read bounded.                                                              |
| `PDF_EXTRACTION_MAX_PAGES`      | `UPLOAD_MAX_PAGES` (500)    | 2,000.                                                                                                          |
| `PDF_EXTRACTION_MAX_CHARACTERS` | 5,000,000                   | 5,000,000 Unicode scalars.                                                                                      |
| `PDF_EXTRACTION_MAX_TEXT_BYTES` | 20,000,000                  | 20,000,000 canonical UTF-8 bytes.                                                                               |
| `PDF_EXTRACTION_TIMEOUT_MS`     | min(30,000, half job lease) | At most 75% of job lease; shared storage/parser budget, leaving publication headroom.                           |
| `PDF_EXTRACTION_HEAP_MB`        | 256                         | 1–1,024 MiB Node old-space per child; total RSS is bounded separately.                                          |
| `WORKER_MEMORY_LIMIT`           | `2g`                        | Compose worker aggregate cgroup memory; size with prefetch, database/client buffers and parser heap/native RSS. |

Intermediate text is bounded before normalization (including item separators), so
pathological whitespace can hit limits before the canonical representation does.
Stdout, file buffers, page count, parser wall time and CPU are independently bounded.
The bounded file is buffered for PDF.js random access; this is not arbitrary-size
streaming. Container OOM/restart leaves durable claims recoverable. No temporary disk
capacity is required for extraction, although existing upload inspection still uses it.
Deploy other schedulers with equivalent cgroup memory limits. Linux host execution
also needs an explicit service memory limit; Node's heap cap is not an RSS guarantee.

## Verification and limitations

Small committed fixtures cover single/multiple/empty pages, graphics-only and image-only, malformed,
encrypted (including empty password), and embedded JavaScript. `generate.cjs` documents
fixture construction and optional qpdf encryption; it is test-only. Parser tests
exercise Unicode normalization and all configured input/output limits. PostgreSQL
integration exercises real parser/storage-boundary processing, atomic publication,
duplicate delivery, artifact reuse, retry, lifecycle races and deletion provenance.
The completion record will report executed commands and production-container evidence.

Reading order in complex columns/tables, missing embedded fonts, unusual encodings,
and inaccurate source text mappings remain PDF limitations; no extraction-quality
claim beyond text-bearing fixtures is made. The image-only fixture verifies the
no-text path for scans; OCR and a broad real-world corpus evaluation remain future work.
Only whitespace-only content is classified no-text; short genuine text is retained.
No change to T01–T03 architecture or persistence model is required. T05 should implement
deterministic chunk sets/IDs, exact scalar offsets and page provenance using this artifact.

## T04 completion record — 4 October 2026

T04 is implemented and verified. No new migration, table, HTTP endpoint, queue or
provider integration was added. Previous T01–T03 working-tree changes and release
snapshots were preserved. The only architectural concretizations are the pinned
parser/layout identity, canonical whitespace rules, Linux production isolation and
operational ceilings described above. Automatic AI upload wiring remains T08.

Created for T04:

- `apps/api/src/infrastructure/extraction/canonical-text.mjs`
- `apps/api/src/infrastructure/extraction/pdf-parser.mjs`
- `apps/api/src/infrastructure/extraction/pdf-parser.ts`
- `apps/api/src/infrastructure/extraction/pdf-parser.spec.ts`
- `apps/api/src/infrastructure/extraction/pdf-parser-guard.c`
- `apps/api/src/infrastructure/worker/pdf-text-extraction.handler.ts`
- `apps/api/scripts/build-pdf-sandbox.cjs`
- `apps/api/test/pdf-extraction.integration-spec.ts`
- `apps/api/test/pdf-container-smoke.cjs`
- `apps/api/test/pdf-sandbox-probe.cjs`
- `apps/api/test/fixtures/pdf/generate.cjs` and nine fixtures: `single.pdf`,
  `multi.pdf`, `empty.pdf`, `graphics.pdf`, `image-only.pdf`, `script.pdf`,
  `malformed.pdf`, `encrypted.pdf`, `encrypted-empty-password.pdf`
- `docs/phase-4-pdf-extraction.md`

Modified for T04 (some already contain earlier Phase 4 work):

- `.env.example`, `.gitignore`, `README.md`, `docker-compose.yml`
- `apps/api/package.json`, `apps/api/package-lock.json`, `apps/api/nest-cli.json`
- `apps/api/src/configuration/settings.ts`, `environment.ts`, `environment.spec.ts`,
  `configuration.module.ts`
- `apps/api/src/infrastructure/worker/worker.module.ts`
- `apps/api/test/worker.integration-spec.ts` (real handler registration and startup
  diagnostics without process exit; existing assertions retained)
- `packages/database/src/processing-repository.ts`, `processing-pipeline.ts`
  (atomic extraction compatibility-summary updates only)
- `infrastructure/docker/api.Dockerfile`
- `docs/README.md`, `api.md`, `architecture.md`, `database.md`, `roadmap.md`,
  `specification.md`, `compose.md`, `deployment/environment-variables.md`,
  `phase-4-ai-rag.md`, `phase-4-data-foundation.md`, `phase-4-processing.md`

Executed verification (npm commands use the existing independent package roots):

| Command / check                                                                                                                          | Result                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm --prefix apps/api install --save-exact pdfjs-dist@6.4.299 --ignore-scripts`                                                         | Success; one direct dependency, optional canvas transitive packages.                                                                                                                                                                          |
| `npm --prefix apps/api run build`                                                                                                        | Success, including storage/database generation/build and Nest asset copies.                                                                                                                                                                   |
| API `npm run lint`, `tsc --noEmit --incremental false`, `npm run format:check`                                                           | Passed.                                                                                                                                                                                                                                       |
| Database `npm run lint`, affected-file Prettier                                                                                          | Passed.                                                                                                                                                                                                                                       |
| API `jest --runInBand`                                                                                                                   | 29 suites, 271 passed, one pre-existing skipped test; final expanded parser focus subsequently passed all 14 cases.                                                                                                                           |
| API `jest --config test/jest-e2e.json --runInBand` with qpdf                                                                             | 15 suites, 281 passed.                                                                                                                                                                                                                        |
| API `jest --config test/jest-integration.json --runInBand` with isolated PostgreSQL/RabbitMQ/Redis                                       | 22 suites, 164 passed, zero skips. Final extraction focus subsequently passed all 16 cases, including actual image-only PDF and duplicate v2 live transport.                                                                                  |
| Database `npm run test:pipeline` with PostgreSQL                                                                                         | 27 passed: dependencies, transactional rollback, concurrency, expired leases, retries, reconciliation, lifecycle and Phase 3 persistence.                                                                                                     |
| Database `npm run migrate:deploy` on fresh `qyvra_t04_api_test`                                                                          | All 14 existing migrations applied successfully; no T04 schema change.                                                                                                                                                                        |
| `docker build --target runtime -f infrastructure/docker/api.Dockerfile -t qyvra-t04-worker-test .`                                       | Final image built; C launcher compiled with `-Wall -Wextra -Werror`; compiler absent from runtime.                                                                                                                                            |
| `docker run --rm --network none --memory 1g --mount <read-only test directory> qyvra-t04-worker-test node /test/pdf-container-smoke.cjs` | Nine real fixtures passed as UID 1000; kernel socket denial and Node read/write/child-process denial probes passed.                                                                                                                           |
| `docker compose config --quiet`                                                                                                          | Passed.                                                                                                                                                                                                                                       |
| Changed Markdown formatting / internal-link check / `git diff --check`                                                                   | Passed; 203 internal paths/anchors checked.                                                                                                                                                                                                   |
| `npm --prefix apps/api audit --json`                                                                                                     | Exit 1 for 50 pre-existing package findings (3 low, 11 moderate, 36 high); every reported package exists in the previous lockfile. No finding names PDF.js or its added optional canvas packages. No unrelated dependency upgrades attempted. |

The initial modern PDF.js build failed on the host's missing `Uint8Array.toHex`;
switching to the upstream Node-compatible legacy build fixed it. Two initial fixture
seeds violated existing MIME/archive SQL checks; fixture metadata was corrected,
not the checks. The first live worker test invocation omitted the worker's required
`DATABASE_URL`; the full live run passed after setting it alongside `TEST_DATABASE_URL`.
Docker initially lacked its engine pipe; starting Desktop enabled both image and live
broker/cache verification. No infrastructure verification remains blocked.

Passing broad suites were not repeatedly run after test-only fixture additions;
the affected parser/extraction cases and final lint/type/format checks were rerun.
Unrelated frontend/browser suites were not run because T04 changes no frontend.
Existing dependency findings, ARM64 sandbox acceptance (only x86_64 tested), complex
PDF reading order and broader corpus quality remain risks for release acceptance.
T05 was not started.
