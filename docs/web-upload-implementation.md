# Next.js document upload

This slice adds only `/documents/upload` and its multipart data access. It reuses
the authenticated document layout, existing AuthApi/currentUser refresh flow,
TanStack Query, React Hook Form/Zod, shadcn Button and semantic theme variables.
No backend, database, dependency, existing environment file or authentication-policy
changes were made. The API is still the security authority.

## Files changed

- `apps/web/app/documents/upload/page.tsx`: route metadata, public size configuration.
- `apps/web/features/documents/upload-form.tsx`: file selection/drop, metadata,
  paginated category/tag choices, validation, progress/cancellation and success.
- `apps/web/features/documents/upload-validation.ts`: early file/metadata checks.
- `apps/web/lib/api/client.ts`: focused XHR multipart operation sharing base URL,
  ApiError, cookies and serialized authentication refresh.
- `apps/web/lib/api/upload.ts`: typed receipt, FormData allowlist, retry-key tracking
  and sanitized upload error messages.
- `apps/web/features/documents/documents-list.tsx`: in-memory success notification
  and returned-ID marker. No detail/action/version page added.
- `apps/web/tests/upload-client.test.ts`, `upload.integration.test.tsx`,
  `upload.fixture.ts`: API-boundary tests with small non-sensitive fixtures.
- `apps/web/.env.example`, web README, roadmap and this report.

No Git metadata is present, so the file list is an implementation inventory.

## Form and transport

Required: one file, title, document type (defaults OTHER). Optional: issuer,
reference number, document/expiration dates, category and tags. Blank optional
strings are omitted; tag IDs are deduplicated/sorted and serialized as a JSON array.
Only these fields and exactly one `file` part are sent. Browser-generated MIME and
filename accompany the file part; no separate trusted MIME/size/checksum fields are
sent. No owner, storage key, status, version number or extraction status is writable.

Early validation covers required fields, extension/browser MIME allowlists, empty
files, filename length, configured bytes, metadata lengths and calendar/date order.
It neither reads full files nor creates previews. The server detects signatures,
encrypted/malformed PDFs, pages, duplicate checksums and owned associations.
Lookup IDs come only from loaded API options; pages of 100 can be loaded explicitly.
Lookup failure has a retry state and does not prevent unassociated uploads.

XHR sends HttpOnly-cookie credentials, CSRF header and a UUID Idempotency-Key.
Content-Type is left to the browser. Progress uses actual byte events or an
indeterminate progress element. 100% means bytes sent, not durable completion.
Four-minute browser timeout is independent of the API's configured receive timeout.

The current file object and normalized submitted values determine the in-memory
retry key. Unchanged retries after network interruption or cancellation reuse it;
changed file/metadata gets a new key. File selection resets file-specific progress
and errors while preserving metadata. There are no automatic uncertain-network
retries, and files/keys are not persisted. The existing refresh routine handles a
401, followed by at most one retry with the same key/body. Confirmed expiry returns
to login through the existing session context.

Cancellation aborts XHR and preserves form values. Unmount also aborts. Unload/link
navigation warns while active, where the browser permits it. The message explicitly
says the server may already have completed the upload. Success validates a safe
UPLOADED/PENDING version-1 receipt, invalidates owner-scoped document queries and
returns to `/documents` because detail is not implemented. The success cache uses
the returned document ID; its notification is transient and dismissible.

## Error contract limitations

No blocking mismatch was found. The backend's sanitized 400 envelope does not
distinguish missing/malformed files, password protection, page limits and metadata
validation. Its 409 envelope does not distinguish duplicate content, an active
reservation and incompatible replay. The UI therefore explains those possible
causes together; it never fabricates a specific diagnosis or displays raw messages.
413 explains size, 415 media/signature mismatch, 404 unavailable category/tag,
503 storage/inspection availability, and network/timeout/unexpected failures explain
uncertain completion. Local validation can give precise field-specific feedback.

The server does not publish the configured upload cap. Optional public
`NEXT_PUBLIC_UPLOAD_MAX_BYTES` defaults to 52428800 (50 MiB); set it to match the API
`UPLOAD_MAX_BYTES` if customized, then rebuild. Allowed frontend configuration is
1–209715200 bytes. The backend still enforces its own value.

## Verification and remaining manual check

From `apps/web`, run `npm run format`, `npm run lint`, `npm run typecheck`,
`npm run test`, and `npm run build`. Builds used network access for the existing
Google Fonts. No font or layout redesign was needed.

Results: formatting plus format-check, lint and TypeScript all passed; the complete
frontend suite passed 80 tests across seven files, including 35 new upload cases.
The final production build passed and includes `/documents/upload`. Regression
tests include existing authentication, theme and catalog behavior. The added tests
cover multipart fields/cookies, progress, cancellation, network retry keys, file
replacement, date validation, optional lookup failure, safe errors, duplicate-submit
prevention, cache invalidation, navigation and expiry handling.

Browser checks used installed headless Chromium and the production build with
intercepted API responses. Both light/dark themes passed at 1440px and 390px with
no horizontal overflow. PDF/JPEG/PNG selection and submission, invalid-file
rejection, keyboard cancellation, preserved form values and success navigation
passed with no console/hydration errors. These fixtures test frontend behavior;
they do not establish real backend content-validation or storage success.

The configured local API liveness endpoint was unavailable. Once it is running,
manually upload valid small PDF/JPEG/PNG files with your own authenticated session,
check the saved documents, and exercise a server-rejected malformed/encrypted file
and cancellation. This was not performed against developer data. Live CORS/cookie,
storage and parser verification remains pending. Browser history navigation may
leave without a prompt; unmount still cancels. A reload loses the in-memory retry
key, so check the catalog before starting over after an uncertain result.

Next task: document detail page with metadata editing, download, archive, restore
and soft-delete actions. No next task or Phase 2 work was started.
