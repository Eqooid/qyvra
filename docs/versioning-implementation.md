# Additional immutable document versions

> Historical implementation checkpoint. Scope, test counts, file locations and pending
> work below describe that task, not current release status. Phase 1 is complete;
> use the [v1.0.0 snapshot](releases/v1.0.0.md) and [current guides](README.md) for the baseline.

The interrupted implementation already contained the three routes, upload reuse,
scoped receipt migration, unit tests and PostgreSQL tests. The resumed work added
HTTP contract/security tests, exercised both multipart modes with a generated large
stream, corrected malformed-UUID multipart routing, and completed documentation and
verification. Authentication behavior was preserved.

## Implementation

- GET and POST `/api/v1/documents/:documentId/versions` and GET
  `/api/v1/documents/:documentId/versions/:versionId` are implemented.
- Queries derive ownership from session context and filter through the logical
  document. Deleted documents are unavailable. Archived history is readable;
  appending to archived, PROCESSING or DELETING documents conflicts.
- Existing Busboy streaming, incremental SHA-256, byte limits, backpressure,
  qpdf/image inspection, generated create-only storage keys and compensation are
  shared with initial upload. Version uploads accept only a single file.
- Scoped advisory receipt locking plus an owned document row lock protects
  `max(versionNumber)+1`. The unique document/version constraint remains. New
  versions are PENDING and logical state becomes UPLOADED; old rows and objects
  remain unchanged, protected by the existing immutability trigger.
- Owner/checksum uniqueness still rejects duplicate content across the owner's
  entire history. Other owners may use identical content. Receipt scope is `create`
  or `versions:<document UUID>`. Completed matching replay returns the original
  receipt; changed content conflicts. Receipt `isLatest` describes creation time;
  history reads compute current state.

## Files changed

- `packages/database/prisma/schema.prisma` and new migration
  `20260915030000_version_upload_scope/migration.sql`.
- `apps/api/src/modules/documents/versions.controller.ts`, `versions.dto.ts`,
  `versions.service.ts`, `versions.service.spec.ts` (new).
- Documents module, `upload.repository.ts`, `upload.service.ts`,
  `upload-multipart.ts` and its unit test: shared ingestion and scoped persistence.
- `apps/api/src/common/http-security.ts`: multipart recognition for the version
  route, including malformed IDs so UUID validation returns 400 rather than 415.
- `apps/api/src/configure-swagger.ts`.
- `apps/api/test/versions.integration-spec.ts`, `versions.e2e-spec.ts` (new);
  existing upload integration receipt selectors and documents Swagger assertions.
- Root/API README, docs/api.md, database.md, architecture.md, specification.md,
  roadmap.md and this report.

No Git metadata was available in the supplied workspace, so this is the tracked
implementation inventory rather than a Git-generated diff. No authentication code,
developer environment values or persistent database volumes were changed.

## Verification

Commands run from their respective package directories:

| Command / check                                                              | Result                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| Database `npm run format`, `npm run validate`, `npm run generate`            | Passed                                         |
| Database `npm run migrate:deploy` against isolated PostgreSQL                | All 10 migrations applied                      |
| API `npm run format`, `npm run lint`, `npm run typecheck`                    | Passed                                         |
| API `node node_modules/jest/bin/jest.js --runInBand`                         | 211 unit tests passed                          |
| API `npm run test:integration`                                               | 112 tests passed across all 14 suites          |
| API `npm run test:e2e -- --runInBand`                                        | 264 HTTP tests passed across all 15 suites     |
| Targeted HTTP rerun: versions, documents, security after UUID/Swagger fix    | 80 passed                                      |
| API `npm run build` (includes storage/database builds and client generation) | Passed                                         |
| Storage `npm test`, `npm run test:integration`                               | Windows: 14 passed, one symlink privilege skip |
| Current storage tests mounted read-only into existing Linux test image       | 15 passed, no skips                            |

The new suites cover sequential/concurrent versions, immutable old rows, lifecycle
races, ownership, pagination, safe metadata, duplicate races, scoped replay, invalid
files, storage/database failures and uncertain-commit recovery. A generated 16 MiB
multipart test runs both initial and file-only modes and checks bounded chunks and
backpressure; storage and current-download streaming regressions also pass.
The initial integration attempt failed because Docker was stopped. After restoring
the disposable test database, the complete suite passed. Existing data was untouched.

## Setup and limitations

With the intended developer DATABASE_URL injected, stop older API instances and run
`npm --prefix packages/database run migrate:deploy`, then
`npm --prefix apps/api run build` before restarting. This run migrated only an isolated
test database. Do not mix old and new API instances across the receipt primary-key
change; existing receipts retain the default `create` scope. No new environment
variables or dependencies are required. Existing qpdf/private-storage setup applies.

Uploads retain the documented storage/SQL crash window: an orphan may remain if the
process dies or compensation fails. Automatic reconciliation is deferred. Inspection
is not antivirus scanning or complete image pixel-stream verification. Receipts expire
under the existing policy; no automatic janitor is added. No historical-version
download, processing, frontend version UI or Phase 2 work was implemented.

Next task: Next.js document-management pages. Phase 1 still requires its remaining
UI, deployment and final acceptance work.
