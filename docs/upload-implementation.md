# Streaming upload implementation — 15 September 2026

> Historical implementation checkpoint. Scope, test counts, file locations and pending
> work below describe that task, not current release status. Phase 1 is complete;
> use the [v1.0.0 snapshot](releases/v1.0.0.md) and [current guides](README.md) for the baseline.

Only `POST /api/v1/documents` was added. Existing authentication, Categories, Tags,
metadata CRUD and lifecycle behavior were preserved. No download, additional version,
processing, frontend or Phase 2 functionality was implemented.

## Pipeline and consistency

1. Existing session/CSRF guards resolve the internal owner. Validate a UUID
   Idempotency-Key and reserve a durable owner/key attempt under a PostgreSQL advisory lock.
2. Busboy receives exactly one file and eight allowlisted metadata fields. Raw body,
   file, field, part, receive-time and per-process concurrency limits bound admission.
3. Bounded signature inspection confirms extension/MIME agreement. A backpressured
   readable stream calculates SHA-256 incrementally and writes through `Storage`.
   Trusted server UUIDs and detected extension generate the relative original key.
4. The infrastructure inspector streams a private copy to OS temporary storage.
   qpdf rejects encryption, invalid structure and excessive page count. Sharp checks
   image headers/dimensions; final PNG/JPEG markers detect common truncation. No
   application use case imports filesystem APIs and no whole file is buffered in JS.
5. One short PostgreSQL transaction verifies association ownership and creates the
   document, version 1, joins and completed safe response receipt. Initial states are
   UPLOADED/PENDING. No transaction stays open while the client sends bytes.
6. Failed persistence triggers object deletion. Cleanup failures log generated IDs
   only. A lost commit acknowledgement is checked under the same advisory lock before
   deletion; if the outcome is unknowable, preserve the file and return 503.

Duplicate content is rejected by a unique owner/checksum constraint, including
archived and deleted documents; identical content across owners is permitted.
Idempotency replay revalidates the submitted body and matches a fingerprint of
normalized metadata, filename, MIME, size and checksum. A valid replay returns the
stored creation receipt; a changed request or active same-key request returns 409.
Completed receipts expire after 24 hours. Receiving reservations expire after the
configured receive timeout + three inspection timeouts + 120 seconds. Expired keys
are reclaimed lazily on reuse; no background janitor was added.

## Models and migrations

- `DocumentVersion`: immutable original metadata, composite document/owner FK,
  unique document/version, unique storage key, unique owner/checksum, lookup indexes,
  file/media/page constraints and an original-metadata update-protection trigger.
- `DocumentUpload`: owner/key primary key, attempt, state, fingerprint, safe response,
  resource reference, timestamps and expiry index; no file bytes or secrets.
- `20260915010000_document_upload`: creates both models and invariants.
- `20260915020000_upload_completed_invariant`: explicitly rejects null completed
  fingerprints. Added separately after the first migration had been applied to the
  test database; no applied history was edited.

Both migrations were deployed to a disposable PostgreSQL 17 database on loopback
port 55439 with tmpfs storage. No developer database or existing persistent volume
was reset, migrated, renamed or deleted during verification.

## Changed files

- `packages/database/prisma/schema.prisma` and the two migration directories above.
- `apps/api/package.json` and `package-lock.json`: Busboy, Sharp and Busboy types.
- `apps/api/src/modules/documents/`: new `upload.controller.ts`, `upload.dto.ts`,
  `upload-multipart.ts`, `upload.repository.ts`, `upload.service.ts`,
  `upload-multipart.spec.ts`; registration in `documents.module.ts`.
- `apps/api/src/infrastructure/storage/`: new `upload-inspector.ts`, `image-reader.ts`.
  The small CommonJS Sharp bridge follows this project's non-esModuleInterop build.
- `apps/api/src/configuration/{settings,environment,configuration.module}.ts`:
  validated typed upload limits and executable setting.
- `apps/api/src/common/http-security.ts`: multipart admission only on collection
  POST; existing JSON restrictions remain in force elsewhere.
- `apps/api/src/configure-swagger.ts`: implemented capability description.
- `apps/api/test/`: new upload fixture, upload integration and upload HTTP tests;
  existing documents/security HTTP tests updated to expect collection POST.
- `.env.example`, `.dockerignore`, `.gitignore`, `infrastructure/docker/api.Dockerfile`.
  qpdf is installed in the API image; temporary tools/logs are excluded from source
  or build context. Docker Compose and existing volumes were unchanged.
- Root/API/shared-storage READMEs; `docs/api.md`, `database.md`, `architecture.md`,
  `specification.md`, `roadmap.md` and this report.

The supplied directory has no Git metadata, so a Git diff/status was unavailable.
The list records this task's edits; existing user comments and unrelated code were
preserved. Generated Prisma clients/build output were regenerated normally.

## Verification

Commands below are from repository root unless a working directory is shown.

| Command                                                                                       | Result                                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `npm --prefix packages/database run format`                                                   | Passed Prisma and package formatting                                  |
| `npm --prefix packages/database run validate`                                                 | Passed                                                                |
| `npm --prefix packages/database run generate`                                                 | Passed, also repeated by shared-build hooks                           |
| `npm --prefix packages/database run migrate:deploy` with isolated `DATABASE_URL`              | Both new migrations applied; nine total                               |
| `npm --prefix apps/api run format` and `format:check`                                         | Passed                                                                |
| `npm --prefix apps/api run lint`                                                              | Passed after correcting CommonJS import syntax                        |
| `npm --prefix apps/api run typecheck`                                                         | Passed after explicit safe upload-response typing                     |
| `npm --prefix apps/api test -- --runInBand`                                                   | 181 tests passed                                                      |
| `npm --prefix apps/api run test:integration`                                                  | All 93 tests passed at the full regression checkpoint                 |
| `npm --prefix apps/api run test:integration -- upload.integration-spec.ts`                    | All 19 expanded upload tests passed after final receipt/cleanup tests |
| `npm --prefix apps/api run test:e2e -- --runInBand`                                           | All 238 tests passed, including six new upload boundary tests         |
| Targeted `upload-multipart.spec.ts` rerun                                                     | Three passed, including final filename normalization check            |
| `npm --prefix apps/api run build`                                                             | Passed; includes database generation/build and storage build          |
| `npm --prefix packages/storage test`                                                          | Three passed                                                          |
| `npm --prefix packages/storage run test:integration`                                          | 11 passed, one Windows symlink-privilege skip                         |
| Linux image `node --test` on both storage test files                                          | All 15 passed, none skipped; covers Windows privilege limitation      |
| `docker build -f infrastructure/docker/api.Dockerfile -t brainless-api-upload-verification .` | Passed, including production build                                    |
| Linux image upload PostgreSQL HTTP suite with installed qpdf                                  | All 17 checkpoint cases passed                                        |
| `docker compose config --quiet`                                                               | Passed without printing populated environment values                  |

The expanded suite covers 95 distinct PostgreSQL tests (76 existing + 19 upload).
The full-suite checkpoint had 17 upload cases; the final two tests and receipt
constraint assertion passed in the targeted rerun. The large-input test generates
16 MiB from reused 64 KiB blocks; over 100 chunks reach storage and no chunk exceeds
128 KiB. It verifies the incremental checksum without constructing a whole-file
buffer. Shared storage tests independently verify backpressure, atomic publication
and failed-stream cleanup. Tests use synthetic PDFs/images and isolated temp roots.

## Manual setup and limits

Install API dependencies (`npm --prefix apps/api ci`), provide the existing required
database/storage settings, and install qpdf on the host or set `UPLOAD_QPDF_PATH`.
Verify `qpdf --version`. Omit that host-specific setting inside Docker, where qpdf
is already installed. Optional `UPLOAD_*` defaults are listed in `.env.example`;
remove unused placeholders. Supply `DATABASE_URL` to deploy pending migrations to
your intended database, then build/restart the API. This task applied migrations
only to the isolated verification database.

For integration tests set `TEST_DATABASE_URL` to an isolated migrated PostgreSQL
database and `UPLOAD_QPDF_PATH` if qpdf is not on PATH. No real upload directory or
persistent Docker volume is used by tests. TEMP/TMPDIR must be a private directory
outside the repository with sufficient disk space for inspection copies.

Image validation checks headers, dimensions and final markers; it does not decode
every pixel or guarantee arbitrary compressed-payload integrity. PDF parsing rejects
warnings/recovery conservatively. This is not malware scanning. Parser timeouts,
pixel/page limits and concurrent admission reduce resource exposure but are not a
native-parser memory sandbox; size deployment memory/disk accordingly. Missing
qpdf fails PDF upload with 503; metadata health continues to check PostgreSQL only.

There is a small storage-before-SQL crash window. Orphan objects and expired receipt
rows need maintenance; no automatic reconciliation is implemented. Future cleanup
must compare stored server-generated keys against committed versions after a grace
period longer than active leases and preserve objects with uncertain outcomes.
Install output also reports existing/transitive dependency audit findings; this
feature does not constitute a clean dependency audit or complete production acceptance.

**Next task: secure document download.** Phase 1 remains incomplete. Do not start
additional work automatically.
