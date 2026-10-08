# Phase 4 / v1.3.0 verification (T12)

Status: **READY WITH KNOWN NON-BLOCKING LIMITATIONS — T12 complete, 8 October 2026.**
This is a verified release candidate, not a tagged or published v1.3.0 release.
This record tests the existing T01–T11 working-tree checkpoint. Historical release snapshots remain
unchanged. PostgreSQL is authoritative; RabbitMQ is transport, Redis is disposable
progress and Qdrant is a rebuildable index. The current ownership model is users,
without a separate tenant entity.

## Verification matrix

Results below have saved execution evidence from T12, including its continuation.
Deterministic embedding/generation fixtures do not prove real-model answer quality.

| Capability           | Expected behavior                                           | Coverage / command                                                       | T12 result                                                                                        | Remaining gap                                                               |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Clean build          | Locked dependencies, API/worker/web/shared packages compile | Package build/typecheck/lint scripts; Docker build                       | Passed before continuation; patched database and affected image builds passed during continuation | Remote CI not executed                                                      |
| Migration            | Clean deploy and Phase 3 upgrade preserve originals/jobs    | `test:ai:migration`, database persistence tests                          | Passed before continuation; unchanged migrations not rerun                                        | No actual Phase 3 Docker-volume upgrade fixture                             |
| Upload scheduling    | Version/run/job/outbox atomic, duplicate receipts safe      | API upload/ingestion integration; browser Phase 4                        | Passed before continuation                                                                        | None within supported scope                                                 |
| Extraction           | PDF limits, canonical provenance, crash rollback            | PDF unit/integration; nine fixtures in unprivileged Linux image          | Passed before continuation                                                                        | OCR excluded                                                                |
| Chunking             | Determinism, Unicode, complete sets, rollback               | Chunk unit/integration; full pipeline Unicode browser case               | Passed before continuation                                                                        | None within supported scope                                                 |
| Embeddings           | Valid vectors only, checkpoint reuse after interruption     | Embedding unit/integration suites                                        | Passed before continuation                                                                        | Live model quality not evaluated                                            |
| Vector indexing      | Partial indexes excluded, verified activation, recovery     | 13 live Qdrant integration cases; browser collection-loss rebuild        | Passed before continuation                                                                        | No production capacity benchmark                                            |
| Semantic search      | Owned SQL-authorized canonical evidence                     | Semantic-search integration/browser; native final-image HTTP adapter     | Passed before and during continuation                                                             | Model-specific score calibration                                            |
| RAG                  | Bounded untrusted context, abstention, validated references | RAG unit/integration/browser; native image adapter                       | Passed before and during continuation                                                             | Live model injection resistance not proven                                  |
| Citations            | Exact owned document/version/chunk/pages                    | Source API/web/browser; 2,000-span client contract                       | Passed before continuation                                                                        | Historical binary viewer excluded                                           |
| Frontend             | Safe rendering, expiry, responsive/theme/keyboard           | 214 web tests; 11 browser cases                                          | Passed before continuation                                                                        | 25 unchanged formatting warnings                                            |
| Lifecycle            | Immediate archive/delete exclusion, restore reuse           | Ingestion/vector/search integration/browser                              | Passed before continuation                                                                        | Public permanent purge excluded                                             |
| Authorization        | Foreign objects and forged vectors never enter context      | Search/RAG/source/reprocess integration; new forged-owner RAG candidate  | Passed before and during continuation                                                             | Separate tenants not implemented                                            |
| Recovery             | SQL leases/outbox survive worker/broker/Redis outages       | Worker/outbox/pipeline/AI integration; Compose interruptions; live Redis | Passed before and during continuation                                                             | No exactly-once provider billing guarantee                                  |
| Backfill/reprocess   | Bounded keyset, idempotent, reuse expensive artifacts       | Ingestion integration; retained T08 CLI evidence                         | Passed before continuation; CLI evidence not rerun                                                | Backfill trusts SQL readiness; use explicit index rebuild after remote loss |
| Security/config      | No sensitive content/secrets; private services              | Config/log/provider tests, Compose review, npm audit                     | Runtime audits pass high/critical gate after targeted patches                                     | Five moderate API findings; development tooling advisories                  |
| Phase 1–3 regression | Existing auth/document/catalog/processing unchanged         | 281 API HTTP cases; persisted browser result: 11/11                      | Passed before continuation; not rerun                                                             | Separate destructive Phase 3 reliability harness not rerun                  |
| CI                   | Deterministic checks reproducible without paid providers    | New `.github/workflows/phase-four.yml`; YAML parsed during continuation  | Local commands verified; workflow added                                                           | Remote GitHub run not executed                                              |

## Changes under verification

- Frontend page-span validation now accepts the server's validated maximum of
  2,000 pages, instead of rejecting valid configured PDFs above 500 pages.
- The existing AI browser harness accepts a validated isolated project suffix,
  with independently generated credentials and volumes. T12 uses a fresh project,
  preserving development and earlier test volumes.

## Evidence and limitations

T11 evidence is retained in its frontend guide. T12's execution ledger and consolidated
completion report below distinguish saved passes from continuation checks and gaps.

## Test classification and scope

Unit tests use infrastructure doubles where appropriate. HTTP regression tests use
the existing database double. Integration tests run against PostgreSQL 17, Qdrant
1.19.2, RabbitMQ 4.1 and Redis 7.4. They inject deterministic provider implementations.
Browser tests use actual production native HTTP embedding/generation adapters,
the Linux PDF sandbox, workers, outbox and private service networks, with a separate
deterministic HTTP provider fixture. **No live commercial/local model was tested**;
no paid API key was used. Passing this fixture proves transport, boundaries and
provenance, not semantic model accuracy or immunity to every prompt injection.

There is no independent tenant feature. Two-user tests exercise the implemented
ownership boundary. There is no public permanent-document purge endpoint. Existing
vector integration tests exercise durable cleanup replay and safe internal purge
after cleanup; T12 does not introduce a purge API or change retention policy.

## Reproduce checks

Install the four lockfiles in package order (storage, database, API, web), then use
the package `build`, `typecheck`, `lint` and test scripts. API build also builds the
shared packages and dedicated worker entry point. Linux host tests additionally
need qpdf, gcc and `npm --prefix apps/api run pdf:sandbox:build`.

Set `DATABASE_URL` and `TEST_DATABASE_URL` to a migrated disposable database whose
name contains `test`. Set `TEST_MIGRATION_DATABASE_URL` to a **separate empty** test
database. Real-infrastructure tests also use `TEST_QDRANT_URL`, `TEST_REDIS_URL`,
`TEST_RABBITMQ_URL` and `TEST_RABBITMQ_CONTAINER` (isolated test container name or CI
service ID). Never use application databases, broker queues or vector collections.

```sh
npm --prefix packages/database run migrate:deploy
npm --prefix packages/database run test:ai:migration
npm --prefix packages/database run test:ai
npm --prefix packages/database run test:pipeline
npm --prefix packages/storage test
npm --prefix packages/storage run test:integration
npm --prefix apps/api test -- --runInBand
npm --prefix apps/api run test:e2e -- --runInBand
npm --prefix apps/api run test:integration:isolated
npm --prefix apps/web test -- --maxWorkers=1
```

The isolated integration runner executes existing Jest suites sequentially. Each
broker suite receives a newly provisioned virtual host, deleted after its process
exits. It never purges shared queues. A monolithic run sharing one broker vhost can
leave queued messages for a later suite with different handlers and is unsuitable
for the full broker suite. Do not run database recovery suites concurrently against
the same database. The CI workflow uses these same deterministic checks, without
paid-model credentials; remote GitHub execution is separate from local verification.

For real browser fault injection, use an isolated suffix, e.g. in PowerShell:

```powershell
$env:E2E_PROJECT_NAME = 'qyvra-e2e-ai-t12'
node infrastructure/e2e/ai-run.cjs up
$env:E2E_AI_ENABLED = 'true'
Push-Location apps/web
node node_modules/@playwright/test/cli.js test phase-four-ai.spec.ts phase-four-recovery.spec.ts
Pop-Location
node infrastructure/e2e/ai-run.cjs down
```

The recovery suite only accepts a T12 project name and removes collections solely
inside that isolated Qdrant service. The helper forces isolated volume names and
generated fixture credentials. It provisions the immutable SQL profile before
enrollment-enabled API startup. `down` preserves test volumes. Use a new suffix for
another clean-start test; never reset user volumes. Browser traces/video/screenshots
remain disabled because they can capture credentials or private document content.

## Operational recovery

| Failure                   | Safe procedure                                                                                                   | Durable guarantee                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Qdrant lost               | Restore private Qdrant, then submit owned current-version `mode: "index"` reprocessing below                     | Reuses complete SQL embeddings, creates a fresh manifest, verifies every point before activation |
| Redis lost                | `docker compose up -d redis`                                                                                     | Progress may disappear; jobs/checkpoints/status remain in PostgreSQL                             |
| RabbitMQ interrupted      | Restore original broker configuration/volume; `docker compose up -d rabbitmq outbox worker`                      | Outbox publishes committed intent; duplicate confirmed publication is safe                       |
| Worker crash              | `docker compose up -d worker outbox`; inspect owned processing status                                            | Expired SQL leases enter bounded recovery; committed checkpoints are reused                      |
| Embedding provider outage | Restore endpoint/credentials; allow SQL retry deadlines to elapse                                                | Completed batches remain; deterministic credential/model errors are terminal                     |
| Generation outage         | Restore independently configured generation provider                                                             | Interactive RAG returns a controlled error; ingestion/original downloads are unaffected          |
| Failed processing         | Inspect owned status; fix deterministic cause or upload a corrected new version; schedule supported reprocessing | Never manually mark jobs complete or mutate immutable artifacts                                  |
| Exhausted vector cleanup  | After restoring Qdrant, trusted maintenance calls `replayVectorRemoval(userId, manifestId)`                      | Cleanup intent persists; replay never restores retrieval eligibility                             |

Index-only repair uses the existing authenticated, CSRF-protected route:

```text
POST /api/v1/documents/{documentId}/versions/{versionId}/ai/reprocess
Cookie: <authenticated owner's session cookie>
X-CSRF-Protection: 1
Idempotency-Key: <fresh UUID>
Content-Type: application/json

{"mode":"index"}
```

Keep the UUID for retries of an ambiguous response. This schedules work, not a
synchronous provider call. A new ready pointer should replace the previous one
after verified indexing. SQL `aiReadiness: READY` describes authoritative generation
readiness, **not live Qdrant/provider health**. A lost collection can coexist with a
SQL ready pointer; use explicit `index` mode rather than assuming generic `repair`
or ordinary backfill detects remote loss. Backfill intentionally skips SQL-ready
versions. Trusted `requestVectorRebuild(userId, manifestId)` is another existing
maintenance boundary; no re-embedding is needed for valid retained checkpoints.

Do not delete PostgreSQL, storage or RabbitMQ volumes as an outage workaround.
Keep backups of authoritative database and original files; Qdrant may be rebuilt.

## Production configuration review

| Component  | Required for deployment                                                                                                                | Optional / development-only                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| PostgreSQL | Stable credentials/volume, migrations, backups, bounded pool/timeouts                                                                  | Test trust authentication is fixture-only                                |
| Storage    | Private root/volume, backups, API write and worker read access                                                                         | Local adapter implemented; cloud adapters remain future work             |
| RabbitMQ   | Private broker, matching credentials/topology, outbox and worker processes                                                             | Test virtual hosts are disposable                                        |
| Redis      | Private URL when progress is enabled                                                                                                   | Entire progress service is optional/disposable                           |
| Qdrant     | Private internal network, durable/rebuildable volume, configured URL; protect any remote endpoint                                      | Never publish its production port; fixture host ports bind loopback only |
| Embeddings | Explicit enabled flag, immutable provisioned SQL profile, exact matching fingerprints/model revision/dimensions, bounded batch/timeout | Provider key depends on adapter; fixture HTTP endpoints are test-only    |
| Generation | Independent endpoint/model/key and validated budgets when RAG is enabled                                                               | Disabled RAG needs no generation provider                                |
| API        | Validated origins, production HTTPS/secure cookies, session/storage limits                                                             | Default local HTTP configuration is not a public production deployment   |
| Worker     | Same extraction/chunk/profile contract, job leases and limits, Linux PDF guard                                                         | Never run parsing in upload HTTP handlers                                |
| Web/Nginx  | Production build, aligned upload limit, TLS termination, same-origin API routing                                                       | Only Nginx publishes the documented loopback port by default             |

Provision the embedding profile before enabling enrollment, and enable/configure
worker embeddings/indexing before API enrollment/search/RAG. Do not place secrets
in profile rows, vector payloads, prompts, progress or `NEXT_PUBLIC_*` variables.
The normal Compose stack never loads the provider fixture or its `/stats` endpoint.
Elasticsearch is not required by this phase.

## Targeted hardening and dependency review

- Corrected the client page-span ceiling to match validated 2,000-page server limits.
- Fenced AMQP connection setup against shutdown. An in-flight reconnect previously
  could finish after `stop()`, revive readiness and leak a broker connection.
  Regression tests stop during connection opening and consumer registration.
- Isolated broker integration suites rather than purging shared resources or
  weakening failing assertions. CI now runs deterministic infrastructure checks.
- Patched Next.js to **16.3.6**, `proxy-addr` to **2.0.8**, Sharp to **0.35.5**,
  `source-map-js` to **1.2.2** and `fast-uri` to **3.1.8**. Lockfiles were refreshed
  without installed modules in Linux to include native optional dependency entries.
  See the [Next.js advisory](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j),
  [proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) and
  [Sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
- Production dependency pruning skips redundant network audits during image builds;
  explicit npm production audits remain part of verification and CI. This does not
  skip dependency installation or change the production package set.
- `shadcn` is a development CLI, now classified in `devDependencies`; it is not a
  production application import or an implemented MCP integration.
- The continuation found Prisma's optional CLI peer included by the database
  production audit: four high and one moderate findings. Targeted overrides pin
  `deepmerge-ts` **8.0.0**, `mysql2` **3.24.5** and `fast-uri` **3.1.8** without
  changing Prisma 7.10.0 or the PostgreSQL adapter. The production database audit
  now has **zero findings**; generation, validation and repeat migration deploy pass.
  This retains the high/critical CI gate rather than suppressing it. See the
  [recursive-merge advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) and
  [MySQL credential advisory](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr).
  Qyvra does not connect to MySQL. CLI and runtime image compatibility are checked
  after these overrides; historical migrations are unchanged.
- Native adapters use bounded JSON, exact profile identity and sanitized failures.
  Retrieval hydrates and reauthorizes owned SQL sources; context and publication
  repeat authorization. Qdrant payload text/title/owner assertions are untrusted.
  Model references must resolve to supplied source tokens; forged S999 is rejected.
  Frontend answer rendering remains plain text with validated citation buttons.

Known cost limits: query embedding is paid work per search/answer; no document
re-embedding occurs on query, valid restore or index-only repair. Checkpoints avoid
repeating committed batches, but a provider response followed by a crash before
checkpoint commit can still cause duplicate billing. Model aliases may drift unless
operators pin revisions. Scores/thresholds require model-specific calibration.

## Known limitations and exclusions

PDF-only AI extraction; no OCR, image-only searchable text or new formats. Questions
are standalone; no chat history, streaming, tools, autonomous document changes,
agents, multi-agent systems, LangChain/LangGraph, Hermes, MCP integration or local
model orchestration. Historical source navigation resolves retained canonical text,
not an old-version PDF viewer/download. There is no independent tenant policy or
public permanent purge. SQL citations validate provenance, not semantic entailment
of every model claim; real-model quality/adversarial evaluation is optional follow-up.
Provider availability is needed for new/query embeddings and generation. Ordinary
Compose is a local HTTP stack requiring the documented production TLS/security setup.

## Checkpoint recovery and execution ledger

The continuation began on **8 October 2026**. No staged changes were present;
the large existing T01–T11 working tree was preserved. Saved logs and the browser
report were inspected before editing or running tests. There were no unfinished
production functions, disabled assertions or temporary production mock switches.

| Area at checkpoint                                          | Classification                                | Continuation action                                                 |
| ----------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Clean migrations, Phase 3 upgrade, database/storage tests   | Completed but needs final reporting           | Preserve evidence; do not repeat clean migrations                   |
| API unit/HTTP, isolated broker suites, live vector recovery | Completed but needs final reporting           | Preserve passes; consumer shutdown regression already verified      |
| Browser regression and recovery                             | Completed but needs final reporting           | Read saved report: 11 tests, all passed; do not rerun               |
| Forged-owner RAG candidate regression                       | Implemented but not verified                  | Execute with actual PostgreSQL/Qdrant                               |
| Final-image native search/RAG checks                        | Not started in prior T12 run                  | Execute both optional native container cases                        |
| Optional live Redis unit case                               | Not started                                   | Execute against retained isolated Redis                             |
| Shared-package production dependency audits                 | Partially completed                           | Finish; diagnose and patch database gate failure                    |
| CI workflow                                                 | Implemented; remote execution unverified      | Parse YAML; inspect commands; retain remote-run limitation          |
| Final documentation, ledger, diff and readiness             | Partially completed                           | Finish current record and canonical cross-links                     |
| Paid/local model quality, production load/HA                | Not started; outside deterministic acceptance | Explicitly unverified; no credentials or production corpus supplied |

Evidence under ignored `.tools/t12-*` is local verification output, not a committed
release artifact. It contains no paid provider credentials. The browser reporter
stores only test title/status/redacted errors in ignored
`apps/web/playwright-report/results.json`; its retained final report has **11 passed**.

| Command / evidence                                                                   | Exact result                                                                                    | Execution attribution                                                                 |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Database clean `migrate:deploy`                                                      | All 15 migrations applied                                                                       | Passed before continuation; not rerun                                                 |
| Database `test:ai:migration`                                                         | 1 passed; Phase 3 rows/jobs/outbox preserved; repeated deploy safe                              | Passed before continuation; not rerun                                                 |
| Database `test:ai`, `test:pipeline`                                                  | 21 and 27 passed                                                                                | Passed before continuation; not rerun                                                 |
| Storage `test`, `test:integration`                                                   | 3 passed; 11 passed / 1 platform skip                                                           | Passed before continuation; not rerun                                                 |
| API unit `jest --runInBand`                                                          | 41 suites, 416 passed / 1 optional Redis skip                                                   | Passed before continuation; unaffected cases not rerun                                |
| Consumer shutdown unit regression                                                    | 2 passed                                                                                        | Passed before continuation; not rerun                                                 |
| Live Redis progress unit file                                                        | 2 passed, including the formerly skipped live-service case                                      | Passed during continuation                                                            |
| API HTTP `test:e2e -- --runInBand`                                                   | 15 suites, 281 passed                                                                           | Passed before continuation; not rerun                                                 |
| Isolated integration runner                                                          | Ordinary: 159 passed / 2 native container skips; broker groups: 75 passed across 8 suites       | Passed before continuation across isolated runs; see failure history below            |
| RAG and search integration files with `TEST_CONTAINER_IMAGE=qyvra-e2e-ai-t12-api`    | 2 suites, 21 passed, including native image cases and new forged-owner RAG candidate            | Passed during continuation                                                            |
| API integration coverage aggregate                                                   | 28 suites, 237 distinct cases passed after filling the two native skips and adding one RAG case | Aggregate of saved and continuation runs, not one monolithic invocation               |
| API unit coverage aggregate                                                          | 42 suites, 419 distinct cases passed after consumer additions and live Redis                    | Aggregate, not a repeated full run                                                    |
| Web `test -- --maxWorkers=1` on final dependency pins                                | 194 cases in 20 files passed; remaining catalog file separately passed 20 cases                 | Passed before continuation; 214 distinct cases in 21 files                            |
| Web browser selected Phase 1–4/cancellation/UI suites                                | 11 passed                                                                                       | Passed before continuation; not rerun                                                 |
| API/shared/web typecheck and lint; API/database formatting                           | Passed                                                                                          | Saved checks; patched database checks repeated during continuation                    |
| Web full `format:check`                                                              | Failed: 25 unchanged files                                                                      | Known pre-existing style failure; `git diff --quiet` confirms warning files unchanged |
| Final pre-continuation Compose build/up, quiet config, Nginx validation              | Passed; private services healthy                                                                | Saved evidence; no full-stack rebuild during continuation                             |
| Unprivileged final-image PDF fixture/guard smoke                                     | Nine fixtures and filesystem/process/network denial probes passed                               | Passed before continuation; guard code unchanged                                      |
| Database override install, build, schema validate, repeat migrate deploy             | Passed; no pending migrations                                                                   | Passed during continuation; no schema/migration change                                |
| Affected API/worker/outbox/migration images; retained-volume startup                 | Build and healthy startup passed with patched database lockfile                                 | Passed during continuation; web/infrastructure images reused                          |
| Native search/RAG cases on the patched image (`--testNamePattern='native provider'`) | 2 passed / 19 deliberately unselected, 2 suites                                                 | Passed during continuation; only cases affected by the new image were repeated        |
| Production npm audits (`--omit=dev --audit-level=high`)                              | API: 5 moderate, 0 high/critical; web/database/storage: 0 findings                              | Saved API/web; database/storage finalized during continuation                         |
| CI YAML parse, CJS syntax checks, unchanged style-file check                         | Passed                                                                                          | During continuation                                                                   |

Earlier failed attempts are retained rather than hidden. The initial monolithic
integration run had 222 passed, 12 failed and 2 skipped; it shared a broker and
suffered cross-suite delivery interference and timing failures;
the isolated-vhost runner resolved it. A passing vector suite then failed to exit:
the real consumer shutdown race was fixed and its 13-case quiescent rerun exited
normally. A concurrent build caused three vector timing failures; the same unchanged
suite passed 13/13 when run alone. Web resource contention caused a worker-start
failure, so the missing catalog file was executed separately on the final dependency
pins; no assertions/timeouts were relaxed. Initial Windows-generated locks lacked
Linux native optional entries; refreshed locks passed the production build. Browser
fixtures were corrected for actual `COMPLETED` status, UTF-8 source text and bounded
claim size; production validation was retained. The continuation initially selected
a nonexistent Redis test filename (zero tests executed); the correct file passed.
The first affected-image build lacked the required fixture profile variable and
stopped before building; the corrected command used the retained profile.
The final formatter caught an unformatted T12 harness action; only its line wrapping
was corrected, then syntax and formatting checks were repeated. Browser behavior
was unchanged and its passing expensive suite was not repeated for whitespace.

The database startup after the interrupted session recovered its existing WAL
without resetting data. It uses the retained test port 55434. Docker Desktop and
only the isolated test services were restarted; developer databases and volumes
were not recreated. A Phase 3 SQL upgrade and retained-volume browser recreation
were verified separately; an actual old-release Docker-volume upgrade was not run.

## T12 file inventory

The final review inspected **165 changed/new text files**, checked **507 local
documentation path targets**, and found no missing targets or high-confidence
private-key/provider-key patterns. This is a bounded source scan, not an assertion
that every possible secret format is detected. `git diff --check` passed, staged
changes remained empty, and historical migration/release files had no diff.
Documented default Compose quiet validation and isolated Nginx validation passed.
Final patched API image: `sha256:17ac25bf4b4b19a78ba49ecde03a9e8940f5765cf9584521a66ee46ff01abdfe`.
Runtime inspection confirmed Prisma 7.10.0 and the patched merge/MySQL/URI versions;
the migration target retains its CLI and the API/worker can load the generated client.
At completion the isolated T12 stack and standalone test services were stopped;
their volumes, database data and reports were retained. The developer `qyvra` stack
remained running and healthy; no developer service or volume was removed.

Created in T12:

- `.github/workflows/phase-four.yml`
- `infrastructure/test/api-integration.cjs`
- `apps/api/src/infrastructure/messaging/rabbitmq.consumer.spec.ts`
- `apps/web/e2e/pdf-fixture.ts`
- `apps/web/e2e/phase-four-recovery.spec.ts`
- `docs/phase-4-verification.md`

Modified in T12 (the rest of the working tree belongs to the retained checkpoint):

- API: `package.json`, `package-lock.json`, `src/infrastructure/messaging/rabbitmq.consumer.ts`, `test/rag-answer.integration-spec.ts`.
- Web: `package.json`, `package-lock.json`, `lib/api/ai.ts`, `tests/ai-client.test.ts`, `e2e/phase-four-ai.spec.ts`, `e2e/phase-one.spec.ts`, `e2e/cancellation.spec.ts`.
- Database: `packages/database/package.json`, `packages/database/package-lock.json` (security overrides only during continuation).
- Package documentation: `packages/database/README.md` (corrected current runtime cross-links).
- Infrastructure: `infrastructure/docker/api.Dockerfile`, `infrastructure/e2e/ai-run.cjs`, `infrastructure/e2e/ai-provider.cjs`.
- Documentation: root `README.md`, `docs/README.md`, `docs/architecture.md`, `docs/database.md`, `docs/roadmap.md`, `docs/phase-3-processing.md`, `docs/phase-4-ai-rag.md`, `docs/phase-4-processing.md`, `docs/phase-4-data-foundation.md`, `docs/phase-4-pdf-extraction.md`, `docs/phase-4-ingestion.md`, `docs/phase-4-ai-frontend.md`, `docs/phase-4-rag-answers.md`, `docs/compose.md`, `docs/deployment/environment-variables.md`.

No T12 migration, new AI feature, framework, agent, release tag or release snapshot
was added. Historical releases and applied migration files have no diff.

## Consolidated continuation completion report

1. **Stopping point:** the final browser run had finished successfully; forged-owner
   RAG/native image checks, live Redis, shared audits and final reporting remained.
2. **Already completed:** builds, clean/upgrade migrations, persistence, processing,
   recovery, security regression and all 11 final browser scenarios.
3. **Previously partial:** execution ledger/readiness docs and optional native checks;
   the new forged-vector test existed without execution evidence.
4. **Continuation:** completed the remaining checks, fixed the database dependency
   gate, validated retained data and finished this report without restarting T12.
5. **Created files:** six; see the inventory above. None recreated in continuation.
6. **Modified files:** see inventory; unrelated T01–T11 and user changes retained.
7. **Fixes:** shutdown fencing, page-span ceiling, patched production dependencies,
   portable locks and isolated test infrastructure; no new product capability.
8. **Migrations:** all 15 clean; Phase 3 upgrade preserved documents, versions,
   retrying jobs, v1 outbox and upload receipts. No historical migration changed.
9. **Build/type/lint:** passed; the separate full web format check still reports 25
   unchanged warnings, openly recorded above.
10. **Docker/Compose:** production builds, private topology, startup and retained-data
    recreation passed; affected database-security image verification is recorded below.
11. **Upload → indexing:** real browser upload reaches five completed stages and an
    authoritative ready manifest; original download bytes remain unchanged.
12. **Semantic search:** real Qdrant and native query embedding adapter pass owned
    search, scope, limits, profile compatibility and canonical SQL hydration.
13. **RAG:** native HTTP adapter and controlled fixture generation return validated
    grounded claims; no paid/live model quality claim is made.
14. **Citation navigation:** owned exact version/chunk/page text resolves; manipulated
    document/version/chunk routes and another user's source requests are denied.
15. **Insufficient evidence:** integration/provider counters and browser state prove
    abstention with no unnecessary generation and no fabricated sources.
16. **Isolation:** two-user tests pass. Separate tenants are not part of the model,
    so tenant isolation is not claimed as implemented or independently tested.
17. **Malicious Qdrant payload:** the new test proves a forged authorized owner and
    manifest actually enter vector candidates, then SQL rejects the foreign chunk
    before context/publication. Fake payload text/title never enter the provider.
18. **Prompt injection:** hostile text remains serialized untrusted evidence with
    separate system instructions; real multipage pipeline preserves truthful sources.
    A deterministic fixture cannot prove all live models resist injection.
19. **Citation hallucination:** invented tokens, uncited claims and invalid references
    fail server validation; client URLs are built only from validated identifiers.
20. **Duplicate delivery:** RabbitMQ duplicate processing and outbox replay preserve
    one complete logical result and safe repeatable index point IDs.
21. **Extraction/chunk recovery:** transient storage failures, partial-publication
    rollback, expired leases and duplicate concurrent execution pass real DB tests.
22. **Embedding checkpoints:** committed batches resume without repeating paid work;
    interrupted batches roll back; invalid dimensions/hash/profile/output are rejected.
23. **Index recovery:** partial confirmed batches resume; incomplete verification
    cannot activate; collection loss is repairable from retained SQL vectors.
24. **Activation boundaries:** late/stale workers cannot commit; remote writes before
    SQL completion are safely repeated; cleanup failure preserves the new ready index.
25. **Qdrant outage/rebuild:** real service interruption returns controlled errors;
    full collection deletion followed by explicit index-only reprocessing reactivates
    search/RAG/citations with no embedding-provider input increase.
26. **Redis loss:** real pipeline finishes while Redis is down; live unit checks prove
    expiration/key loss do not affect durable completion.
27. **RabbitMQ/outbox:** upload intent survives stopped broker/worker; restoration
    publishes committed SQL intent and advances the complete pipeline.
28. **Archive/restore:** access closes immediately even with Qdrant unavailable;
    restore reuses valid derived state without new document embeddings.
29. **Delete/cleanup:** soft deletion immediately excludes stale points. Internal
    permanent cleanup is manifest/owner-scoped and replayable; no public purge API.
30. **Reprocessing:** owned CSRF/idempotency-protected requests invalidate only required
    downstream state; the prior ready generation is preserved where the mode permits.
31. **Backfill:** bounded keyset/dry-run/repeat/resume and lifecycle exclusions pass
    ingestion integration; earlier T08 host/container CLI evidence is retained.
32. **Concurrency:** SQL uniqueness, locking, lease fencing and at-least-once tests
    prevent uncontrolled duplicate pipelines, partial sets or competing activation.
33. **PDF edges:** large 120-page browser input, configured limits, malformed/encrypted
    PDFs and image-only no-text classification pass; no OCR or fabricated text.
34. **Unicode:** Indonesian, accented Latin, CJK and emoji retain canonical content
    and exact multipage citation lineage through the real PDF/worker pipeline.
35. **API/frontend security:** owned DTO/CSRF/envelope checks, safe plain-text rendering,
    session expiry and malicious source navigation pass; no HTML execution path added.
36. **Secrets/config:** generated fixture credentials remain ignored; production
    providers/services are private, independently configured and server-only.
37. **Performance/cost:** bounded larger fixtures and 1,536-dimensional checkpoint
    persistence pass; restore/rebuild reuse vectors. A crash before checkpoint commit
    may duplicate provider billing; no production throughput or quality benchmark.
38. **Browser/accessibility/themes:** all 11 cases pass, including keyboard focus,
    mobile/desktop layouts, loading/error/readiness states and light/dark modes.
    This is not a comprehensive WCAG certification.
39. **Phase 1:** registration/session/account/document/download/persistence/cancellation
    browser regressions and matching API/storage tests pass.
40. **Phase 2:** description/catalog filters, sorting, cursors and ownership browser
    regressions and HTTP/persistence tests pass.
41. **Phase 3:** integrity, job/outbox/worker, retry/recovery and owned processing status
    pass. Its separate destructive reliability harness was not rerun unnecessarily.
42. **CI:** workflow added and YAML parsed; local commands pass their documented gates.
    Remote GitHub execution has not occurred and is required before tagging.
43. **Documentation:** current architecture, processing, ingestion, deployment and
    roadmap links corrected; historical release documentation preserved.
44. **Continuation commands:** native search/RAG integration (21), live Redis (2),
    patched database install/audit/build/validate/deploy/type/lint/format, CJS/YAML
    checks and affected-image verification. Saved logs distinguish each command.
45. **Not rerun:** clean/upgrade migrations, broad API/web/storage/DB tests, full browser
    faults and PDF guard probes; unaffected passing evidence was retained.
46. **Unverified:** commercial/local models (no credentials/requirement), remote CI
    (not submitted), production load/HA and actual Phase 3 Docker upgrade fixture.
47. **Limits:** PDF text only; no OCR, persistent chat, streaming, agents/tools, tenant
    collaboration, public purge or old-version binary viewer.
48. **Discovered blockers:** shutdown reconnect race, valid-page client contract
    mismatch, portable native dependency locks and failing production security gate.
49. **Fixed blockers:** all received focused fixes and regression/build/audit checks;
    assertions and production failure/resource limits were not weakened.
50. **Unresolved release blockers:** none found in the supported, tested scope;
    affected-image build, retained startup and native adapter checks passed.
51. **Non-blocking issues:** five moderate Nest/file-type API findings, development
    tooling advisories, 25 unchanged style warnings, model calibration/privacy/quotas
    and production capacity remain operator/follow-up work.
52. **Deviations:** none to core T01–T11 state/provider/security contracts; T12 adds
    verification infrastructure, precise dependency patches and small defect fixes.
53. **Release status:** **READY WITH KNOWN NON-BLOCKING LIMITATIONS**.
54. **T12 completeness:** **complete**; verification is complete, no release was tagged
    or published. Optional/unverified checks and remaining issues are explicit above.
55. **Next step:** review the candidate, run the new workflow remotely, then finalize
    v1.3.0 release/version/snapshot documentation. No next task or release started.

## Final blocker and limitation disposition

The tests found no unresolved cross-user leakage, unauthorized source navigation,
partial-index publication, accepted forged citations, broken idempotency, durable
processing gap, re-embedding during artifact-only rebuild, Redis authority, lost
outbox intent, exposed credentials, failed migration or Phase 1–3 regression.
The shutdown race, page-span contract and production high/critical audit failures
were fixed and verified. T12 does not claim that every possible race or model output
has been exhaustively proven safe.

The final production audit gate passes all four packages. API retains five moderate
findings through `file-type` and four Nest parents. Its ASF/ZIP parsing advisories
are not reached by the current custom upload inspector/PDF pipeline: no
`FileTypeValidator`, `ParseFilePipe` or interceptor importing that parser is used.
This is a source-reachability assessment, not removal of the vulnerable package;
track a compatible Nest/file-type update before adopting those parsers or formats.
See the [ASF advisory](https://github.com/advisories/GHSA-5v7r-6r5c-r473) and
[ZIP advisory](https://github.com/advisories/GHSA-j47w-4g3g-c36v).

Full development-inclusive audits still report API **55** findings (36 high,
16 moderate, 3 low), web **11** (10 high, 1 moderate), database **1 high** and
storage **1 high**. These are tracked tooling-maintenance issues; production audits
are reported separately rather than pretending full audits pass. The 25 existing
web formatting warnings are unchanged. Remote CI, live-model semantic/adversarial
evaluation, full accessibility certification, production throughput/HA and a true
Phase 3 retained-Docker-volume upgrade remain unverified. Local native SQL upgrade,
retained-volume recreation, bounded large fixtures and native fixture-provider
adapters provide narrower evidence, explicitly recorded above.

Operational follow-up includes provider privacy/retention terms, quotas, model
revision pinning, evidence-score calibration, storage/backup capacity and production
TLS. These depend on the selected deployment and corpus. No paid call, data reset,
production deployment, commit, release tag or subsequent task was performed.
