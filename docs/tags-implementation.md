# Tags implementation and verification

> Historical implementation checkpoint. Scope, test counts, file locations and pending
> work below describe that task, not current release status. Phase 1 is complete;
> use the [v1.0.0 snapshot](releases/v1.0.0.md) and [current guides](README.md) for the baseline.

Tags is implemented as a Phase 1 API feature. No Documents, document joins, storage,
frontend tag pages, or later roadmap features were added.

## Contract and storage

- GET /api/v1/tags lists/searches only the authenticated user's tags.
- POST /api/v1/tags creates a tag and returns 201.
- PATCH /api/v1/tags/:tagId renames an owned tag and returns 200.
- DELETE /api/v1/tags/:tagId permanently deletes an owned tag and returns 200
  with the standard deleted acknowledgement. Missing/foreign/deleted IDs return 404.

Safe fields are id, name, createdAt and updatedAt. Every operation derives ownership
from the existing session guard and includes that owner in persistence predicates.
Mutations retain the existing Origin/custom-header CSRF policy. Unsupported fields
are rejected. Database uniqueness and missing-row outcomes map to generic 409/404;
unexpected infrastructure details are suppressed.

The shared Categories policy normalizes names using NFKC, trimming and collapsed
whitespace, preserves display case, and validates 1-100 Unicode code points. The
PostgreSQL unique expression index on (user_id, lower(name)) enforces per-user
case-insensitive uniqueness. Different users can use the same name. Database locale
rules define case conversion; accent folding is not promised.

Lists reuse default limit 25, maximum 100, ascending UUID order and exclusive UUID
cursor, with data as an array and meta containing requestId, nextCursor and hasMore.
Optional q applies normalized, case-insensitive literal-substring search. Blank q is
invalid; omit it for all owned tags. SQL wildcard characters are escaped. Keep the
same search/order when following cursors. Full contracts are in [api.md](api.md).

The new Prisma Tag model has UUID id, owner userId, name and creation/update
timestamps. Migration 20260914030000_tags creates only tags, the restrictive owner
foreign key, ownership/cursor index, unique expression index and name CHECK constraint.
No previous migration was edited. No DocumentTag model or soft-delete column exists.

## Reuse and compatibility

Categories name normalization, cursor validation and mutation guard were extracted
unchanged into shared common utilities. Categories keeps its public normalization
and guard aliases. The existing integration test-owner setup was extracted into
owner.fixture.ts and reused by Categories and Tags. No authentication runtime code
or frontend code was changed. Existing Categories/authentication suites still pass.

A Tags Swagger regression test exposed a missing inherited limit query parameter.
Adding an explicit Number type to the shared pagination decorator fixed the schema
without changing runtime pagination. A later HTTP run hit an unchanged authentication
setup timeout; the full suite passed when rerun separately with unchanged timeouts.

## Files changed

- packages/database/prisma/schema.prisma
- packages/database/prisma/migrations/20260914030000_tags/migration.sql
- packages/database/README.md
- apps/api/src/modules/tags/tags.module.ts
- apps/api/src/modules/tags/tags.controller.ts
- apps/api/src/modules/tags/tags.dto.ts
- apps/api/src/modules/tags/tags.service.ts
- apps/api/src/modules/tags/tags.service.spec.ts
- apps/api/src/common/normalize-owned-name.ts
- apps/api/src/common/cursor-query.ts
- apps/api/src/common/owned-mutation.guard.ts
- apps/api/src/modules/categories/categories.dto.ts
- apps/api/src/modules/categories/category-mutation.guard.ts
- apps/api/src/app.module.ts
- apps/api/src/configure-swagger.ts
- apps/api/test/owner.fixture.ts
- apps/api/test/categories.integration-spec.ts
- apps/api/test/tags.e2e-spec.ts
- apps/api/test/tags.integration-spec.ts
- apps/api/README.md
- docs/api.md
- docs/database.md
- docs/specification.md
- docs/roadmap.md
- docs/phase-1-review.md
- docs/tags-implementation.md

## Verification

Commands ran with Windows .cmd executables from the indicated directories.

| Directory         | Command                                                                   | Final result                                         |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| packages/database | npm run format; npm run format:check                                      | Passed                                               |
| packages/database | npm run validate                                                          | Passed                                               |
| packages/database | npm run generate; npm run build (through API hooks)                       | Passed                                               |
| packages/database | npm run migrate:deploy                                                    | All six migrations applied to isolated PostgreSQL 17 |
| apps/api          | npm run format; npm run format:check                                      | Passed                                               |
| apps/api          | npm run lint                                                              | Passed                                               |
| apps/api          | npm run typecheck; node_modules/.bin/tsc --noEmit --incremental false     | Passed                                               |
| apps/api          | node_modules/.bin/jest --runInBand --silent                               | 165 tests / 13 suites passed                         |
| apps/api          | npm run test:integration                                                  | 66 tests / 10 suites passed                          |
| apps/api          | node_modules/.bin/jest --config ./test/jest-e2e.json --runInBand --silent | 179 tests / 11 suites passed                         |
| apps/api          | npm run build                                                             | Passed, including shared database build              |

Added 7 unit, 8 PostgreSQL integration and 31 HTTP tests. Coverage includes required
authentication, normalization, invalid/unsupported values, case variations, concurrent
duplicates, cross-user name reuse, literal search, stable filtered pagination, updates,
conflicts, deletion/name reuse, owner isolation, SQL checks/foreign keys and Swagger.

Integration tests used a separate temporary PostgreSQL container with loopback-only
access and temporary in-memory storage. The intended development database and existing
volumes were not migrated or modified. No .env values or credentials were changed.
After Docker restarted, inspection confirmed the auto-remove test container no
longer existed; no temporary container remains to clean up.
The interrupted task already had passing test evidence; resumption confirmed the
final build, lint/type checks and completed the missing documentation/checklist.

## Setup, limitations and next task

Inject DATABASE_URL for the intended database and apply pending migrations before
starting the updated API:

```sh
npm --prefix packages/database run migrate:deploy
npm --prefix apps/api run build
npm --prefix apps/api run start:prod
```

No new environment variables or dependencies are required. Prisma cannot describe
the expression unique index; preserve its migration SQL. No reset is needed.
Deletion currently affects only the tag row. When Documents adds DocumentTag, use an
intentional cascade for join rows only (never documents) and verify same-owner joins
and cleanup with integration tests. That relationship cleanup is not implemented here.

Tags is complete for the requested scope. The next task is Document metadata and
CRUD. It has not been started, and Phase 1 as a whole remains incomplete.
