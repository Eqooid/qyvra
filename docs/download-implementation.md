# Secure current-version download — 15 September 2026

Implemented only `GET /api/v1/documents/:documentId/download`. Existing upload,
authentication, Categories, Tags and metadata behavior remain intact. No migration,
dependency, configuration variable or storage-interface change was required.

## Behavior

The existing session guard supplies the internal user ID. The document query filters
by id, userId, deletedAt=null and status!=DELETING before storage metadata/open calls.
Archived documents are allowed. The highest versionNumber is current; ID descending
is a stable secondary order. The existing unique document/version constraint prevents
ambiguity; the query defensively detects duplicate highest numbers. It selects only
two versions and the fields needed for download. A missing current object never
causes fallback to an older version. Tests create extra versions only as isolated
fixtures; no additional-version endpoint was added.

The service uses provider-neutral Storage metadata/open, compares object size with
stored fileSize, and awaits the first readable chunk before sending binary headers.
An async generator and Node pipeline honor backpressure and verify actual byte count.
The source is destroyed on completion, error or client disconnect. A response-close
listener aborts the pipeline. No whole-file buffer or filesystem call is used.

The controller owns the Express response explicitly, so binary success bypasses JSON
serialization while ordinary early exceptions retain the global error envelope.
Headers are trusted Content-Type, checked Content-Length, safe attachment disposition
with ASCII fallback/UTF-8 filename*, nosniff, private/no-store and Accept-Ranges:none.
Control characters and header delimiters are removed/replaced; display filenames are
never paths. Range requests receive the full HTTP 200 file; range support is not added.
Correlation headers and AsyncLocalStorage logging remain unchanged.

| Condition                                                                        | Result                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Missing/invalid session                                                          | 401                                                                        |
| Invalid UUID, query parameters or request body                                   | 400 (existing body middleware may reject unsupported media/oversize first) |
| Missing, unowned, soft-deleted or DELETING document                              | Same sanitized 404                                                         |
| No current version or ambiguous highest version                                  | 409                                                                        |
| Missing storage key/object, inconsistent size/MIME, provider or database failure | Sanitized 503 before headers                                               |
| Failure or wrong byte count after binary headers                                 | Connection terminated; no JSON appended                                    |
| Client disconnect                                                                | Source closed; no completed-download event                                 |

Only a fully finished server stream emits `download.completed`. Interrupted streams
emit safe interruption logging; ordinary aborted HTTP requests also retain existing
request logging. Logs contain generated document ID/byte count and correlation ID,
never filename, storage key, paths, credentials or raw exceptions. Successful server
transfer does not establish that the client saved the file durably.

## Files changed

- Added `apps/api/src/modules/documents/download.controller.ts`.
- Added `apps/api/src/modules/documents/download.service.ts`.
- Added `apps/api/src/modules/documents/download-filename.ts`.
- Added `apps/api/src/modules/documents/download.service.spec.ts`.
- Added `apps/api/test/download.e2e-spec.ts` and `download.integration-spec.ts`.
- Updated `apps/api/src/modules/documents/documents.module.ts` to register the feature.
- Updated `apps/api/src/configure-swagger.ts` and the existing Swagger availability
  assertion in `apps/api/test/documents.e2e-spec.ts`.
- Updated `docs/api.md`, `docs/roadmap.md`, `docs/architecture.md`,
  `docs/specification.md`, root/API/shared-storage READMEs and this report.

There is no Git metadata in this supplied directory, so Git diff/status could not
be used. Existing comments and unrelated functionality were preserved.

## Verification

All required checks passed. Commands run from root unless otherwise indicated.

| Command                                                                          | Result                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm --prefix apps/api run format` and `format:check`                            | Passed                                                                                     |
| `npm --prefix apps/api run lint`                                                 | Passed                                                                                     |
| `npm --prefix apps/api run typecheck`                                            | Passed                                                                                     |
| `node node_modules/jest/bin/jest.js --runInBand` in apps/api, after shared build | 195 unit tests passed; 14 download cases                                                   |
| `npm --prefix apps/api run test:integration`                                     | 99 PostgreSQL tests passed, including all 19 upload cases and four new download workflows  |
| `npm --prefix apps/api run test:e2e -- --runInBand`                              | 249 HTTP tests passed, including 11 new download cases and existing upload/security suites |
| `npm --prefix apps/api run build`                                                | Passed; storage/database build and Prisma generation included                              |
| `npm --prefix packages/storage test`                                             | Three passed                                                                               |
| `npm --prefix packages/storage run test:integration`                             | 11 passed, one Windows symlink-privilege skip                                              |
| Linux `node --test` for current storage source mounted read-only                 | All 15 passed, no skips                                                                    |
| Existing `migrate:deploy` against disposable test database                       | All nine existing migrations applied; no new migration                                     |

Tests cover authentication, UUID/input rejection, ownership-first queries, active/
archived/deleted/DELETING visibility, deterministic latest-version selection without
fallback, missing/ambiguous versions, missing keys/objects, provider/initial/late read
failures, safe PDF/JPEG/PNG headers, Unicode/header injection, correlation propagation,
client disconnect and no false completion. A 32 MiB input is generated from reused
64 KiB blocks, never assembled as a whole-file buffer. It asserts bounded outstanding
production against a slow writable and maximum observed chunks of 128 KiB.

PostgreSQL tests used `brainless-download-verification`, PostgreSQL 17 on loopback
port 55439 with tmpfs, and isolated OS temporary storage. TEST_DATABASE_URL pointed
only there. Existing developer databases and persistent volumes were not altered.
Upload regression used the locally available qpdf executable; download itself does
not need qpdf. A test-helper UUID inference error was corrected before the passing
HTTP regression run; no implementation regression required authentication changes.

## Limits and next task

No range, inline preview, old-version selection or version-history endpoint is
implemented. Ownership/visibility is checked when admitting the request; a deletion
or revocation during streaming cannot retract bytes already sent. A late read error
is observable as an interrupted transfer rather than a new HTTP error envelope.
Checksums are not recalculated on every download; immutable private storage and
stored metadata remain the current integrity boundary.

**Next: uploading and listing additional immutable document versions.** Phase 1 is
not yet complete; no next task was begun automatically.
