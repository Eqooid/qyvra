# Testing and verification

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
