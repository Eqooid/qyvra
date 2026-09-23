# Frontend document data access and list

Implemented only the protected `/documents` list and typed read access for
`GET /documents`, `GET /categories` and `GET /tags`. No backend, schema, migration,
environment or dependency changes. There are no shared frontend contracts in the
current workspace; frontend Zod schemas follow the implemented API and strip fields
not used by the page. No NestJS or Prisma imports cross into the browser.

## Changed files

- `apps/web/lib/api/client.ts`: authenticated envelope reads reuse the existing
  fetch transport, credentials, safe ApiError and serialized currentUser/refresh
  mechanism, with at most one protected-request retry.
- `apps/web/lib/api/documents.ts`: typed requests and validated paginated responses.
- `apps/web/features/auth/provider.tsx`: enables the existing session query on
  document routes. Authentication rules and cookie storage are unchanged.
- `apps/web/components/layout/dashboard-shell.tsx`: Documents navigation and active
  link state; the existing overview greeting remains on the dashboard only.
- `apps/web/app/documents/layout.tsx` and `page.tsx`: protected route composition,
  metadata and Suspense boundary for client URL search parameters.
- `apps/web/features/documents/query.ts` and `documents-list.tsx`: URL allowlist,
  query hooks, filters, responsive results and loading/empty/error states.
- `apps/web/tests/documents-client.test.ts`, `documents.integration.test.tsx` and
  `documents.fixture.ts`: API-boundary tests and non-sensitive synthetic records.
- Web README, roadmap and this report.

Git metadata is absent from this workspace; this inventory is not a Git diff.

## Behavior

URL parameters: q, documentType, status, categoryId, tagId, archived, sort, limit,
cursor. Defaults are newest first and 25 rows (API maximum 100). Unknown parameters
never reach the API. Invalid filter values fall back safely. Document types remain
flexible uppercase identifiers, not a new frontend enum. Search commits after 350 ms;
other controls update immediately. A filter change clears pagination. Opaque cursors
are passed through unchanged; a server-rejected cursor offers First page recovery.
Browser history and reload restore the URL-backed view. Clear filters returns to
the default list. Date-range UI is not added in this slice.

Owner-keyed TanStack queries avoid sharing catalog cache entries between users.
Requests include credentials and reuse the existing authentication refresh flow.
Confirmed expiry clears the current-user context so the existing shell redirects to
login. No tokens are exposed to JavaScript or stored by this feature.

Cards use one column on mobile and two when space allows, semantic theme colors,
wrapped metadata and textual status badges. Search and filters have labels, links
and controls are keyboard reachable, and a native disclosure keeps mobile filters
collapsible without introducing a focus-trapping modal. Pending requests announce
loading; empty accounts link to upload, filtered empty results offer Clear filters,
and failures offer retry without fake fallback records. Category/tag lists have
independent loading/error states and bounded, explicit additional-page loading.

## Verification

Run from `apps/web`: `npm run format`, `npm run lint`, `npm run typecheck`,
`npm run test`, `npm run build`. Production build includes `/documents`.
All commands passed; the full frontend suite passed 45 tests across five files,
including 19 new API/URL/component integration tests. The final search-focus fix
passed a repeated full suite, build and browser checks.
The first build failed to fetch existing Google Fonts in the restricted sandbox;
the unchanged font configuration built successfully with network access.

Browser checks ran the production build at localhost:3100 in installed headless
Chromium with API-boundary fixtures. Light and dark modes both passed at 1440px and
390px, without horizontal overflow. Search debounce, URL/back navigation and native
disclosure keyboard activation passed. No browser-console or hydration errors were
observed. Existing authentication and theme tests are included in the suite.

The configured real API did not respond to its liveness check. Live cookie/CORS and
persisted-data integration therefore still needs manual verification once it is
running. No test account or document was created in the developer database.

## Limits and next task

No backend contract mismatch was found. Initial creation and detail links deliberately
point to future `/documents/upload` and `/documents/{id}` routes; these currently
return not found. There is no upload, detail, edit, download or version UI here.
Filter choices beyond the first 100 require Load more. Pagination is the API's keyset
contract, not numbered pages or a frozen multi-request snapshot.

Next task: Next.js document upload page. Overall Phase 1 remains incomplete.
