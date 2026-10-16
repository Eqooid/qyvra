# Testing and verification

The [T11 acceptance matrix](../phase-5-verification.md) is the current Phase 5
readiness record: NOT READY, with reused versus fresh evidence, formatting debt,
dependency findings and mandatory live/quality/CI gates. Updated Phase 5 CI now
includes T10 upgrade/maintenance/CLI and a mocked-API production Chromium job.
That browser configuration starts its server; it does not replace live Nginx E2E.

Phase 5 [T10 maintenance evidence](../phase-5-search-operations.md#verification-ledger)
separates recovered results from continuation checks. Native PostgreSQL tests use
real transactions with simulated Elasticsearch; the separately gated maintenance
live suite needs real Elasticsearch and a disposable migrated database. Neither
proves RabbitMQ restart/outage behavior. Do not repeat completed backfills or
reset volumes as a test prerequisite.

Phase 5 T09 frontend and mocked-API Chromium commands/evidence are recorded in
[the search frontend guide](../phase-5-search-frontend.md#verification-evidence).
The separately gated live search browser fixture requires an isolated configured
Phase 5 Nginx stack; mocked browser checks do not replace that acceptance gate.

[Documentation index](../README.md) | [Local setup](getting-started.md)

All commands run from the repository root after dependency installation. Choose
checks that exercise changed behavior. Report new results separately from the
[recorded release evidence](../releases/v1.0.0.md#verification-evidence) and the
[v1.1.0 acceptance snapshot](../releases/v1.1.0.md#acceptance-evidence).

## Unit, HTTP and component tests

```sh
npm --prefix packages/storage test
npm --prefix packages/storage run test:integration
npm --prefix apps/api test -- --runInBand
npm --prefix apps/api run test:e2e -- --runInBand
npm --prefix apps/web test -- --maxWorkers=1
node --test infrastructure/docker/database-command.test.cjs
```

Storage tests use isolated temporary directories. A Windows file-symlink case can
skip without the required privilege; the historical Linux run covers it. API unit
and HTTP (`test:e2e`) suites use test doubles for PostgreSQL; they do not verify
SQL constraints. Vitest/Testing Library tests use mocked HTTP at the client boundary.
Serial frontend execution matches the recorded acceptance run, which resolved two
parallel timing failures. Jest sets `NODE_ENV=test`, disabling API root `.env` loading.

## PostgreSQL integration

Phase 5 [T02 persistence/contracts](../phase-5-data-foundation.md) adds:

```sh
npm --prefix packages/database run build
npm --prefix packages/database run test:search
npm --prefix packages/database run test:search:migration
```

The first suite needs migrated `TEST_DATABASE_URL`. The migration suite needs a
separate **empty, disposable** `TEST_SEARCH_MIGRATION_DATABASE_URL` whose database
name contains `test`; it applies the v1.3.1 chain, seeds synthetic prior records,
deploys T02 and verifies preservation/no enrollment. It does not reset a database.
API `search-contracts.integration-spec.ts` exercises real SQL outbox delivery
with a publisher double and verifies that absent search handlers do not execute
work; this is not live RabbitMQ certification. CI supplies separate upgrade
databases and retains its existing broker/service test gates.

Provision a separate disposable PostgreSQL database. Inject its URL as both
`TEST_DATABASE_URL` and, for migration deployment only, `DATABASE_URL`:

```sh
npm --prefix packages/database run migrate:deploy
npm --prefix apps/api run test:integration
```

The integration command intentionally fails when `TEST_DATABASE_URL` is absent.
It must never point at developer or production data. Tests cover real constraints,
transactions, ownership, auth rotation and upload/version persistence. Some fixtures
roll back transactions; others commit unique synthetic records and clean them up.
No database reset is part of the workflow. PDF inspection tests need host qpdf.

The v1.1.0 upgrade test requires a separate **empty, disposable** database whose
name contains `test`. Supply it as `TEST_MIGRATION_DATABASE_URL`, then run
`npm --prefix packages/database run test:migration`. The test applies Phase 1
migrations, inserts representative existing rows, deploys the description
migration, and verifies preserved values and constraints. Never point it at a
developer or production database.

## Real browsers through Nginx

The Docker rename creates a new isolated `qyvra-e2e` project with fresh test
volumes and `.tools/qyvra-e2e.env`. Old test data remains in the old volumes;
see [migration and cleanup](../docker-rename.md).

Requires running Docker Linux containers, installed web dependencies, and Chromium:

```sh
cd apps/web
npx playwright install chromium
cd ../..
npm --prefix apps/web run test:e2e
```

`test:e2e:headed` is the visible-browser alternative. The runner builds/starts the
isolated `qyvra-e2e` Compose project at http://localhost:18080, uses separate
volumes and generated credentials, then stops it without deleting volumes. Do not
run tests concurrently against that project. Full commands, artifact rules and
focused runs are in [browser verification](../phase-1-browser-verification.md).
This is separate from the API's similarly named `test:e2e` script.

If a retained E2E PostgreSQL volume has credentials from an older generated
`.tools/qyvra-e2e.env`, migration startup fails with `P1000`. Preserve the old
volume and select a fresh isolated Compose project instead. In PowerShell, set
`$env:E2E_PROJECT_NAME='qyvra-e2e-v11'` before running `test:e2e`; use the same
setting for `node infrastructure/e2e/run.cjs down`. The default project name remains
`qyvra-e2e`. Keep port 18080 free; do not run both projects simultaneously.

## Formatting, lint, type checking and builds

Each of the four packages provides `format`, `format:check`, `lint`, `typecheck` and
`build`. `format` writes files; `format:check` checks them. Run from the root:

```sh
npm --prefix packages/storage run format:check
npm --prefix packages/storage run lint
npm --prefix packages/storage run typecheck
npm --prefix packages/storage run build
npm --prefix packages/database run validate
npm --prefix packages/database run format:check
npm --prefix packages/database run lint
npm --prefix packages/database run build
npm --prefix packages/database run typecheck
npm --prefix apps/api run format:check
npm --prefix apps/api run lint
npm --prefix apps/api run typecheck
npm --prefix apps/api run build
npm --prefix apps/web run format:check
npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

Database build generates Prisma before compiling. API lifecycle hooks build shared
packages automatically; avoid redundant rebuilds during focused work. Tests are not
a substitute for a production build after runtime changes. Frontend builds may need
network access for fonts. No root test script or checked-in CI/CD workflow exists.

For infrastructure edits, use the [Compose checks](../compose.md#focused-smoke-check-once-docker-is-running).
For documentation-only changes, verify Markdown links/anchors, referenced files,
commands against package scripts and configuration, environment examples and claims
against source. Existing package formatter scripts target source, not this docs tree;
there is no dedicated documentation lint/link script yet. Do not rerun expensive
application workflows merely to restate unchanged release evidence.

Phase 5 [T03 verification and limitations](../phase-5-search-enrollment.md#verification-and-acceptance)
include real SQL enrollment/rollback/fencing/fanout, T02-to-T03 migration,
application lifecycle hooks and simulated transport failures. Run database
`test:search:enrollment` with a migrated disposable `TEST_DATABASE_URL`, and
`test:search:enrollment:migration` with a separate empty disposable
`TEST_SEARCH_ENROLLMENT_MIGRATION_DATABASE_URL`. API `search-enrollment.integration-spec.ts`
uses real PostgreSQL and a simulated publisher; it is not a live broker test.
Both enrollment settings must match between API and outbox. CI adds these checks
to the existing Phase 4 workflow; local execution does not claim CI passed.

Phase 5 [T04 adapter/deployment verification](../phase-5-elasticsearch.md#verification-and-acceptance)
adds `elasticsearch-{store,transport,configuration}.spec.ts`, isolated live ES
integration tests and private Compose contracts. The HTTP transport fixture is
not an Elasticsearch server. Run `node --test infrastructure/test/search-compose.test.cjs`
without an engine; run `node infrastructure/test/search-runtime.cjs` only with
a Linux Docker engine to test API/worker connectivity and retained data after
restart in a uniquely named disposable project. Live checks are not substituted
by mocks. The Phase 5 workflow automates these commands; local work does not
claim that CI has passed.

Phase 5 [T05 publication evidence](../phase-5-lexical-publication.md#verification-evidence-and-acceptance-gate)
adds deterministic lexical projection/visibility tests and
`apps/api/test/search-publication.integration-spec.ts`. Run it with a migrated
**disposable** TEST_DATABASE_URL; the ordinary cases use real PostgreSQL and the
existing isolated PDF parser with simulated Elasticsearch. On Linux, build the
existing PDF sandbox first. The optional real-ES case additionally requires
TEST_ELASTICSEARCH_URL and isolated administrative test credentials (optional CA).
It cleans only its own compatible generation indexes. The private runtime harness
includes that case when TEST_DATABASE_URL is set. This integration test does not
establish live RabbitMQ delivery or the full upload-through-Compose workflow.

Phase 5 [T06 keyword verification](../phase-5-keyword-search.md#verification-and-outstanding-gates)
adds keyword service/configuration unit tests, keyword HTTP E2E and
`keyword-search.integration-spec.ts`. The integration suite uses actual PostgreSQL,
canonical PDF parsing, T05 publication and SQL sessions/HTTP; ordinary cases simulate
Elasticsearch. Explicit TEST_ELASTICSEARCH_URL/credentials enable its isolated live
matching case. Keep API and database regression processes in separate disposable
databases if run concurrently: serving generations and recovery scans are global.
The private search harness/CI include the keyword suites; adding CI wiring is not
evidence of a successful live workflow or remote CI run. Cursor acceptance is T07.

## Phase 5 T07 fusion and windows

[T07 evidence and limits](../phase-5-hybrid-search.md#verification-and-acceptance)
distinguish local doubles, real SQL and optional live services. API unit tests include
`hybrid-search.service`, `search-ranking`, `search-window.store` and unchanged
semantic/provider regressions. The keyword SQL integration suite adds READY semantic
manifest/fusion/lifecycle cases; it simulates remote stores/query embeddings.
`TEST_REDIS_URL` enables the actual Redis quota/round-trip case. Never use production
Redis: cleanup removes only random test payloads and its own quota members.
A fresh disposable database applied all 17 migrations; do not run global serving
selection/recovery suites concurrently against the same database. Live acceptance
still requires compatible Elasticsearch/Qdrant/Redis and actual query embeddings.

## Phase 5 T08 evidence, suggestions and source reads

[T08 contracts and actual verification](../phase-5-search-evidence.md#verification-and-remaining-gates)
cover safe-highlight/parser cases, private suggestion tests, exact page-source
service/HTTP bounds, and keyword/hybrid regressions. Native PostgreSQL tests use
real immutable extraction/publication state and session guards with simulated ES;
these are not live highlighting tests. The optional ES case verifies actual ranges
and private prefix queries only when TEST_ELASTICSEARCH_URL is available.
No fixture may rewrite a verified published manifest. Create separate unpublished
extraction records for negative source tests; preserve the database immutability guards.

## Phase 5 continuation evidence

Reuse the [live verification ledger](../phase-5-live-verification.md) before
running expensive tests. The [proposed 30-query corpus](../phase-5-search-quality.md)
requires owner judgment/budget approval and measured execution; preparation is
not a passing quality gate.
