# Document detail and Phase 1 actions

> Historical implementation checkpoint. Scope, test counts, file locations and pending
> work below describe that task, not current release status. Phase 1 is complete;
> use the [v1.0.0 snapshot](releases/v1.0.0.md) and [current guides](README.md) for the baseline.

Implemented `/documents/[documentId]` with existing authentication, TanStack Query,
React Hook Form/Zod, shadcn buttons, Base UI primitives and semantic light/dark
colors. No backend, schema, migration, environment or dependency changes.

## Files changed

- `apps/web/app/documents/[documentId]/page.tsx`: route composition and metadata.
- `apps/web/features/documents/document-detail.tsx`: detail states, safe metadata,
  current-file download initiation, lifecycle actions and query synchronization.
- `apps/web/features/documents/document-edit.tsx`: dedicated edit section, owned
  lookup choices, validation, dirty-form warnings and recoverable errors.
- `apps/web/features/documents/edit-metadata.ts`: initial values and changed-field
  PATCH mapping, including explicit null/empty-array clearing.
- `apps/web/components/ui/confirmation-dialog.tsx`: Base UI alert dialog wrapper
  using existing Button, Cancel-first focus, focus trap/return, pending/error states.
- `apps/web/lib/api/client.ts`: authenticated JSON mutations and a download-header
  probe that cancels its body without consuming the complete file.
- `apps/web/lib/api/documents.ts`: typed detail/PATCH/lifecycle/download helpers,
  safe response projection, UUID checks and sanitized action messages.
- `apps/web/features/documents/documents-list.tsx`: soft-delete success notice.
- `apps/web/tests/detail-client.test.ts`, `detail.integration.test.tsx` and
  `detail.fixture.ts`: boundary tests with synthetic non-sensitive metadata.
- Web README, roadmap and this report.

The workspace has no Git metadata; this inventory is not a Git-generated diff.

## Behavior and ownership

The existing session-protected layout encloses the new route. Internal owner IDs
scope query caches only; API ownership derives from HttpOnly cookies, never a body
field. Invalid/missing/unowned IDs produce a neutral unavailable page. The browser
imports no NestJS or Prisma code. Zod schemas discard storage keys, hashes and owner
fields. Metadata includes title, type, status, archive state, issuer, reference,
document/expiration dates, category/tags, timestamps and optional verified summary.

The edit form retains an initial snapshot while open. It submits only changed
allowed fields; null clears nullable values, [] clears tags, and omitted fields
remain unchanged. Tag IDs are deduplicated; current owned associations are retained
as choices even if their lookup page is not loaded. Lookup pages are bounded at 100.
Local validation reuses the upload metadata schema. Generic API failures stay in
the open form; invalid fields have inline messages. Confirmed success updates and
invalidates detail, invalidates the owner's list and closes the section. Duplicate
submits are guarded. Dirty cancellation/link/unload prompts are best-effort browser
behavior, not persistence of unsaved forms.

Archive and restore use confirmations and server-returned lifecycle state. Active
documents offer edit/download/archive/delete; archived documents offer
download/restore/delete. PROCESSING blocks lifecycle changes and DELETING also
blocks edit/download. Soft delete requires an intentional destructive confirmation
containing the title and explaining recoverability. Success removes detail cache,
invalidates lists and navigates to `/documents` with a transient notification.
Normal detail cannot retrieve deleted rows; no Trash/purge/recovery bypass is added.

## Download and API limits

The detail response has no current-version or has-file field. No file metadata is
invented, and absence of a version is learned only when download returns 409. That
disables download with an explanation until Refresh details; missing storage yields
a safe availability error instead. No version-history request is introduced.

A credentialed GET checks download response headers, cancels the response stream
immediately, and applies the existing serialized refresh if it receives 401. On
success, native browser navigation requests the same UUID-only authorized endpoint.
The browser honors Content-Disposition; JavaScript creates no Blob and reads no
complete binary. The two requests may be logged as an interrupted probe followed
by the real transfer. This is not an atomic availability guarantee: changes between
requests can make the browser display a safe API error. Cross-origin deployment
still depends on existing CORS/credential/SameSite settings. No proxy or Nginx change
was added, and no client-side buffering fallback exists.

The API does not expose ETag/If-Match, so no optimistic concurrency token is invented.
Only changed fields are sent, but concurrent edits to the same field remain subject
to server behavior. Generic 400/404/409 errors cannot identify a particular field or
whether conflict resulted from another edit; the UI explains the uncertainty and
preserves inputs. These limitations were documented rather than changing the API.

## Verification

From `apps/web`: `npm run format`, `npm run lint`, `npm run typecheck`,
`npm run test`, `npm run build`. The build includes the dynamic document-ID route;
it used network access for the existing Google Fonts, without changing font setup.

All commands passed. The complete frontend suite passed 110 tests across nine
files, including 30 new detail/action cases. Existing auth, theme, catalog and upload
tests still pass. The initial new test fixture inferred deletedAt as null-only;
its annotation was corrected to the actual nullable timestamp contract before the
final type check and build. No product workaround was needed.

Chromium production-browser checks intercepted the API boundary. They passed safe
detail rendering, metadata editing, native attachment download (backend-style
Content-Disposition filename), archive, restore, soft delete and redirect. The
Cancel-first dialog focus, Shift-Tab trap and cancellation focus return passed.
Both themes passed at 1440px and 390px without overflow. No hydration or browser
console errors were observed. Tests use fixture bytes only, never personal files.

The configured local API liveness check failed because it was unavailable. Live
cookie/CORS, actual PostgreSQL mutations and storage downloads therefore remain a
manual check once the API runs. No developer database records were modified. Use a
disposable owned document to verify update/download/archive/restore/delete end to
end; deletion recovery has no UI in this slice.

Next task: version-history page and upload-new-version UI. No next-task or Phase 2
work was started.
