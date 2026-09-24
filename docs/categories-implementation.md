# Categories implementation and Phase 1 audit

> Historical implementation checkpoint. Scope, test counts, file locations and pending
> work below describe that task, not current release status. Phase 1 is complete;
> use the [v1.0.0 snapshot](releases/v1.0.0.md) and [current guides](README.md) for the baseline.

Completed 14 September 2026. This task audited the remaining usable-tracker scope
and implemented Categories only. Authentication/profile code and frontend code
were preserved. Git metadata was unavailable in the supplied workspace; inspection
used current source, documentation and prior verification evidence.

## Audit and scope

Already present: API foundation, configuration/health/logging, shared Prisma and
PostgreSQL lifecycle, persistent PostgreSQL Compose service, authentication/profile
and session management, and the Next.js authentication/dashboard shell. Categories,
tags, document models, storage/upload/download, immutable versions, checksums,
document lifecycle, document pages, Nginx and full application Compose deployment
were absent. Authentication verification remained green after category integration.
The complete checked/unchecked list and dependency order are in [the roadmap](roadmap.md).

## Delivered contract

- GET /api/v1/categories: owned UUID-ordered cursor pages, default 25 and maximum 100.
- POST /api/v1/categories: normalized names and optional safe color/icon styling.
- PATCH /api/v1/categories/:categoryId: owned nonempty partial updates.
- DELETE /api/v1/categories/:categoryId: permanent deletion of unused owned categories.

Every route requires the existing session guard. Mutations enforce the existing
Origin/custom-header CSRF policy through a category guard. Ownership is never taken
from request fields. Foreign/missing IDs return identical 404 responses; duplicate
owned names return 409. Public fields exclude owner IDs and internal metadata.
The common envelope interceptor recognizes an explicit PaginatedData result to
implement the documented list shape; ordinary/authentication responses are unchanged.
Swagger covers all routes. See [API contract](api.md) for exact validation and envelopes.

Names preserve case after NFKC/whitespace normalization, with per-user uniqueness
enforced by PostgreSQL lower(name). Its database locale defines case conversion;
accent folding is not promised. Optional color/icon can be cleared with null.
Icons are safe slugs, not executable markup or URLs.

## Migration and setup

New migration: packages/database/prisma/migrations/20260914010000_categories/migration.sql.
It creates only categories, its owner foreign key, ownership/pagination index,
case-insensitive expression unique index and name/color/icon CHECK constraints.
Earlier migrations were not edited. No reset, destructive migration, dependency
or environment variable was introduced.

Apply pending migrations to the intended database before starting the updated API:

```sh
# Inject DATABASE_URL for the intended database into this process first.
npm --prefix packages/database run migrate:deploy
npm --prefix apps/api run build
npm --prefix apps/api run start:prod
```

The verification run applied all five migrations only to an isolated PostgreSQL 17
container with temporary in-memory data and loopback access. The container was
stopped after verification. Existing databases, volumes and .env values were untouched.

## Files changed

- packages/database/prisma/schema.prisma
- packages/database/prisma/migrations/20260914010000_categories/migration.sql
- packages/database/README.md
- apps/api/src/modules/categories/categories.module.ts
- apps/api/src/modules/categories/categories.controller.ts
- apps/api/src/modules/categories/categories.dto.ts
- apps/api/src/modules/categories/categories.service.ts
- apps/api/src/modules/categories/category-mutation.guard.ts
- apps/api/src/modules/categories/categories.service.spec.ts
- apps/api/test/categories.e2e-spec.ts
- apps/api/test/categories.integration-spec.ts
- apps/api/src/common/paginated-data.ts
- apps/api/src/common/http-envelope.ts
- apps/api/src/app.module.ts
- apps/api/src/configure-swagger.ts
- apps/api/README.md
- docs/api.md
- docs/database.md
- docs/roadmap.md
- docs/phase-1-review.md
- docs/categories-implementation.md

## Verification

Commands below ran from the indicated directory using Windows .cmd executables.

| Directory         | Command                                                                   | Final result                                      |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| packages/database | npm run format; npm run format:check                                      | Passed                                            |
| packages/database | npm run validate                                                          | Passed                                            |
| packages/database | npm run generate; npm run build (through API hooks)                       | Passed                                            |
| packages/database | npm run migrate:deploy                                                    | Five migrations applied to isolated PostgreSQL 17 |
| packages/database | npm run lint                                                              | Passed                                            |
| apps/api          | npm run format; npm run format:check                                      | Passed                                            |
| apps/api          | npm run lint                                                              | Passed                                            |
| apps/api          | node_modules/.bin/tsc --noEmit --incremental false                        | Passed                                            |
| apps/api          | node_modules/.bin/jest --runInBand --silent                               | 158 tests / 12 suites passed                      |
| apps/api          | npm run test:integration                                                  | 58 tests / 9 suites passed                        |
| apps/api          | node_modules/.bin/jest --config ./test/jest-e2e.json --runInBand --silent | 148 tests / 10 suites passed                      |
| apps/api          | npm run build                                                             | Passed, including shared database build           |

Added 7 unit, 7 database integration and 34 HTTP tests. Coverage includes required
authentication, safe styling, invalid/unsupported input, normalization, concurrent
duplicate creation, cross-owner name reuse, safe projections, bounded pagination,
updates, null styling, deletion/name reuse, foreign/missing isolation, SQL uniqueness,
foreign keys, CHECK constraints, CSRF and Swagger. Existing auth/profile suites pass.

An initial integration run exposed incorrect timestamps in the new synthetic session
fixture; the fixture was corrected to satisfy the existing last-seen constraint.
A repeated HTTP run encountered setup timeouts; rerunning separately passed the full
suite in 25.5 seconds with the same timeouts and no authentication code changes.

## Limitations and next task

Categories use permanent deletion, not soft deletion. No document relationship is
implemented yet, so every category is currently unused. There is no reassignment
placeholder. The document task must introduce restrictive references and safe
owner-checked unused/reassignment semantics before referenced categories can be
deleted. Prisma cannot model the expression index: preserve the migration SQL.
The icon slug does not guarantee a frontend icon exists; a later UI needs safe mapping
and fallback behavior. No category frontend was requested or added.

Categories is complete for this scope. Phase 1 remains incomplete; all later items
remain unchecked. The recommended next task is Tags, and it was not started.
