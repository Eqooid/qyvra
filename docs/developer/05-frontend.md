# 05 · Frontend guide

[Guide index](README.md) · [Authentication walkthrough](07-authentication-authorization.md) · [Document walkthroughs](08-document-lifecycle.md)

The frontend uses Next.js App Router. Route files compose UI; interactive feature components fetch private data in the browser. Next.js does not access Prisma or uploaded files.

## Routes and layouts

| URL                                | Route source                                                                 | Behavior                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/`                                | [app/page.tsx](../../apps/web/app/page.tsx)                                  | Redirects to `/dashboard`                                                      |
| `/login`, `/register`              | [app/(auth)](<../../apps/web/app/(auth)>)                                    | Shared public auth layout and `AuthForm`; route-group name is absent from URLs |
| `/dashboard`                       | [app/dashboard](../../apps/web/app/dashboard)                                | Protected welcome/navigation page; no fabricated analytics                     |
| `/documents`                       | [app/documents/page.tsx](../../apps/web/app/documents/page.tsx)              | Catalog with URL-backed filters and cursor navigation                          |
| `/documents/upload`                | [upload/page.tsx](../../apps/web/app/documents/upload/page.tsx)              | Initial file upload form                                                       |
| `/documents/[documentId]`          | [document page](../../apps/web/app/documents/[documentId]/page.tsx)          | Detail, metadata edits, lifecycle actions and current download                 |
| `/documents/[documentId]/versions` | [versions page](../../apps/web/app/documents/[documentId]/versions/page.tsx) | History, version metadata and append upload                                    |
| `/categories`, `/tags`             | [categories](../../apps/web/app/categories), [tags](../../apps/web/app/tags) | Shared organization feature configured for each kind                           |
| `/settings`                        | [settings](../../apps/web/app/settings)                                      | Profile/password/logout-all                                                    |

[RootLayout](../../apps/web/app/layout.tsx) supplies fonts, global styles, `ThemeProvider` and `AuthProvider`. Protected route layouts wrap their children in [DashboardShell](../../apps/web/components/layout/dashboard-shell.tsx). The shell waits for `useCurrentUser`, shows a recoverable error when the API is unreachable, and redirects to login when the result is unauthenticated. Sidebar/account controls live in `components/layout`.

This client gate is not a server authorization boundary. Do not introduce private Server Component data merely because its page sits under that layout. Also review `useCurrentUser`'s explicit pathname checks when adding protected routes.

## State and transport

[AuthProvider](../../apps/web/features/auth/provider.tsx) creates one QueryClient and one `AuthApi` instance per provider mount. Query and mutation retries default to false. Feature queries include the current owner in cache keys, for example `['documents', owner, queryString]`, `['document', owner, documentId]`, and `['version', owner, documentId, versionId]`.

| State                                                       | Owner                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Remote document/profile/category/tag/history data           | TanStack Query in memory                                                                  |
| Catalog filters and cursor                                  | URL search parameters validated by [query.ts](../../apps/web/features/documents/query.ts) |
| Form fields/errors                                          | React Hook Form with Zod resolvers                                                        |
| Selected file, upload progress, abort controller, retry key | Component state/refs; not persisted across reloads                                        |
| Login/refresh tokens                                        | Browser HttpOnly cookies, inaccessible to React                                           |
| Theme preference                                            | next-themes                                                                               |

[AuthApi](../../apps/web/lib/api/client.ts) centralizes credentials, CSRF, timeout, safe errors, runtime response checks, and guarded refresh. JSON calls have a 10-second timeout; multipart XHR has a 240-second timeout and passes progress events. `apiBaseUrl` accepts `/api/v1` or a public HTTP(S) URL ending in `/api/v1`, with no embedded credentials/query/hash.

Domain clients in [lib/api](../../apps/web/lib/api) define requests and Zod response schemas: `documents.ts`, `upload.ts`, `versions.ts`, `organization.ts`, and `account.ts`. There is no generated TypeScript client or implemented shared contracts package. Changes to backend projections may therefore require explicit updates here.

## Example: edit a document

1. [DocumentDetailPage](../../apps/web/features/documents/document-detail.tsx) fetches the owned document and opens `DocumentEdit`.
2. [document-edit.tsx](../../apps/web/features/documents/document-edit.tsx) loads category/tag options, validates input, and calls the parent save callback. [edit-metadata.ts](../../apps/web/features/documents/edit-metadata.ts) builds a patch distinguishing omission from explicit clearing.
3. [updateDocument](../../apps/web/lib/api/documents.ts) constructs an allowlisted body and calls `AuthApi.mutate` with PATCH and the CSRF header.
4. The API updates metadata and associations in one transaction, then returns a safe detail view.
5. The detail feature updates/refetches detail and invalidates the owner's catalog. UI errors preserve recoverable input and offer retry/reload paths.

There is no ETag conflict prevention. The UI hides metadata editing for archived documents, although the API accepts edits to owned non-deleted archived records. Version upload has stronger server-side lifecycle restrictions.

## Forms, loading, and errors

**v1.2.0 T12 processing view:**
[processing.ts](../../apps/web/lib/api/processing.ts) validates the owned
version-status response, including nullable disposable progress. The
[processing status component](../../apps/web/features/documents/processing-status.tsx)
shows current-version status on document detail and a selected historical
version's status in its inspection panel. Query keys include owner, document, and
version IDs. Active jobs poll every five seconds through TanStack Query; completed,
failed, cancelled, and unscheduled versions do not. The document list makes no
per-row status requests. A failed status fetch leaves document details usable and
offers a retry; a processing failure displays only a sanitized category. The
frontend never accesses Redis or RabbitMQ directly.

[AuthForm](../../apps/web/features/auth/auth-form.tsx) shares login/registration rendering, clears the password after submission, and translates generic API failures. Registration succeeds without logging the user in. [AccountSettings](../../apps/web/features/account/account-settings.tsx) handles profile, password and logout-all separately; password change checks the session first and does not blindly refresh/retry a wrong-current-password 401.

Document forms use [upload-validation.ts](../../apps/web/features/documents/upload-validation.ts), including the public file-size UX limit. Browser validation improves feedback; the API independently validates bytes, metadata and ownership. Initial/version upload components retain unchanged attempts for explicit retry. Cancellation or navigation can race a completed server transaction.

Data components render loading, empty, error and success states using reusable controls such as [LoadingPanel](../../apps/web/components/shared/loading-panel.tsx), alerts and confirmation dialogs. `ApiError` carries HTTP status and optional trace ID; malformed success payloads are treated as client-side 502 errors. A connection error is represented with status 0. Generic errors avoid trusting backend exception text.

Auth changes use BroadcastChannel without token data. The provider polls the current user every minute on protected routes and rechecks on focus. Login/logout clear query state; feature mutations invalidate related owner-specific caches. See [session synchronization](07-authentication-authorization.md#frontend-session-synchronization).

## Components, styling, and utilities

[components.json](../../apps/web/components.json) configures shadcn's `base-nova` style, Base UI-oriented primitives, Lucide icons, and `@/` aliases. Reuse [components/ui](../../apps/web/components/ui); inspect `render`-based composition in existing menus/buttons before introducing another primitive style.

[globals.css](../../apps/web/app/globals.css) holds Tailwind 4 setup and theme tokens. [ThemeProvider](../../apps/web/components/theme-provider.tsx) uses a class-based Light/Dark/System theme and a `D` hotkey, excluding typing targets and modified/repeated events. [theme-toggle.tsx](../../apps/web/components/theme-toggle.tsx) provides explicit selection. Root layout loads Inter, JetBrains Mono and Geist Mono through `next/font/google`; builds can require font-network access.

[use-mobile.ts](../../apps/web/hooks/use-mobile.ts) supports responsive components. [lib/utils.ts](../../apps/web/lib/utils.ts) re-exports `cn` from the installed `cn` library. Shared status/date/confirmation controls live under `components/shared`; feature-specific icons and validation stay with their feature.

The backend supports document-date and expiration-date range queries. The current [DocumentQuery](../../apps/web/lib/api/documents.ts) and catalog URL controls do not expose those ranges. Do not infer UI functionality from the broader API contract.
