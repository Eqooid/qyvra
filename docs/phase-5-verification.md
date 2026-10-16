# Phase 5 T11 — Acceptance review and release readiness

Review date: **15 October 2026**. Decision: **NOT READY**.
T11 status: **PARTIAL**; independent source review, local checks and documentation
are recorded, but mandatory live acceptance is not complete. This is not a release.

[Approved requirements](phase-5-search.md#acceptance-criteria-and-testing-strategy) |
[Candidate scope and upgrade](releases/v1.4.0.md) |
[Developer walkthrough](developer/versions/v1.4.0.md) |
[Operator recovery](phase-5-search-operations.md)

## Reviewed state and evidence policy

Branch `v1.4.0`, base HEAD `d86395fafef3f53ebe3d182bd15936564cdb00ae`
(`update color theme`), following v1.3.1 preparation. The working tree contains
uncommitted T02–T10 code and earlier unrelated changes. The candidate is the local
working tree, **not** that base commit. No reset, commit, push, tag, publication,
production migration or deployment was performed. `VERSION` remains `1.3.1`;
the approved Phase 5 target is `1.4.0`.

Reviewed root/API/web agent instructions, T01 A01–A11 and S01–S06/R01–R02, ADRs
007–009, migrations 16–18, enrollment/processing/outbox/worker boundaries, private
adapter, keyword/semantic/hybrid authorization, evidence/source contracts, frontend
requests/state/rendering, operator maintenance and both verification workflows.
Historical release snapshots are preserved. Earlier task reports are dated
evidence, not statements that all their later tasks are still planned.

T10 results are reused where source is unchanged: 709 API unit passes/2 skips,
28 database search passes, 48 PostgreSQL/parser integration passes/3 skips, the
populated 17-to-18 migration test, fresh 18-migration application, and final
12 maintenance SQL/18 HTTP/45 focused unit passes. Counts overlap and must not be
added. T09 records 237 component/regression passes and five earlier mocked-browser
passes. Those are identified as **prior evidence**, not reruns by T11.

## T01–T10 task review

| Task                               | Acceptance status | Implementation and evidence inspected                                                                                                                                                  | Outstanding acceptance                                                              |
| ---------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| T01 scope/architecture/plan        | COMPLETE          | Roadmap, baseline audit, A01–A11, task dependencies and ADRs 007–009                                                                                                                   | Subsequent runtime acceptance is not implied                                        |
| T02 persistence/contracts          | COMPLETE          | Migrations/SQL guards, `search.ts`, `search-repository.ts`, versioned messaging; preserved real migration/SQL regression evidence                                                      | No new standalone tenant model is claimed                                           |
| T03 enrollment/fencing/fanout      | PARTIAL           | `search-enrollment.ts`, document/version/upload and organization hooks, outbox recovery; prior real SQL rollback/idempotency/lifecycle tests                                           | Live v3 broker redelivery/restart/fanout gates                                      |
| T04 private Elasticsearch          | PARTIAL           | Official client, internal module/interface, mapping/target validation, timeouts, authentication, private Compose and static topology tests                                             | Real container/auth/connectivity/restart/image verification                         |
| T05 lexical publication            | PARTIAL           | Shared bounded PDF parser/storage checks, deterministic 8192-scalar segments, persisted manifest before writes, exact visible-set verification before SQL completion; SQL/parser tests | Real ES partial writes/visibility, broker/worker crashes and concurrent late writes |
| T06 keyword API                    | PARTIAL           | Authenticated POST, safe DTO/query, SQL scope and final hydration, canonical output and controlled errors; prior SQL/HTTP tests                                                        | Real analyzer/query/isolation tests through serving stack                           |
| T07 hybrid/windows                 | PARTIAL           | Existing embedding/Qdrant services, profile fences, document RRF60, fixed owner/session-bound Redis windows; ranking fixtures and authorization tests                                  | Real ES/Qdrant/Redis/provider integration, judged corpus and resource budget        |
| T08 highlights/suggestions/sources | PARTIAL           | Canonical scalar highlights, private SQL-authorized title/reference/issuer suggestions, exact authorized historical text resolver; source/security fixtures                            | Real analyzer-to-highlight provenance and live two-owner source workflows           |
| T09 frontend/browser               | PARTIAL           | AuthApi/shadcn `/search`, typed allowlists, cancellation, safe React marks, ephemeral owner drafts and text Sheet; fresh production build and five real Chromium tests with mocked API | Live Nginx search/source E2E; broad accessibility/device audit not certified        |
| T10 operations                     | PARTIAL           | Existing jobs/outbox, SQL operation leases/checkpoints, shadow generations, externally verified bounded cutover, exact cleanup and report-only orphans; 12 real SQL tests              | Real loss/rebuild/repair, broker interruption and multi-worker recovery             |

No listed task is wholly NOT IMPLEMENTED. The A11 judged corpus and measured
deployment budget are **NOT VERIFIED** and no completed implementation/evidence
artifact was found for them. T11 does not manufacture relevance labels or invent
performance thresholds.

## Architecture, security and compatibility review

PostgreSQL owns ownership, immutable version identity, desired revision, verified
projection and maintenance state. Elasticsearch/Qdrant remain replaceable candidate
indexes. Existing v3 jobs and transactional outbox perform fanout; no external IO
belongs to SQL commit callbacks. Dedicated workers preserve integrity/extraction/AI
dispatch. Redis stores bounded disposable result windows, not publication truth.
API module dependencies introduce no new `forwardRef` workaround or second SDK,
authorization framework, processing queue or embedding provider.

`KeywordSearchRepository.ready` requires owned active current versions, matching
desired revision, verified READY projection, SERVING generation and current metadata
hash. `finalize`/hybrid hydration reread canonical sources under one final SQL
snapshot. Engine text/IDs do not directly become user output; raw engine scores and
hit totals are not exposed as authorized totals. SQL errors fail closed. The
semantic leg checks the existing active profile, dimensions and canonical manifest
references; raw BM25/vector scores are not added. Fusion collapses documents before
RRF voting and uses stable document identity tie-breaks.

Controllers derive stable `userId` and session from authentication, validate DTOs
and retain CSRF/origin rules for POSTs. The project is a per-user private vault;
`userId` is its isolation key. An independent organization tenant/ACL model is not
implemented or implicitly added by Phase 5. Foreign/deleted/archived/current-version
and stale-generation tests exist, but this is not a claim of audited multi-tenant
enterprise authorization.

Highlights are bounded canonical plain text with Unicode scalar, half-open ranges;
the frontend uses React text and `<mark>`, never HTML parsing. Suggestions are
restricted to authorized metadata, not global body terms. Exact source reads repeat
ownership/lifecycle/artifact/verified-lineage checks. Retained historical verified
text is intentionally allowed after version replacement/index retirement; archive,
deletion or loss of ownership still denies access. A source ID is not a capability.

The publication handler checkpoints the deterministic manifest before ES writes,
verifies exact search-visible content, and finalizes through document/job lease,
revision, generation and SQL guards. External writes cannot be rolled back by SQL;
stale physical content can remain while authoritative retrieval excludes it.
Maintenance uses the same fences and durable work. Operator role membership is
checked before every CLI action; unknown/extra identities are not blindly deleted.

Private ES/Qdrant networks, no default ES host port or Nginx proxy, file-backed
credentials and validated target names are configured. Authenticated HTTP on the
isolated local search network is explicit; this is **not production TLS
certification**. The loopback debug override is opt-in. No browser connects to a
search engine, stores private suggestions persistently or constructs storage URLs.

### Findings and release impact

| ID  | Severity | Finding                                                                                                                         | Disposition                                                                                                                                                                                                                                 |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | High     | Required real ES/broker/Redis/Qdrant integration, outage/restart and Nginx workflows remain unverified                          | Release blocker; Docker engine unavailable, no mock substitution                                                                                                                                                                            |
| F02 | High     | A11 requires at least 30 judged queries plus agreed real latency/memory budget; no complete corpus/results/budget found         | Release blocker; run the approved quality protocol before tuning or claiming acceptance                                                                                                                                                     |
| F03 | High     | No reviewed-candidate remote CI evidence for this dirty tree                                                                    | Release blocker; a workflow file/local pass does not prove final-commit CI                                                                                                                                                                  |
| F04 | Medium   | API production audit reports five moderate findings, including Nest SSE field injection and transitive file-type parsing issues | Audit exits 0 at high threshold; no app `@Sse`/EventSource, FileTypeValidator/ParseFilePipe/file-type import found. Limited apparent reachability is an inference, not exploit-proof certification; track dependency remediation separately |
| F05 | Low      | Full frontend formatting fails in 47 existing files outside the Phase 5 search change                                           | Recorded, not cosmetically rewritten; Phase 5 scoped format passes and CI checks that scope                                                                                                                                                 |
| F06 | Low      | CI omitted explicit T10 migration/CLI/maintenance selectors and browser automation                                              | Corrected in T11; local selectors/browser verified, remote execution still pending                                                                                                                                                          |

No exploitable Critical/High application defect was established in this source
review. That statement is not a completed penetration test or proof that none
exists. F01–F03 are high-impact acceptance gaps, not fabricated vulnerability claims.

Additional Low operational finding: on this restricted Windows host, Playwright
finished all five test cases but its npm-launched web server did not terminate
automatically. The exact Node server started by this run was stopped explicitly;
Playwright then exited 0 with **5 passed (5.4 minutes)**. This does not invalidate
the UI assertions, but automatic teardown is not locally certified. Linux CI
teardown remains to be observed; do not leave a test server running after a run.

The advisory sources describe [SSE field injection](https://github.com/advisories/GHSA-36xv-jgw5-4q75),
[file-type ASF parsing](https://github.com/advisories/GHSA-5v7r-6r5c-r473) and
[file-type ZIP decompression](https://github.com/advisories/GHSA-j47w-4g3g-c36v).
The last advisory page did not load in the browser check; its identifier/title
come from the actual npm audit output. No forced dependency upgrade was made.

## Supported bounds and explicit differences

- Keyword/hybrid are separate endpoints, not a new mode-switching universal API.
  Semantic-only search stays in existing AI Search. Hybrid fails explicitly when
  either required leg fails; no silent fallback. Keyword does not invoke embeddings.
- Page size 1–20, default 10; frontend uses 10. Each fusion leg is capped at 100
  documents, total window at 200. Metadata scopes are capped (default 100); refine
  filters when exhausted. These are bounded results, not corpus-wide exact totals.
- Redis windows expire after 300 seconds; at most 8 per owner/256 globally and
  256 KiB serialized each. Every page reauthorizes; expired/mutated windows restart.
- Query length is at most 4000 UTF-16 units/64 word runs. Prefix is 2–200 units,
  suggestions at most 10 (frontend 5). Highlights allow at most 32 scalar ranges
  and bounded 400-scalar snippets. PDF segments are 8192 scalars with extraction
  byte/page/text/deadline limits; no OCR or provider calls for lexical extraction.
- Maintenance batches are 1–25, CLI at most 10 batches per invocation, 250 ms
  between batches, one global RUNNING operation and durable 120-second leases.
  Cutover is at most 1000 eligible documents with a 30-second SQL transaction and
  short write fence; it is not zero-write-downtime or an atomic SQL/ES transaction.
  Retirement cleanup waits/rechecks after 24 hours. Rollback is a forward rebuild.
- Rate admission is process-local, not a distributed multi-replica quota.
  SQL authorization is batched; bounded maintenance intentionally inspects per
  document. No corpus-scale throughput or percentile latency result is claimed.
- Sources open exact canonical historical text/page segments, **not binary PDFs**.
  The approved plan permits canonical source navigation; a historical PDF viewer
  remains absent. Back restores form drafts in owner-scoped memory, not old
  authorized results/cursors or private query URLs. Supported frontend filters are
  a deliberate subset, not all backend filter options.

## T11 commands and results

All commands use existing installed dependencies and Node **24.9.0**. No fresh
install, migration rerun or expensive unchanged SQL/full-suite rerun was needed.

| Command/environment                                                                                                                                                                                                                                                            | Result                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web `npm.cmd run lint` and `npm.cmd run typecheck`                                                                                                                                                                                                                             | PASS                                                                                                                                                                                                            |
| Web `npm.cmd run format:check`                                                                                                                                                                                                                                                 | FAIL: 47 existing files; search-specific check below passes                                                                                                                                                     |
| Web `npm.cmd run build`                                                                                                                                                                                                                                                        | PASS: fresh Next.js 16.3.8 production build, `/search` included                                                                                                                                                 |
| Web `node node_modules/prettier/bin/prettier.cjs --check app/search features/search lib/api/search.ts e2e/search.mock.spec.ts e2e/phase-five-search.spec.ts tests/search-client.test.ts tests/search.fixture.ts tests/search.integration.test.tsx playwright.search.config.ts` | PASS                                                                                                                                                                                                            |
| Web `node node_modules/@playwright/test/cli.js test --config playwright.search.config.ts`                                                                                                                                                                                      | PASS: 5 real Chromium tests, production Next.js, **mocked authenticated API**, not live Nginx/backend                                                                                                           |
| API Jest `--runInBand --runTestsByPath` for search-ranking, safe-highlights, hybrid-search.service, lexical-source.service, search-window.store specs                                                                                                                          | PASS: 48 tests, 1 live Redis test skipped; 5 suites                                                                                                                                                             |
| Four projects `npm.cmd audit --omit=dev --audit-level=high --cache ../../.tools/npm-cache`                                                                                                                                                                                     | PASS threshold: API 5 moderate findings; web/database/storage 0 vulnerabilities. User explicitly approved npm metadata export after initial automatic rejection; initial sandbox attempt failed advisory access |
| Workflow YAML parsed with installed js-yaml; four package manifest dependency maps compared order-independently with package-lock roots                                                                                                                                        | PASS; no installs/lock edits. Initial custom order-sensitive comparison was corrected; no actual lock mismatch                                                                                                  |
| GitHub connector `fetch_commit_workflow_runs` for Eqooid/qyvra at base HEAD                                                                                                                                                                                                    | Returned empty PR-triggered run list; this wrapper does not enumerate all push runs. **NOT VERIFIED**, no remote pass                                                                                           |
| `docker --config .tools/docker-public info --format '{{.ServerVersion}}'`                                                                                                                                                                                                      | BLOCKED: missing `docker_engine` pipe                                                                                                                                                                           |
| API/database/storage builds/lint/types, API format, real SQL/migrations, HTTP and static Compose                                                                                                                                                                               | Reused T10 evidence above; unchanged runtime source, see its exact command ledger                                                                                                                               |
| Full frontend components/regressions                                                                                                                                                                                                                                           | Reused T09: 237 passes/23 files; no frontend behavior edits in T11                                                                                                                                              |

New browser config launches the production server for the focused suite. It
still labels responses as mocked, disables private screenshot/video/trace capture
and does not pretend to run the separately gated live fixture. Next reports its
existing standalone-output startup warning; tests completed after the explicit
Windows server cleanup noted above. Final config-specific ESLint and TypeScript
checks also passed.

CI retains Node 24, locked per-project installs, old storage/document/AI suites,
private services and high-severity audits. T11 adds explicit maintenance SQL/CLI/
upgrade selectors plus a separate frontend component/build/Chromium job. Workflow
syntax and local commands are verified; clean Linux installs, image builds and
remote job outcomes are not. Disposable CI passwords/trust apply only to isolated
test services, not committed production credentials.

## Final acceptance matrix

Status refers to the complete required area. Partial local evidence is described
explicitly instead of assigning a misleading PASS to an unexecuted live gate.

| Area                        | Status       | Supporting evidence or missing gate                                                                          |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| T01–T10 requirements        | BLOCKED      | T01/T02 complete; T03–T10 local implementation reviewed, mandatory live gates pending                        |
| Architecture compatibility  | PASS         | Source/DI/ownership/transaction review against approved plan; limits above                                   |
| Search persistence          | PASS         | Preserved fresh 18-migration, populated upgrade and real SQL checks                                          |
| Durable processing | PARTIAL | Live upload/outbox/RabbitMQ/worker publication passed; additional outage/recovery scope recorded in continuation ledger |
| Elasticsearch publication   | BLOCKED      | 45-test continuation includes live ES evidence; full broker/race coverage remains open                            |
| Keyword search | PARTIAL | SQL/HTTP and real Nginx keyword workflow pass; measured corpus evidence and remaining gates in continuation ledger |
| Hybrid search               | BLOCKED      | Deterministic RRF/ownership tests pass; real engines/providers missing                                       |
| Authorization/isolation     | BLOCKED      | SQL/unit/HTTP invariants verified locally; mandatory live two-owner stack missing                            |
| Highlights/autocomplete     | BLOCKED      | Safe canonical mapping/SQL/browser doubles pass; real analyzer provenance missing                            |
| Source navigation           | BLOCKED      | Authorized exact text resolver/UI tested; live end-to-end gate absent                                        |
| Search frontend             | BLOCKED      | Production build, components and mocked Chromium pass; Nginx live gate absent                                |
| Backfill/rebuild            | BLOCKED      | Durable SQL/parser evidence passes; live generation/loss/cutover gate missing                                |
| Reconciliation/recovery     | BLOCKED      | SQL/outage doubles pass; live outage/restart gate missing                                                    |
| Existing RAG compatibility  | NOT VERIFIED | Prior deterministic provider/RAG and frontend regression passes; no fresh live Phase 5 model/RAG run         |
| Security review             | PASS         | Focused source/contract review completed with findings F01–F06; not full live security certification         |
| Automated tests             | FAIL         | Selected tests/builds pass; full frontend formatting fails; live suite incomplete                            |
| Browser E2E | PARTIAL | Real Nginx/Chromium upload-to-search/source/isolation/archive passed (1 test); extended/hybrid scenarios remain open |
| CI/build readiness          | NOT VERIFIED | Local builds/CI syntax pass; remote reviewed-candidate CI/image builds missing                               |
| Documentation               | PASS         | Current review, versioned candidate/developer guides and indexes updated with actual limitations             |
| Upgrade/rollback guidance   | PASS         | Additive rollout, coordinated v3 runtimes, explicit backfill and forward-only generation rollback documented |
| A11 quality/resource budget | NOT VERIFIED | Judged corpus, agreed thresholds and real measurements missing                                               |

## Decision and continuation checkpoint

T11 changes are confined to `.github/workflows/phase-five-search.yml`,
`apps/web/playwright.search.config.ts`, this acceptance ledger, the new draft
`docs/releases/v1.4.0.md` and `docs/developer/versions/v1.4.0.md`, plus current
README/changelog/documentation indexes, API/architecture/database/testing/roadmap
guides and current ADR-007/008 status labels. No historical release snapshot,
runtime feature, database migration, dependency or VERSION was changed by T11.

Final local checks resolved **477 file targets across 16 documentation files**;
fragment anchors were not automatically checked. The ignored local checkpoint
`.tools/phase5-t11-review-manifest.json` records SHA-256 values for 52 reviewed
source/configuration files so a continuation can detect changed evidence scope.
The new guides/workflow pass Prettier and `git diff --check` passes. This does
not override the explicitly failed repository-wide frontend formatting check.

**NOT READY**: missing mandatory verification is sufficient to block release even
without a proven application defect. Do not rename these blockers non-blocking,
bump VERSION, mark Phase 5 complete or publish a release on this evidence.

Next: restore Docker, use isolated migrated test resources, then run the existing
private runtime/maintenance harness with `TEST_DATABASE_URL`. Close separate live
RabbitMQ duplicate/outage/restart/two-worker and Redis/ES/Qdrant/profile gates.
Run the existing `E2E_SEARCH_ENABLED` Nginx fixture with its isolated-project
guards; verify lifecycle/version/restore, hybrid and browser workflows beyond its
currently covered cases. Complete the approved 30-query relevance corpus and
agree/measure resource budgets. Reuse unchanged local results; do not repeat real
backfill, reset volumes, delete active indexes or download models automatically.

After blockers are closed, prepare a separately reviewed candidate commit only
when authorized, run required remote CI on that exact commit, and then reconsider
VERSION/release preparation. T11 cannot be marked fully complete before its
mandatory gates pass. Production release/commit/tag/deployment remain separate.

## 16 October live continuation update

The [continuation ledger](phase-5-live-verification.md) records 45 selected passing
tests with real Elasticsearch/private runtime/restart evidence and corrected
configuration defects. Earlier rows describe the T11 checkpoint; claims that no
live Elasticsearch evidence exists are superseded for those specific checks.
Aggregate durable-broker, browser, hybrid and quality/resource acceptance remains
incomplete. Decision remains **NOT READY**. Do not rerun the passed runtime harness
merely because Docker is currently unavailable again.

## Browser continuation result

The [live continuation ledger](phase-5-live-verification.md) now records a passed
real Nginx/Chromium PDF-to-search/source/isolation/archive workflow (1 test,
15.5 seconds). Earlier Docker-blocked/unexecuted descriptions are historical
for that scenario. Hybrid and full quality/resource acceptance remain open.

## Final continuation evidence

See the [current ledger](phase-5-live-verification.md) and
[corrected keyword measurements](phase-5-keyword-quality-results.json). Real
browser, listed outage/lifecycle scenarios and two-worker duplicate delivery now
have evidence. Keyword-only measurements do not close A11 or live hybrid. The
Thai query miss and peak/dense-load gaps remain disclosed. Decision: NOT READY.
