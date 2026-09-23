# Document metadata foundation implementation

Scope: Phase 1 document metadata only, 14 September 2026. Authentication/profile,
Categories and Tags were already implemented. No Document/DocumentTag model or
document routes existed at the start of this task. This checkout has no `.git`
metadata, so changes were tracked through file inspection rather than a Git diff.

## Implemented behavior

- GET `/api/v1/documents`: owned, non-deleted metadata; limit 25 by default, max 100;
  literal metadata search and allowlisted filters; createdAt plus UUID keyset order.
- GET/PATCH `/api/v1/documents/:documentId`: safe detail and validated partial update.
  Omitted fields remain unchanged; null clears nullable metadata; [] clears tags.
- POST `/api/v1/documents/:documentId/archive`: idempotent ARCHIVED/isArchived update.
- POST `/api/v1/documents/:documentId/restore`: restores archived/deleted metadata to
  UPLOADED; active records remain unchanged. Never claims processing success.
- DELETE `/api/v1/documents/:documentId`: idempotent soft deletion preserving joins.

Session context supplies every owner predicate. Missing and unowned IDs both return 404. Composite owner foreign keys also reject cross-user category/tag associations.
Owned row locks serialize mutations; metadata and deduplicated tag replacements
share a transaction. Four batched Prisma reads load each nonempty list page,
independent of document count. PROCESSING/DELETING lifecycle actions return 409;
archiving deleted metadata returns 404. Authentication runtime is unchanged.

The only completed-feature runtime adjustment maps category FK conflicts to the
existing generic 409. A PostgreSQL regression test first demonstrated the previous
500 response. Used categories remain protected even when documents are soft-deleted.
Deleting a Tag now cascades join rows only, verified against PostgreSQL.

## Files added or changed

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20260914050000_document_metadata/migration.sql`
- `packages/database/README.md`
- `apps/api/src/app.module.ts`
- `apps/api/src/configure-swagger.ts`
- `apps/api/src/modules/documents/document-lifecycle.ts`
- `apps/api/src/modules/documents/document-pagination.ts`
- `apps/api/src/modules/documents/documents.dto.ts`
- `apps/api/src/modules/documents/documents.service.ts`
- `apps/api/src/modules/documents/documents.controller.ts`
- `apps/api/src/modules/documents/documents.module.ts`
- `apps/api/src/modules/documents/document-lifecycle.spec.ts`
- `apps/api/src/modules/documents/documents.service.spec.ts`
- `apps/api/src/modules/categories/categories.service.ts`
- `apps/api/src/modules/categories/categories.controller.ts`
- `apps/api/test/documents.integration-spec.ts`
- `apps/api/test/documents.e2e-spec.ts`
- `apps/api/test/security.e2e-spec.ts`
- `apps/api/README.md`
- `docs/api.md`, `docs/database.md`, `docs/specification.md`, `docs/roadmap.md`
- This implementation report.

Generated Prisma output and compiled artifacts are regenerated, not hand-edited.
No configuration variables or dependencies were added. Existing migration history
was preserved; no real database or persistent Docker volume was reset or deleted.

## Verification

Commands use `npm.cmd` on Windows; directory context is shown below.

| Directory         | Command                           | Result                                                                                       |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| packages/database | `npm run format`                  | Passed: Prisma and package formatting                                                        |
| packages/database | `npm run validate`                | Passed                                                                                       |
| packages/database | `npm run generate`                | Passed                                                                                       |
| packages/database | `npm run migrate:deploy`          | Seven migrations applied in isolated PostgreSQL; subsequent deploy had no pending migrations |
| packages/database | `npm run lint`                    | Passed                                                                                       |
| packages/database | `npm run typecheck`               | Passed                                                                                       |
| packages/database | `npm run build` (API hooks)       | Passed                                                                                       |
| apps/api          | `npm run format`                  | Passed                                                                                       |
| apps/api          | `npm run lint`                    | Passed                                                                                       |
| apps/api          | `npm run typecheck`               | Passed                                                                                       |
| apps/api          | `npm test -- --runInBand`         | 175 tests passed in 15 suites                                                                |
| apps/api          | `npm run test:integration`        | 76 tests passed in 11 suites                                                                 |
| apps/api          | `npm run test:e2e -- --runInBand` | 232 tests passed in 12 suites                                                                |
| apps/api          | `npm run build`                   | Passed                                                                                       |

New coverage comprises 10 unit, 10 PostgreSQL integration and 53 HTTP tests.
It includes authentication, DTO/UUID/filter validation, safe envelopes, Swagger,
ownership for every operation and association, merged date rules, duplicate joins,
transaction failure rollback, concurrent updates, deterministic pagination, metadata
search, lifecycle recovery/retries, composite FK constraints and tag cascade cleanup.
A unit test checks constant batch-query count; this is not a production load benchmark.

After the full run, the cursor's year-zero rejection and Swagger annotations received
targeted unit/HTTP reruns, plus formatting, lint, type checking and production build.

## Setup and remaining scope

Inject the intended `DATABASE_URL` securely, then from the repository root run:

```sh
npm --prefix packages/database run migrate:deploy
npm --prefix packages/database run build
npm --prefix apps/api run build
```

The Prisma package does not load root `.env` automatically. Apply migrations before
starting the API; connectivity readiness alone does not verify schema deployment.
For integration tests use a separate disposable PostgreSQL database, set
`TEST_DATABASE_URL`, and deploy migrations with `DATABASE_URL` pointing to that same
test database. This run used a temporary PostgreSQL 17 container on loopback port
55439 with tmpfs storage and no existing application data.

There is deliberately no public document creation endpoint. Only isolated tests
create fixture records; public creation arrives with streaming upload and the first
immutable version. There are no file/storage/version/processing/preview sections,
permanent purge, document pages or fabricated successful processing. Pagination is
not a snapshot; keep filters and sort fixed while following cursors. Category
reassignment is explicit metadata editing, not an automatic delete workflow.

Phase 1 remains incomplete. The next task is **file-storage abstraction**; do not
start it automatically or begin Phase 2.
