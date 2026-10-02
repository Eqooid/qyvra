# 13 · Testing and verification

[Guide index](README.md) · [Existing test runbook](../development/testing.md) · [Release evidence](../releases/v1.0.0.md#verification-evidence)

There are several distinct test boundaries. The API's `test:e2e` name means Nest HTTP tests, while web `test:e2e` means real Chromium through Docker/Nginx. Neither should be confused with PostgreSQL integration tests.

## Suite map

| Suite                          | Location/configuration                                                                                    | What it exercises                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| API unit                       | `apps/api/src/**/*.spec.ts`; [package Jest config](../../apps/api/package.json)                           | Service/lifecycle rules, request context/logging, configuration, parser behavior; infrastructure doubles                    |
| API HTTP                       | [apps/api/test](../../apps/api/test), [jest-e2e.json](../../apps/api/test/jest-e2e.json)                  | Nest routing, DTOs/guards/cookies/security/envelopes/Swagger through Supertest; database/use-case doubles as appropriate    |
| API PostgreSQL integration     | `apps/api/test/*.integration-spec.ts`, [jest-integration.json](../../apps/api/test/jest-integration.json) | Real constraints, transaction races, login/refresh/revocation, same-owner associations, upload/version/download persistence |
| Storage unit                   | [keys.test.cjs](../../packages/storage/test/keys.test.cjs)                                                | Generated-key validation and traversal rejection                                                                            |
| Storage filesystem integration | [local.test.cjs](../../packages/storage/test/local.test.cjs)                                              | Real temporary files, concurrent create-only saves, streams, interrupted writes, symlinks and safe errors                   |
| Frontend client/component      | [apps/web/tests](../../apps/web/tests), [vitest.config.ts](../../apps/web/vitest.config.ts)               | Zod/transport behavior and React workflows in jsdom with Testing Library; mocked HTTP                                       |
| Browser acceptance             | [apps/web/e2e](../../apps/web/e2e), [playwright.config.ts](../../apps/web/playwright.config.ts)           | Real Chromium UI/API/database/storage behind Nginx in isolated Compose                                                      |
| Database launcher              | [database-command.test.cjs](../../infrastructure/docker/database-command.test.cjs)                        | URL construction/process-launch contract with Node test runner                                                              |

Unit/HTTP mocks do not validate database SQL. Frontend files named `*.integration.test.tsx` integrate components and client behavior, not a live backend. PostgreSQL and real-browser suites fill those gaps.

## Routine commands

After installing dependencies, run from the repository root:

```sh
npm --prefix packages/storage test
npm --prefix packages/storage run test:integration
npm --prefix apps/api test -- --runInBand
npm --prefix apps/api run test:e2e -- --runInBand
npm --prefix apps/web test -- --maxWorkers=1
node --test infrastructure/docker/database-command.test.cjs
```

API hooks build shared packages first. Jest sets NODE_ENV=test, preventing root `.env` loading. Storage tests use isolated temporary directories; Windows may skip the file-symlink privilege case. Serial frontend execution follows recorded acceptance guidance after earlier parallel timing failures.

Useful focused runs:

```sh
npm --prefix apps/api test -- --runInBand src/modules/documents/document-lifecycle.spec.ts
npm --prefix apps/api run test:e2e -- --runInBand test/versions.e2e-spec.ts
npm --prefix apps/web test -- tests/client.test.ts --maxWorkers=1
```

## Real PostgreSQL integration

Provision a separate disposable PostgreSQL 17 database. Inject its URL as `TEST_DATABASE_URL`, and also as `DATABASE_URL` while deploying migrations:

```sh
npm --prefix packages/database run migrate:deploy
npm --prefix apps/api run test:integration
```

The suite fails without TEST_DATABASE_URL. Never point it to normal developer/production data. Some fixtures roll back, while others commit unique synthetic accounts/documents and clean them up to test concurrency realistically. Read [owner.fixture.ts](../../apps/api/test/owner.fixture.ts) and suite setup/teardown before changing data isolation. No reset command is required. PDF integration paths require qpdf.

Representative files include [session-lifecycle.integration-spec.ts](../../apps/api/test/session-lifecycle.integration-spec.ts) for refresh/replay, [documents.integration-spec.ts](../../apps/api/test/documents.integration-spec.ts) for associations/lifecycle, [upload.integration-spec.ts](../../apps/api/test/upload.integration-spec.ts) for compensation/uncertain commits and [versions.integration-spec.ts](../../apps/api/test/versions.integration-spec.ts) for concurrent numbering, scope, immutability and lifecycle rechecks.

## Browser E2E through Nginx

Install Chromium once with web dependencies installed:

```sh
cd apps/web
npx playwright install chromium
cd ../..
npm --prefix apps/web run test:e2e
```

`npm --prefix apps/web run test:e2e:headed` is the visible-browser variant. [infrastructure/e2e/run.cjs](../../infrastructure/e2e/run.cjs) starts project `qyvra-e2e` on localhost:18080 with separate volumes, generated credentials and a 2 MiB upload limit, executes Playwright, then brings the project down without deleting volumes. Do not run simultaneous suites against that project.

| Browser file                                                    | Actual checks                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [phase-one.spec.ts](../../apps/web/e2e/phase-one.spec.ts)       | Account/profile/password/logout-all; organization/documents/versions; cross-owner isolation; downloaded byte comparisons; container recreation/persistence; a separate access/refresh expiry test |
| [cancellation.spec.ts](../../apps/web/e2e/cancellation.spec.ts) | Active upload abort and partial-storage cleanup                                                                                                                                                   |
| [ui-cleanup.spec.ts](../../apps/web/e2e/ui-cleanup.spec.ts)     | Login and category/tag tables at desktop/mobile sizes in both themes                                                                                                                              |

Playwright is Chromium-only, one worker, no retries. Trace, screenshot and video recording are disabled because artifacts can retain cookies/passwords/private data. The custom reporter is [e2e/reporter.ts](../../apps/web/e2e/reporter.ts). Viewport checks are not physical-device or cross-browser certification. Historical reports mention three acceptance tests at their checkpoint; this checkout also contains the UI cleanup test, so those historical counts are not a fresh full-suite total.

The runner supports `up`, `down`, `logs`, `recreate`, `expiry`, `validate`, `storage-count` and `test`. For example:

```sh
node infrastructure/e2e/run.cjs up
node infrastructure/e2e/run.cjs validate
node infrastructure/e2e/run.cjs logs
node infrastructure/e2e/run.cjs down
```

## Static checks and production builds

All four packages provide `format:check`, `lint`, `typecheck`, and `build`; database additionally provides `validate`. The complete command list is in [the existing test guide](../development/testing.md#formatting-lint-type-checking-and-builds). Common application checks:

```sh
npm --prefix apps/api run format:check
npm --prefix apps/api run lint
npm --prefix apps/api run typecheck
npm --prefix apps/api run build
npm --prefix apps/web run format:check
npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

Database build generates Prisma before compilation. Frontend builds can require network access for existing Google fonts. `format` writes files; `format:check` checks them. There is no root test command or checked-in deployment CI workflow.

## Documentation-only verification

For this guide, compare source paths, routes, DTO fields, environment names/defaults, schema/migrations, scripts and Compose/Nginx behavior; check Markdown links/anchors and Mermaid syntax. Package format scripts target source rather than this docs tree. Use the installed Prettier directly for Markdown if needed. These checks do not require running live migrations or mutating developer data.

Historical passing counts are documented in the [release snapshot](../releases/v1.0.0.md). They are not fresh results from generating this guide. Record actual commands and limitations separately whenever changing code.
