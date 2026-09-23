# Phase 1 acceptance review

## Final acceptance — 23 September 2026

**PASS — Phase 1 usable-tracker scope is complete.** The review below from the
API-foundation stage is historical, not the current application status.

| Area | Classification | Current evidence |
| --- | --- | --- |
| Authentication/account | PASS | Registration/login, cookie persistence, profile/password changes, other-session revocation, logout/logout-all and actual expiry passed real Chromium workflows. |
| Categories/tags | PASS | Owned CRUD, validation, UI assignment, assigned-category deletion conflict and safe tag removal verified. |
| Documents/storage | PASS | List/detail, metadata changes, streaming upload, authorized byte-checked download, cancellation cleanup, archive/restore/soft delete and cross-user rejection verified. |
| Versions | PASS | Initial/additional immutable versions, history/metadata and current-version download verified. |
| Frontend | PASS | Existing forms, loading/errors and confirmations retained; 174 component tests and production build passed. Account settings were checked at mobile/desktop widths in light/dark modes. |
| Compose/Nginx | PASS | Existing images built, migrations completed, services became healthy, Nginx routing worked and data/file bytes survived application-container recreation. |
| Documentation | BUG, fixed | Old status paragraphs incorrectly presented historical missing features and Docker limitations as current blockers. They now point to current results. |
| Later-phase capabilities | OUT OF SCOPE | OCR, AI/search infrastructure, historical-version download, Trash UI, production TLS and deployment automation are not added by this review. |

The current source and Git working trees were inspected. No application-source
changes newer than the successful combined browser run were found in the reviewed
API, web, storage and schema directories. No runtime gap or bug was confirmed.
The repository root has no Git repository; API files and much of the frontend
remain untracked in their nested repositories. Those existing changes were preserved.

This acceptance pass executed `node --test infrastructure/docker/database-command.test.cjs`
(five tests passed) and `docker compose --env-file .env.example config --quiet`
(passed; the sandbox emitted a Docker client-config access warning). Existing
passing lint/typecheck, component, production-build and real-browser results were
reviewed rather than rerun against unchanged code. No dependencies were installed,
images rebuilt, migrations changed, or databases/volumes reset.

See [browser verification and commands](phase-1-browser-verification.md) for the
three passing real-browser tests, isolation design, test commands, exact prior
checks and limitations. See [Compose setup](compose.md) for startup, environment,
migrations, storage and troubleshooting. There are no unresolved Phase 1 blockers.

## Historical API-foundation review

At the time of this earlier review, Phase 1 was **incomplete**. It covered the API
foundation and authentication then present, not an assertion that the target
endpoint catalog has been implemented. No Phase 2 component was introduced.

| Acceptance area                     | Evidence and status                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundation                          | Implemented: strict TypeScript, typed validated configuration, DTO validation, API prefix, envelopes, correlation logging, PostgreSQL lifecycle, health and Swagger. CI remains absent.                                                                                                    |
| Authentication                      | Implemented: atomic local registration, Argon2id login, account lockout, hashed sessions/refresh credentials, safe current profile, expiry/revocation, replay detection, logout, owned-session listing and single/other-session revocation. Ownership tests cover these resources.         |
| Full authentication/profile catalog | Follow-up implemented GET /me, validated profile updates, local password change with atomic other-session revocation, and logout-all including current session. Registration still requires a separate login. Follow-up verification is separate from the historical review results below. |
| Categories/tags and catalog         | Categories and Tags API/schema/tests are implemented; see their follow-up reports. Document schema/endpoints and document lifecycle workflows remain missing.                                                                                                                              |
| Upload/download                     | Missing: storage abstraction/adapter, upload validation/checksums, document/version persistence, authorized streaming download and failure compensation.                                                                                                                                   |
| Versioning                          | Missing. Roadmap acceptance includes immutable versions although the feature catalog labels some version/restore routes MVP+. This inconsistency must not silently waive the acceptance criteria.                                                                                          |
| Deployment                          | PostgreSQL Compose with a persistent named volume exists. API container, Nginx/TLS and object-storage deployment are missing.                                                                                                                                                              |
| Critical workflow tests             | Authentication tests exist; upload, document CRUD, versioning and storage-failure tests cannot pass acceptance because those features do not exist.                                                                                                                                        |

## Historical review (13 September 2026)

The checked-in runtime contains only `AuthModule` and `HealthModule` plus shared
configuration, database, and observability providers. The Prisma schema contains
users, identities, credentials, sessions and consumed refresh-token history; no
category, tag, document or version models exist. Compose starts PostgreSQL only.
The acceptance gaps above are confirmed against the source and remain open.

Verified corrections in this review:

- A new HTTP regression test reproduced missing CORS exposure of `Retry-After` on
  an authentication 429 response. Allowed credentialed browser clients can now read
  the documented retry delay. Rate limits, allowed origins, cookies, and CSRF rules
  are unchanged. Swagger and environment/setup documentation explain the header.
- Removed a duplicate `@param configuration` comment and formatted existing source
  comments without changing their runtime behavior.
- Replaced stale claims that historical passing database tests verified the current
  checkout. Current results appear below; no Phase 1 completion claim is made.

The suspected missing startup configuration diagnostic was **ruled out**: starting
with an empty database URL exits with code 1 and logs the safe validation rule via
Nest before the generic startup-failure event. No change was made to startup error
handling. Existing registration atomicity, session ownership filters, revocation,
refresh row locking/replay history, and safe projections remain implemented.

Remaining inconsistencies: versioning and restoration are labeled MVP+ in the
feature/route catalog but required by MVP acceptance; they remain acceptance gaps.
Health routes are cataloged as internal but publicly reachable until deployment
restrictions exist. The specification's CSRF token wording is broader than the
implemented Origin/custom-header policy documented in `docs/api.md`. These are not
claims that missing deployment, role, or business modules have been implemented.

## Files changed by this review

- `.env.example`, `README.md`, `apps/api/README.md`.
- `docs/api.md`, `docs/roadmap.md`, `docs/phase-1-review.md`.
- `apps/api/src/configure-application.ts`, `apps/api/src/configure-swagger.ts`.
- `apps/api/src/common/http-security.ts`, `apps/api/test/security.e2e-spec.ts`.
- Formatting only: `apps/api/src/app.controller.ts`, `apps/api/src/app.service.ts`,
  `apps/api/src/common/request-context.ts`, `apps/api/src/common/structured-logger.ts`.

## Database migrations and setup

No schema changes or new migrations in this review. Existing history is preserved:

1. `20260910080000_authentication_schema`
2. `20260910090000_login_metadata`
3. `20260910150000_session_last_seen`
4. `20260910160000_refresh_rotation`

Deploy all four to the intended database using `migrate:deploy`. Tests must use a
separate migrated database. Integration tests create and clean up random owned
fixtures; they are not all read-only. Never reset or delete an existing database.

## Known limitations and remaining order

Rate limits are per process and use socket peers; proxy clients share a budget.
Add shared edge throttling before replicas. Registration's 201/409 contract reveals
address availability; login responses stay generic. Session/consumed-hash cleanup
is not implemented. Retain consumed history while a session is renewable. Refresh
replay revokes the whole session, so clients must serialize calls. Health readiness
checks connectivity, not migration status. Production requires TLS/Secure cookies;
Swagger/health are public and deployment access controls are not configured.

The prior dependency audit reported 24 findings (8 high, 12 moderate, 4 low).
Those historical counts were not re-audited during this review. Framework/transitive
remediation needs a tested upgrade; none
of the HTTP controls is a substitute for it. No claim of public-production readiness.

Complete the missing Phase 1 features in small vertical tasks: category/tag schema
and owned CRUD; document/version
schema; storage and upload validation; catalog operations; authorized downloads;
version/restore workflows; deployment and CI; then repeat acceptance verification.
Do not start queues, Redis, extraction, reminders, search or AI in this review.

## Historical verification (13 September review)

The authentication/profile follow-up below supersedes the database-environment
blocker in this historical table; unrelated Phase 1 acceptance gaps remain open.

Commands use `npm.cmd` on Windows and the independent package directories below.
The new CORS regression failed before the fix with only the two correlation headers
exposed. The corrected test passed in the full end-to-end suite.

| Directory           | Command                                                                                        | Current result                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/database` | `npm run validate`, `npm run generate`                                                         | Passed                                                                                                     |
| `packages/database` | `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build` | Passed                                                                                                     |
| `apps/api`          | `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`                  | Passed                                                                                                     |
| `apps/api`          | `npm test -- --runInBand`                                                                      | 140 tests passed, 10 suites                                                                                |
| `apps/api`          | `npm run test:e2e -- --runInBand`                                                              | 80 tests passed, 8 suites                                                                                  |
| `apps/api`          | `npm run test:integration`                                                                     | Failed: 42 tests failed due to missing isolated database configuration; 1 unavailable-database test passed |
| `apps/api`          | `npm run build`                                                                                | Passed, including shared database build                                                                    |
| Root                | `docker compose --env-file .env.example config --quiet`                                        | Passed with safe temporary PostgreSQL placeholders and port; Docker config access warning                  |
| Root                | `docker version --format '{{.Server.Version}}'`                                                | Failed: Docker Linux engine unavailable, including outside the sandbox                                     |

No dependency audit, real database migration deployment, restore test, or live
production deployment was performed. The prior dependency audit remains historical.

Database integration tests require a separate migrated `TEST_DATABASE_URL`. Docker's
Linux engine was unavailable during this review, so no isolated test container could
be created. No development/production database, user record, or persistent volume
was changed. Compose validation used temporary placeholder initialization values
and port 5432; it does not prove database connectivity or migration status.

To finish environment verification: start Docker Desktop's Linux engine, provision
a separate test database, inject its URL for `migrate:deploy`, then inject
`TEST_DATABASE_URL` for `npm --prefix apps/api run test:integration`. Follow the API
README; do not reset or delete an existing database. Configure root `.env` for the
API, replace/remove optional placeholders, deploy the four existing migrations,
and set exact browser origins plus credentialed CORS before using the web client.

**Not ready for Phase 2.** Even a passing database run would not satisfy the missing
Phase 1 upload, catalog, versioning, download, deployment and workflow-test criteria.

## Authentication/profile follow-up (14 September 2026)

The interrupted task added only GET /api/v1/me, PATCH /api/v1/me,
PATCH /api/v1/me/password and POST /api/v1/auth/logout-all. GET /auth/me remains
compatible. On resumption, implementation, DTO validation, Swagger and all three
test layers were already present. Remaining work was real PostgreSQL verification,
the final production build, and reconciling stale documentation. No runtime rewrite
was necessary after the resumed checks. Git metadata was unavailable in the supplied
workspace, so the file review used the task history and current source directly.

Password changes reuse Argon2id, the configured password policy and login throttle;
credential updates and other-session revocations commit together. Current and foreign
sessions remain active. Logout-all includes the current session and clears matching
cookies; a revoked-cookie retry returns 401 without additional effects. Profile fields
are validated and ownership comes from the authenticated internal user ID.

Verification on the final implementation:

| Directory         | Command                                                                   | Result                                                          |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| packages/database | npm run validate                                                          | Passed                                                          |
| packages/database | npm run build (includes generate)                                         | Passed through API build/pretest hooks                          |
| packages/database | npm run migrate:deploy                                                    | Four existing migrations applied only to isolated PostgreSQL 17 |
| apps/api          | npm run format; npm run format:check                                      | Passed                                                          |
| apps/api          | npm run lint                                                              | Passed                                                          |
| apps/api          | node_modules/.bin/tsc --noEmit --incremental false                        | Passed                                                          |
| apps/api          | node_modules/.bin/jest --runInBand --silent                               | 151 tests, 11 suites passed                                     |
| apps/api          | node_modules/.bin/jest --config ./test/jest-e2e.json --runInBand --silent | 114 tests, 9 suites passed                                      |
| apps/api          | npm run test:integration                                                  | 51 tests, 8 suites passed                                       |
| apps/api          | npm run build                                                             | Passed                                                          |

Windows commands used the .cmd executables. Integration tests ran against a separate
temporary PostgreSQL container on loopback, with temporary in-memory data and no
existing volumes. Tests cover actual Argon2id hash changes, rollback after injected
revocation failure, safe responses, profile ownership, other-session revocation,
foreign-session preservation, and logout-all retries. The test container was stopped
after verification. No development database or real credentials were used.

Files in this task:

- New: apps/api/src/modules/auth/profile.controller.ts, profile.dto.ts,
  profile.service.ts and profile.service.spec.ts.
- New: apps/api/test/profile.e2e-spec.ts and profile.integration-spec.ts.
- Updated: apps/api/src/modules/auth/auth.module.ts and request-security.ts;
  apps/api/src/common/http-security.ts; apps/api/src/configure-swagger.ts;
  apps/api/test/security.e2e-spec.ts.
- Documentation: apps/api/README.md, docs/api.md, docs/database.md,
  docs/specification.md, docs/roadmap.md and this report. Resumption corrected only
  docs/api.md, docs/roadmap.md and this report, and finished verification.

No schema changes, new migrations, dependencies or environment variables were
required. Existing migration history, cookie names and authentication issuer remain
unchanged. Deploy the existing four migrations to the intended database if pending,
then rebuild/restart the API to expose the new routes in Swagger. Profile UI work and
all unrelated roadmap features were outside this task. This completes the requested
API authentication/profile task, not the full Phase 1 document-management MVP.

## Categories follow-up (14 September 2026)

Categories alone is now complete and verified: 158 unit tests, 58 PostgreSQL
integration tests and 148 HTTP tests passed, along with Prisma checks, formatting,
linting, type checking and the API build. Migration 20260914010000_categories adds
owned categories without modifying authentication history or behavior. See the
[Categories implementation report](categories-implementation.md) for files, commands
and the permanent-deletion limitation. The roadmap checklist records remaining
Phase 1 work; Tags is next and has not been started.

## Tags follow-up

Tags alone is now complete and verified: 165 unit tests, 66 PostgreSQL integration
tests and 179 HTTP tests passed, alongside Prisma checks, formatting, linting, type
checking and the production build. Migration 20260914030000_tags adds owned tags.
Categories utilities and the test-owner fixture were shared without changing
authentication behavior. See [Tags implementation report](tags-implementation.md)
for exact files, commands and deferred document-join cleanup. Document metadata and
CRUD is next; it has not been started.
