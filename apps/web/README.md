# QYVRA web

**v1.0.0 / Phase 1 released; v1.1.0 / Phase 2 release-ready.** Start with [onboarding](../../docs/development/getting-started.md),
[feature guides](../../docs/README.md#features), [test commands](../../docs/development/testing.md)
and [release evidence](../../docs/releases/v1.1.0.md). The UI refinement and theme
verification sections below retain earlier checkpoints, not current test counts.

For the current frontend component foundation, route audit, retained compositions
and verification, see [UI standardization](UI-STANDARDIZATION.md).

Next.js App Router, React, Tailwind and the existing shadcn/Base UI Button and
orange theme. Authentication uses TanStack Query, React Hook Form and Zod.

## Local setup

Use Node 24 and npm, independently of the API package:

```sh
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

Copy `apps/web/.env.example` to **apps/web/.env.local** and replace the placeholder:

```dotenv
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1
```

This is a public address, never a secret. Next.js does not read root `.env`.
The setting is embedded at build time, so rebuild for production URL changes.
Omitting it selects `/api/v1`, which requires a same-origin reverse proxy routing
that path to NestJS. There is no automatic Next.js API proxy in this implementation.

For frontend localhost:3000 and API localhost:3001, configure the **API's root .env**:

```dotenv
PORT=3001
CORS_ORIGINS=http://localhost:3000
CORS_CREDENTIALS=true
```

Restart the API after configuration changes. Include the Swagger origin separately
if needed. Use the same hostname spelling on both apps (localhost vs 127.0.0.1).
The API must have a working DATABASE_URL and all existing migrations applied; see
`apps/api/README.md`. This frontend task does not alter databases or root secrets.

## Implemented flows

### Categories and tags

`/categories` and `/tags` use the protected application shell and existing
credentialed API client. Both provide bounded lists, creation, editing and
confirmed deletion. Category styling uses controlled hex-color and icon choices;
existing custom values are preserved, and unknown icon slugs use a safe fallback.
Names follow the API's NFKC/trim/collapsed-whitespace policy and 1–100 Unicode
character limit. Duplicate names are case-insensitive per owner.

Referenced categories cannot be deleted, including references from soft-deleted
documents. Deleting a tag removes its document assignments but never documents.
Mutations refresh category/tag options and document list/detail caches. No usage
counts are fabricated. See [implementation and verification](../../docs/web-organization-implementation.md).

### Version history

The current-version card on document detail shows file-integrity processing
status and optional percentage/stage. Inspecting a historical version shows that
version's own status beside its metadata. Active jobs poll the owned API every
five seconds and stop after a terminal outcome; missing temporary progress leaves
the durable status visible. The catalog does not make a status request per row.
No direct broker or Redis connection is used by the browser.

Open **Version history** from document detail to view
`/documents/[documentId]/versions`. History is paginated newest first, with safe
expandable metadata and a current/latest badge. Upload new version confirms a
single PDF/JPEG/PNG before sending it through the existing credentialed streaming
upload client. Older files and document metadata remain unchanged. Successful
upload refreshes history, detail and catalog data; unchanged retries reuse the
in-memory idempotency key. Historical-version download is unavailable in the API.
See [implementation and verification](../../docs/web-versioning-implementation.md).

### Document catalog

`/documents` uses the existing protected shell and cookie/refresh client. It reads
documents, categories and tags from the configured API; no new environment settings
are required. The list displays a responsive table with public metadata and text
status badges. Metadata search is debounced by 350 ms. Advanced filters open in
a dialog; edits remain a draft until **Apply filters** is selected. Closing or
cancelling discards draft changes, while **Clear** resets only the draft until
it is applied. Sort controls remain in the compact document toolbar.
Document types accept custom uppercase identifiers as supported by the API.

Search, current filename/MIME type, document type, status, category, all-of tags,
archive state, created/updated date ranges, sort, limit and cursor live in URL
search parameters. Filename and metadata search inputs are debounced. Filters and
sort changes reset the cursor. Next page uses the server's opaque cursor; Previous
uses a short in-memory cursor trail for pages visited in the current query. First
page resets navigation, and browser Back/Forward restores URL-backed views.
Unknown parameters are ignored and unsupported values fall back to defaults.
An opaque cursor rejected by the server shows an error with a First page action.
No cursor contents or ownership rules are interpreted in the frontend.

The document API client now parses nullable `description` and the nullable, safe
`currentVersion` summary in list/detail/PATCH responses. Upload may send an optional
description, while its idempotent creation receipt remains unchanged. The typed
list query serializer supports current filename/MIME, all-of tag IDs (one
comma-separated parameter), UTC calendar-day ranges, and the backend's six
allow-listed `sort` values. A leading minus in `sort` means descending; there is
no separate direction parameter. Cursor values are passed through unchanged,
and the serialized query, including filters, sort and cursor, forms the catalog's
TanStack Query cache key. The filter accordion exposes the new controls with
removable active-filter badges. Sort direction is selectable where the backend
supports both directions; updated date and current file size are descending only.
Date inputs send calendar dates without timezone conversion and reject reversed
ranges before navigation.

Category/tag lookups request 100 rows at a time with explicit Load more controls;
they do not fetch an entire unbounded collection. Lookup failures disable that
filter with a retry action without blocking document results. Filters remain
bookmarkable even if their selected lookup row is not loaded yet.

The filter panel is a native keyboard-accessible disclosure. Existing shadcn
buttons, shell, semantic colors and theme provider are reused. New input/select
controls follow the existing form styling; no component or state library is added.

Upload links open `/documents/upload`. Result links open the implemented
`/documents/{id}` detail route.
See [verification and limitations](../../docs/documents-list-implementation.md).

### Document upload

`/documents/upload` reuses the protected layout and supports one PDF, JPEG or PNG
plus the documented metadata. The picker and optional drop area do not read file
contents into JavaScript. Categories/tags use authenticated, paginated lookups.
Required fields and dates are checked locally; the API remains authoritative for
signatures, encryption, page counts, ownership, duplicates and storage.

The public UX size cap defaults to 50 MiB. **No new setting is required with that
API default.** If the API's `UPLOAD_MAX_BYTES` differs, set optional
`NEXT_PUBLIC_UPLOAD_MAX_BYTES` in `apps/web/.env.local` to the same integer byte
limit and rebuild. This public limit is not a security control or secret. The API
does not expose its active limit through a discovery endpoint.

A focused XMLHttpRequest operation inside the existing API client provides upload
progress, credentials, CSRF and Idempotency-Key headers without setting the multipart
boundary. At 100%, the UI still waits for server confirmation. The browser request
times out after four minutes. Cancellation aborts the request but cannot promise
rollback; check the list if completion is uncertain. Browser unload and link clicks
warn during upload; unmount aborts. Browser history/programmatic navigation may not
show a prompt in every browser.

The same selected File object and normalized metadata reuse an in-memory UUID key
on retry. Replacing/removing the file or changing submitted metadata starts a new
key. No automatic retry follows network failure. A confirmed 401 uses the existing
serialized refresh flow and retries once with the same body/key. Reloading or leaving
the form loses its file and retry key; check the list before starting over. Nothing
is persisted to localStorage by the upload feature.

Success invalidates document queries and returns to `/documents`, with an in-memory
UPLOADED notification and a marker on the returned document ID if it is visible.
It never claims extraction or AI processing completed. See
[upload verification and limitations](../../docs/web-upload-implementation.md).

### Document detail and actions

`/documents/{id}` displays safe metadata, the full owner description, the current
version's filename/type/size/version/upload time, category/tags, archive/status,
timestamps and a verified summary when present. Metadata-only records show a safe
empty current-version state. The list shows a clamped description preview and
compact current-file details directly from its document response, without per-row
version-history requests. It reuses the protected document layout.
Active documents can be edited in a dedicated section using the existing form
validation; unchanged fields are omitted, a cleared description and other optional
fields become null, and cleared tags become []. Archived documents offer
restore/download/delete instead of editing. PROCESSING/DELETING lifecycle actions
are disabled. Deleting also
disables edit/download. Confirmation dialogs use the existing Base UI stack, focus
Cancel first, trap keyboard focus and restore it on cancellation.

Download first checks the authorized download endpoint's response headers and
immediately cancels its stream, then navigates to the same API endpoint for a native
browser attachment download. No Blob, base64, storage path or filename override is
used. Cookies follow the browser's existing policy and the API supplies the filename.
This makes two authorized requests; the probe is an intentionally interrupted read.
A file/session change between them can still cause the final browser navigation to
show the API's safe error instead of downloading. Cross-site cookie restrictions or
incorrect CORS can prevent the probe; configure the existing public API/cookie/origin
settings rather than buffering the file in JavaScript. The UI only announces download
initiation, not completion.

The current-version card uses the safe detail summary; version history remains a
separate page. A download 409 disables the action with an
explanation until Refresh details is used. Metadata conflicts are shown without
discarding the form; the backend has no ETag/If-Match concurrency contract. Unsaved
changes warn on cancel, link navigation and browser unload where supported, but
browser history/programmatic navigation cannot always be blocked.

Archive, restore and confirmed soft delete use the server-returned state and
invalidate list/detail queries. Soft delete returns to the list with a success
message. Normal detail cannot open deleted documents; this task does not add Trash
or deleted-document recovery UI. No new environment variables or migrations.
See [detail verification and limitations](../../docs/web-detail-implementation.md).

- `/register`: account creation, then a separate link to login; no implicit session.
- `/login`: email/password submission and navigation to `/dashboard`.
- `/dashboard`: shared protected layout, current-user profile, empty workspace,
  desktop sidebar, accessible mobile navigation and logout.
- `/`: routes to dashboard; unauthenticated visitors are redirected to login.

Fetch API calls use credentials: include and no-store; multipart XHR uses
withCredentials and the API's no-store response policy. Refresh/logout use the
required X-CSRF-Protection: 1 header. Tokens are never read by JavaScript, stored
in browser storage, or exposed to React state. Safe profile and catalog data are
cached in memory. The server alone enforces password strength, ownership, expiry,
lockout and token rotation; form validation covers required input/email format.

The dashboard withholds its content until `/auth/me` succeeds. This is a client
navigation boundary, not server authorization: NestJS guards protect all private
API data. Its server-rendered children contain only public static copy. Future
private Server Components must implement a server authentication boundary rather
than assume this layout protects RSC payloads.

The query checks access on mount, window focus/reconnect and every 60 seconds while
visible. A 401 triggers one refresh and a new profile fetch. Concurrent checks
share one promise; Web Locks serialize login/logout/refresh across tabs on the
same frontend origin, rechecking access inside the lock. No blind retries of
refresh mutations. A network/invalid-response/5xx ambiguity during rotation
requires reauthentication after the next access rejection. Browsers without Web
Locks use existing sessions but require login again on expiry. Web Locks require
a secure context (HTTPS, or localhost for development). Different frontend origins
do not share locks: deploy one canonical frontend origin for the same cookies.
BroadcastChannel informs other tabs about login/logout without sending tokens.

Failures hide private content and expose retry/login options; confirmed expiry
redirects to login. Logout errors remain visible and do not falsely report success.
Registration conflicts and login errors reveal no additional account metadata.

## Production and limitations

Use HTTPS. The API requires Secure cookies and HTTPS allowed origins in production.
Prefer a same-site frontend/API deployment or a same-origin reverse proxy. Truly
cross-site deployments need SameSite=None; Secure and remain subject to browser
third-party-cookie restrictions. CORS alone cannot override cookie restrictions.
No frontend secrets belong in NEXT_PUBLIC variables.

Production builds fetch the existing Google Fonts unless already cached. Document
list, upload, detail and metadata/lifecycle actions are implemented as described
above. Account settings at `/settings` now support profile editing, password changes
and confirmed logout-all. The password change preserves the current session and
revokes other sessions; logout-all also revokes this browser. Individual session
management UI remains outside this task. See the [real browser verification](../../docs/phase-1-browser-verification.md)
for commands, isolated test data, results and current completion status.

## Historical UI refinement checkpoint

The shared shell uses a responsive sidebar, nested-route active indicators and a
Base UI modal navigation drawer with focus containment, Escape dismissal and focus
return. The account menu shows the signed-in profile and retains the existing
logout flow. Only existing routes appear in navigation. The dashboard links to the
working catalog and upload page without inventing analytics.

Login and registration use a centered card with password visibility controls.
Document pages share consistent sans-serif headings, 44px primary controls,
semantic surfaces, status badges, loading skeletons and clearer form grouping.
Dark-theme accent colors are adjusted for readable text; Light/Dark/System still
use the existing next-themes provider and persisted preference. Reduced-motion
preferences disable decorative transitions and skeleton animation.

Changed frontend files: authentication layout/form; dashboard page; global CSS;
dashboard shell and new mobile navigation; shared Button, LoadingPanel and
StatusBadge; document list, upload, detail and edit presentation; authentication
integration tests; this README. API clients, authentication logic, backend,
environment settings and dependencies are unchanged.

Resumed verification on 18 September 2026 passed: `format:check`, ESLint,
TypeScript checking, all 112 Vitest tests across nine suites, and the Next.js
production build. Focused coverage includes password visibility without submission,
nested-route navigation, drawer Escape/focus return and account-menu logout;
existing theme, upload, editing, lifecycle and error-state tests remain passing.

Headless Chromium checked login, registration, dashboard, document list, upload and
detail in both themes at 375, 768, 1280 and 1440px. All 48 combinations passed
overflow/theme checks, with no console errors; screenshots were inspected and
mobile drawer/account-menu interaction passed. Browser checks used isolated API
fixtures, not developer records. Live API integration, other browser engines and
physical-device accessibility remain manual checks. No additional feature scope
or Phase 1 completion is claimed by this visual refinement.

## Historical theme verification checkpoint

The dashboard header includes a **Change theme** menu with Light, Dark, and System
options. It reuses the root `next-themes` provider and existing semantic light/dark
CSS variables. The selection is stored in browser localStorage under `theme`;
System follows changes to the operating system preference. The provider's initial
script applies the theme before hydration, and only the existing root `<html>`
uses `suppressHydrationWarning`. Menu icons use CSS so their server and client
markup stays consistent. The menu supports keyboard navigation and shows a check
beside the selected option.

Theme verification includes component tests for selection, persistence, system
changes, and keyboard focus. An isolated Edge production-browser check with a
mocked current-user response verified all modes, reload/initial theme, keyboard
interaction, and header widths of 1440, 375, and 320 pixels with no console or
hydration errors. Other browser engines and physical mobile devices were not
tested.

```sh
npm --prefix apps/web run format
npm --prefix apps/web run format:check
npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix apps/web run build
```

Vitest/Testing Library tests exercise components through the real API client with
mocked HTTP responses: validation, login/register, safe errors, protected loading,
expiry, refresh concurrency/replay precautions, logout and mobile navigation.
They do not replace a live browser check of deployment-specific CORS/SameSite rules.

Verified for this implementation: formatting/check, ESLint, TypeScript, 20 tests
across two suites, and the production build all passed. A temporary production
server returned the expected initial states for `/login`, `/register` and
`/dashboard`; it was stopped afterward. Next.js and its lint configuration were
updated within version 16 to 16.3.5 to address the starter's dependency advisories;
the resulting install audit reported zero vulnerabilities. The existing typography
and theme were preserved, and Turbopack's root is explicitly `apps/web`.

## Complete local Docker stack

From the repository root, follow [Compose setup](../../docs/compose.md). The web
image uses standalone output and fixes the browser API base to `/api/v1` at build
time; root UPLOAD_MAX_BYTES supplies its public upload-size UX setting. Existing
apps/web/.env.local is excluded from the Docker build context. Only Nginx publishes
a port. Local `npm run dev` commands and direct API URLs remain supported.
Container startup, persistence and browser workflows have passed; see
[final browser verification](../../docs/phase-1-browser-verification.md).

## Phase 4 AI Search — T11 implemented

The authenticated `/ai` page consumes the semantic-search and grounded-answer APIs through AuthApi, validates responses with Zod, and renders generated text literally. Citation Sheets reauthorize sources; exact document/version/chunk pages retain page provenance. Document detail shows authoritative preparation readiness and a confirmed, idempotent repair action. See [T11 contracts and verification](../../docs/phase-4-ai-frontend.md).
