# Category and tag management UI — 18 September 2026

> Historical implementation checkpoint. Scope, test counts, file locations and pending
> work below describe that task, not current release status. Phase 1 is complete;
> use the [v1.0.0 snapshot](releases/v1.0.0.md) and [current guides](README.md) for the baseline.

## Routes and contract

Authenticated `/categories` and `/tags` pages reuse DashboardShell and its desktop
and mobile navigation. The current-user hook's route allowlist now includes these
pages; cookie/session/refresh behavior is unchanged. No backend or schema changes.

The existing endpoints are used unchanged:

| Collection | List/create                   | Update/delete                                 |
| ---------- | ----------------------------- | --------------------------------------------- |
| Categories | GET/POST `/api/v1/categories` | PATCH/DELETE `/api/v1/categories/:categoryId` |
| Tags       | GET/POST `/api/v1/tags`       | PATCH/DELETE `/api/v1/tags/:tagId`            |

Lists reuse the existing bounded option queries: limit 100, sort=id, ascending
UUID cursor and explicit Load more. There are no usage counts or all-document
queries. Safe response schemas are reused from the document client.

## Forms and deletion

React Hook Form/Zod dialogs normalize names with Unicode NFKC, trim and collapsed
whitespace, preserving display case. Names must contain 1–100 Unicode characters
and no remaining control characters. The backend enforces case-insensitive
per-owner uniqueness. Conflict feedback explains this without inspecting other
users' data. Unchanged normalized edits and repeated submissions are disabled.
Recoverable errors keep the form and values open. Closing and reopening resets
the form from its selected item; dialogs contain focus and return it on close.

Categories support name and nullable color/icon. Controlled palettes use six-digit
hex colors and known icon slugs. An existing custom hex/slug is retained as an
option, so a rename does not silently remove styling. Unknown icons render a
known fallback; strings never become markup or executable code. Hex validation
precedes rendering a swatch. Selecting default styling sends null. Tags send only
name. Mutation bodies explicitly exclude owner IDs and unsupported fields.

Category deletion is permanent and blocked by any document reference, including
soft-deleted documents. The confirmation explains that documents are neither
deleted nor automatically uncategorized. Tag deletion permanently removes the tag
and its assignments, while preserving documents. Failed deletion stays open with
safe feedback. Missing/already-deleted/foreign IDs share the API's neutral 404.

## State, ownership and feedback

Both routes use the existing authenticated client and CSRF header. Queries are
scoped by collection and authenticated owner, sharing category/tag option caches
with document forms and filters. Successful mutations invalidate the collection,
document-list and document-detail queries for that owner. Success notices use
live status semantics. Failed refreshes expose retry UI without reporting a
committed mutation as failed. HTTP 401 uses existing login redirection; 403/404/409
are mapped to safe actionable messages. The backend remains the ownership authority.

## Files changed

- `apps/web/app/categories/{layout,page}.tsx`
- `apps/web/app/tags/{layout,page}.tsx`
- `apps/web/features/organization/organization-page.tsx`
- `apps/web/features/organization/organization-editor.tsx`
- `apps/web/features/organization/{validation.ts,category-style.tsx}`
- `apps/web/lib/api/organization.ts`
- `apps/web/lib/api/documents.ts` (exports existing safe schemas)
- `apps/web/features/auth/provider.tsx` (new protected routes only)
- `apps/web/components/layout/dashboard-shell.tsx` (navigation entries)
- `apps/web/tests/organization-client.test.ts`
- `apps/web/tests/organization.integration.test.tsx`
- Frontend README, roadmap and this report.

## Verification

From `apps/web`: `npm run format`, `format:check`, `lint`, `typecheck`, `test`
and `build` passed. ESLint is clean. The full suite passed **163 tests across
13 suites**, including 31 new category/tag tests. The focused 31 tests passed
again after the final form/compiler lint adjustments; the final production build
also passed. Tests exercise the real forms, query hooks and API client while
mocking only HTTP responses.

Coverage includes both lists and states, create/validation/conflict, normalized
unchanged edits, rename, delete confirmation/success/failure, owner-scoped query
invalidation, duplicate-submit guards, expired sessions and safe 403/404 failures.

Production Chromium checks passed both pages in light/dark at 375, 768 and 1440px,
without horizontal overflow or console errors. Create/edit/delete and dialog
focus checks passed; screenshots were visually reviewed. Browser checks used
isolated API fixtures, not developer data. Live API cookies/CORS and physical-device
or screen-reader checks remain manual. No new dependencies, environment settings,
migrations or Phase 2 functionality were introduced.
