# QYVRA branding migration

> Application branding checkpoint, completed before the Docker follow-up. The
> retained Docker names and verification limits below describe that checkpoint.
> See [Docker rename and current resource mappings](docker-rename.md) for the
> subsequent infrastructure changes and verification.

QYVRA means **Query Yielding Vault Recall Assistant**. The product was formerly
known as Brainless. This migration changes branding only, including browser titles,
auth screens, navigation, API name/OpenAPI metadata, current documentation and
agent instructions. Independent npm packages now use `@qyvra/*`; all local imports
and the four lockfiles change together, without dependency-version changes.
Temporary inspection/test directories, the storage injection symbol description,
and the container-local worker readiness file also use `qyvra`. The worker and
Compose healthcheck both use `/tmp/qyvra-worker-ready`.

## Compatibility and infrastructure

No routes, DTOs, cookies, ownership rules, tables, columns, migrations, processing
contracts, service keys, ports, mounts or volumes change. Worker/outbox runtimes
remain in `apps/api`; no new runtime application is introduced. There are no
checked-in CI/CD workflows, Elasticsearch indexes or Qdrant collections to rename.
Nginx routes and upstreams remain unchanged.

At this checkpoint, remaining source references to `brainless` fell into these categories:

| Category | Retained references | Reason |
| --- | --- | --- |
| Backward compatibility | `POSTGRES_USER=brainless`, `POSTGRES_DB=brainless`, connection examples and private `.env` values | Preserve database initialization and access to existing data. |
| Backward compatibility | RabbitMQ user default `brainless`; exchanges/queues `brainless.processing.v1`, `brainless.processing.execute.v1`, `brainless.processing.dead.v1`, `brainless.processing.dead.execute.v1` | Preserve broker credentials, bindings and queued messages. |
| Backward compatibility | Redis `brainless:processing:progress:{jobId}:{attempt}` and related tests | Preserve progress access, including mixed-version processes. |
| Backward compatibility | `/data/brainless`, host `C:/BrainlessData`, `brainless_backup`, backup commands and leak-check assertions | Preserve file access, operational commands and existing backup volumes. |
| Backward compatibility | Compose namespace examples `brainless`; E2E projects `brainless-e2e*`, `.tools/brainless-e2e.env`, database/user `brainless_e2e` | Preserve volume selection, generated credentials and existing test commands. |
| Backward compatibility | `docs/developer/16-extending-brainless.md` and links | Preserve published documentation links; its visible title uses QYVRA. |
| Historical documentation | v1.0.0/v1.1.0 release snapshots, earlier branding checkpoint, recorded verification image/project/database names, and former-name explanations | Keep release and verification history accurate. |
| External repository/manual migration | `https://github.com/Eqooid/brainless.git` and corresponding `cd brainless` instructions | The new hosting URL has not been confirmed; Git remotes are untouched. |
| Generated/local/third-party | Ignored dependency installations, build/test artifacts, tool files and Git history | Rebuild/reinstall generated output; do not rewrite dependencies or history. Private configuration stays unchanged. |

Existing `document_tracker_*` cookies and `document-tracker-auth:*` browser
synchronization identifiers also remain unchanged to preserve active sessions and
coordination with existing tabs.

Compose derives generated image/container/network/volume names from the project
namespace. Before moving an existing checkout to a `qyvra` directory, set
`COMPOSE_PROJECT_NAME` in its existing `.env` to its **previous** project namespace
(usually `brainless`), or keep using the same `docker compose -p` argument.
Preserve an already configured project name. Do not rename or delete volumes.
Fresh checkouts may use `qyvra`; changing the namespace of an existing installation
requires a separate reviewed infrastructure migration.

## Deployment and manual follow-up

Reinstall the local API links after pulling the package rename:
`npm --prefix apps/api install`. The existing Docker builds use `npm ci` and
rebuild the shared packages automatically. Rebuild/redeploy API, web, outbox and
worker together to apply the branding and readiness filename. An explicit old
`APP_NAME` environment override still wins; operators may set it to `QYVRA API`.

Repository hosting rename to `qyvra`, Git remote updates, confirmed clone URLs,
external registries, deployment configuration and any external DNS/domain branding
remain operator tasks. No secrets or runner configuration were renamed. Existing
database migrations require no branding migration and must not be reset.

## Verification

Verification on 2 October 2026 used Node 24.9.0 and npm 11.6.2 on Windows.
Historical verification reports describe their original runs and are not claims
about this change. All npm commands used `npm.cmd` on this host.

| Check | Command/result |
| --- | --- |
| Installation | `npm --prefix <package> install --ignore-scripts --offline --no-audit --no-fund` passed for storage, database and web. API offline install lacked a cached registry response; `npm --prefix apps/api install --ignore-scripts --no-audit --no-fund --prefer-offline --fetch-retries=0 --fetch-timeout=15000` passed with network access. |
| Local packages | `npm --prefix apps/api ls @qyvra/database @qyvra/storage --depth=0` passed. Parsed comparison of all four lockfiles confirms unchanged dependency graphs. |
| Builds | `npm --prefix apps/api run build`, `npm --prefix apps/web run build`, and both shared-package builds passed. API build includes compiled worker/outbox entry points. Web build initially could not fetch Google Fonts; retry with network access passed. |
| Type checking/lint | `run typecheck` and `run lint` passed in all four packages. |
| Formatting | API/storage `run format:check` and targeted Prettier checks of changed web files passed. Whole-web check reports pre-existing formatting issues in unrelated files. Database `run format:check` reports an unchanged Prisma schema formatting issue; no schema or migration files were edited. |
| API unit tests | `npm --prefix apps/api test -- --runInBand`: 253 passed, 1 skipped, 28 suites passed. |
| API HTTP tests | `npm --prefix apps/api run test:e2e -- --runInBand`: 281 passed, 15 suites passed; includes startup/health tests with database doubles and QYVRA metadata assertions. |
| Frontend tests | Default fork-worker runs stalled and were stopped. `npm --prefix apps/web test -- --maxWorkers=1 --pool=threads --reporter=verbose` passed all 201 tests in 18 files, including the login/sidebar branding assertions. No test configuration was changed. |
| Storage | `npm --prefix packages/storage test`: 3 passed. `run test:integration`: 11 passed, 1 Windows file-symlink privilege skip. |
| PostgreSQL integration | `npm --prefix apps/api run test:integration` failed because isolated `TEST_DATABASE_URL` was absent (configuration rejects the missing database URL); 130 failed, 16 skipped, 1 passed. No developer database was used. |
| Compose config | Base, base + `docker-compose.dev.yml`, and base + `infrastructure/e2e/compose.yml` all passed `docker compose --env-file .env.example ... config --quiet`. |
| Docker contract test | `node --test infrastructure/docker/database-command.test.cjs`: 4 passed, 1 pre-existing failure. The unchanged test expects five Phase 1 services while the current Compose has nine. |
| Frontend startup | `npm --prefix apps/web run start -- --hostname 127.0.0.1` on temporary port 13000 started. `/login` returned HTTP 200 with `Log in \| QYVRA` and no old branding. The temporary server was stopped. |
| Documentation/search | 369 relative file links in changed Markdown checked; `git diff --check` passed. Final case-insensitive source search has only the retained categories above; no accidental old-brand leftovers. |

Docker's Linux engine was unavailable, including outside the sandbox. Full Compose
startup, real API/database readiness, worker/outbox startup, RabbitMQ/Redis connectivity,
browser E2E and the isolated migration-upgrade test remain unverified here. No
existing deployment services or volumes were stopped, reset or deleted. Rerun
those checks with Docker and isolated test databases using the existing
[testing guide](development/testing.md).
