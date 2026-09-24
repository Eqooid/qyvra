# Frontend version history — 18 September 2026

> Historical implementation checkpoint. Scope, test counts, file locations and pending
> work below describe that task, not current release status. Phase 1 is complete;
> use the [v1.0.0 snapshot](releases/v1.0.0.md) and [current guides](README.md) for the baseline.

The protected `/documents/[documentId]/versions` page is linked from document
detail and returns there through Back to document. It uses the existing AuthApi,
TanStack Query and shadcn/Base UI controls; no dependencies or backend changes.

## Contract and behavior

- GET `/api/v1/documents/:documentId/versions` requests 25 versions per page,
  `sort=-versionNumber`, with the returned UUID cursor for Load older versions.
- GET `/api/v1/documents/:documentId/versions/:versionId` loads expandable metadata.
- POST `/api/v1/documents/:documentId/versions` sends exactly one multipart `file`.

The desktop table becomes stacked rows on mobile. The page shows server-assigned
version numbers, original filenames, MIME type, human-readable size, UTC timestamps,
page count when present and the server's current/latest marker. The inspector
shows extraction status; PENDING explicitly does not imply processing is implemented.
No checksum, owner ID, storage key or path is rendered. Historical download is not
implemented by the API, so there is no historical-download control.

The file picker reuses existing PDF/JPEG/PNG extension, browser MIME, filename,
nonempty and size validation. The optional existing NEXT_PUBLIC_UPLOAD_MAX_BYTES
setting defaults to 50 MiB and must match the API's configured limit. The server
remains authoritative for signatures, encryption, page counts and ownership.
No bytes are read or converted to base64 for frontend validation.

Confirmation explains that the new file becomes current while older versions and
logical metadata are preserved. The existing XHR transport now accepts an internal
endpoint argument; initial upload still defaults to `/documents`. Credentials,
CSRF, refresh handling, progress and abort behavior are shared. A UUID attempt key
survives unchanged retries in the open form; selecting another file creates a new
attempt. Closing the form or reloading loses the in-memory attempt. Cancellation
never claims server rollback. Duplicate submissions are disabled and guarded.

Queries are scoped by authenticated owner and document ID. Successful upload
resets history to its first page, discards inspected-version cache, and invalidates
document detail and catalog queries. The creation receipt is not used to determine
current state: an idempotent replay may reference an older version. Refresh failure
shows an error instead of stale current badges while preserving the success notice.
Archived/PROCESSING/DELETING states prevent new upload; the API remains authoritative.
Expired sessions use existing login redirection; forbidden/missing responses are
safe and do not reveal resource ownership.

## Files

- `apps/web/app/documents/[documentId]/versions/page.tsx`
- `apps/web/features/documents/version-history.tsx`
- `apps/web/features/documents/version-metadata.tsx`
- `apps/web/features/documents/version-upload.tsx`
- `apps/web/features/documents/document-detail.tsx` (history link)
- `apps/web/lib/api/versions.ts` and `client.ts` (shared upload destination)
- `apps/web/components/ui/confirmation-dialog.tsx` (optional pending content)
- `apps/web/tests/versions-client.test.ts`, `versions.integration.test.tsx`,
  `versions.fixture.ts`
- `apps/web/README.md`, this report and `docs/roadmap.md`

## Verification

From `apps/web`, `npm run format`, `format:check`, `lint`, `typecheck`, `test` and
`build` passed. All **132 tests across 11 suites** passed, including 20 new tests.
Coverage includes contract parsing, credentials, one-file multipart construction,
pagination, safe inspection, loading/empty/error states, lifecycle restrictions,
validation, progress, cancellation, retry keys, refresh and stale replay handling.
The existing authentication, initial upload, detail/actions and theme suites pass.

Headless Chromium against the production build passed light/dark at 375, 768 and
1440px with no horizontal overflow or console errors. Metadata inspection,
confirmation, upload and authoritative history refresh passed using isolated API
fixtures. Screenshots were visually inspected. This does not replace live API
verification of cookies/CORS/storage or physical-device/screen-reader testing.

No migration or new required environment variable. No processing, historical
download, version editing or deletion was added. Phase 1 as a whole remains open.
