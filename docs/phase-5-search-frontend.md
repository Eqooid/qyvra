# Phase 5 T09 - Search frontend and browser source workflows

Status: **Implemented and locally verified; live Nginx/Compose acceptance pending.**
Date: **15 October 2026**. `VERSION` stays `1.3.1`; v1.4.0 is not released.

[Approved plan](phase-5-search.md) | [API evidence contracts](phase-5-search-evidence.md) |
[Hybrid windows](phase-5-hybrid-search.md) | [Testing](development/testing.md)

## Using Search

Open **Search** in the existing sidebar (`/search`). Enter a query and submit with
Enter or **Search documents**. Keyword needs no model provider. Hybrid combines
keyword and semantic candidates on the backend; semantic-only remains in **AI
Search**. No frontend embeddings, ranking, document fusion or fallback occurs.
If Hybrid is unavailable, **Use Keyword mode** changes the selection; submit again
to request Keyword explicitly. Healthy empty results are different from errors.

Choose search terms or exact phrase matching. The **Filters** dialog supports
category, one tag, file type and literal filename. Apply changes, then submit;
Reset filters removes them. Active filter names are displayed. Category/tag lists
use the existing authenticated endpoints, selectors and bounded lookup pages,
with retry and More controls. Other backend filters, custom sorting and adjustable
page size are not exposed in this first interface. Pages contain at most ten
documents. Archived documents cannot be discovered.

Private suggestions appear after 250 ms for prefixes of 2–200 UTF-16 units.
The server returns at most five authorized title/issuer/reference suggestions.
Use arrows to select, Enter to accept, Escape to dismiss, or click/tap. Selection
fills the input without submitting. Invalid prefixes, failure or no suggestions
never block a manual search. Errors are announced without exposing server details.

Results preserve backend order, one card per document, with bounded excerpts and
optional source actions. Coverage describes eligible documents' index readiness,
not query totals. Missing PDF text may mean metadata-only or unfinished indexing.
**Next page** sends the same query/mode/filters with the opaque cursor and replaces
the displayed page; it does not accumulate old authorized content or refill ranks.
Empty pages can occur after lifecycle changes. A bounded end is not an exhaustive
global result count. When pagination is unavailable, refine or restart the query.
An expired/changed window (409) offers **Restart search** without the old cursor.

## Sources and browser navigation

**View page N source** opens a shadcn Sheet containing the exact document version,
one-based PDF page and bounded canonical text segment. Large pages offer Previous
part/Next part (zero-based backend segments, one-based display). Semantic matches
use the existing exact chunk resolver and `SourceExcerpt` component. Every source
read is reauthorized by the backend; missing/revoked/ineligible sources show an
error, never a substitute current version. Closing restores focus to the source
button and keeps query, filters, current page and results intact.

This is **canonical text navigation**, not binary PDF viewing. Qyvra has no
historical PDF preview/download capability. The interface states this limitation;
it never presents a current-file download as the historical matched version.
Document detail links open in a new tab, preserve the search page, and label that
behavior. No new PDF viewer or storage URLs are introduced.

Raw private queries, snippets, suggestions and cursors are absent from URLs,
localStorage and sessionStorage. Query/mode/match/filter drafts alone use the
existing in-memory TanStack cache, keyed by owner, with its default inactive
five-minute garbage collection. Client-side navigation and browser Back restore
that form draft; results/cursors are not restored and require fresh submission.
Reload, a new tab or cache eviction can lose the draft intentionally. Clear search
resets it. Logout/account transition invalidates search drafts, lookups and sources;
cross-tab auth notifications follow the existing session mechanism. No persistent
query history or new global state library is introduced.

## Architecture and safety

- `app/search` owns route composition and the existing protected DashboardShell.
- `features/search/search-page.tsx` owns mode, request sequencing, bounded pages,
  coverage, errors and owner-keyed workspace lifetime.
- `autocomplete.tsx` cancels obsolete requests and timers, checks response identity
  against the current input/filter context, and implements combobox/listbox ARIA,
  arrow/Enter/Escape interactions and live announcements. Synchronous validation
  errors also follow the optional-suggestions failure path.
- `search-filters.tsx` reuses the document selector, Dialog and organization client.
- `safe-highlight.tsx` converts snippets with `Array.from`: T08 offsets are Unicode
  scalar, zero-based, half-open, relative to the snippet. At most 32 integer,
  ordered, nonoverlapping, in-bounds ranges become React `<mark>` nodes. Invalid
  ranges render the original plain snippet. HTML-like PDF text stays literal;
  no HTML parser, `dangerouslySetInnerHTML` or invented semantic highlights.
- `search-source.tsx` owns the accessible source Sheet and ephemeral authorized
  source query (`gcTime: 0`). Lexical paths are rebuilt from validated UUID/page/
  segment fields; the server-provided `href` is never navigated. Returned identity
  and scalar excerpt length must match the requested reference.
- `lib/api/search.ts` provides strict request allowlists and Zod response schemas
  through the existing AuthApi: cookies, no-store, CSRF and serialized session
  refresh. Search deadlines are 70 seconds; suggestions/source reads use the
  established ten-second transport limit. No browser search-engine connections.

Query/mode/filter edits abort work, clear visible old results/cursors and reject
late responses by sequence. Duplicate submissions are guarded. Search source
ownership must match the result. Backend PostgreSQL authorization remains the
authority; frontend checks are UX/provenance safeguards. Source content is not
kept in result-window cache or treated as an authorization token. No backend API,
database, dependency, environment or deployment contract changes in T09.

Existing shadcn Input, Button, Select, Dialog, Sheet, Alert, Skeleton, labels,
sidebar/theme and focus styles are reused. Layout wraps on mobile, text is bounded
and breakable, focus returns from overlays, loading/errors announce state, and
marks have explicit light/dark contrast. No claim of a complete assistive-technology
audit is made.

## Verification evidence

Recorded commands run from `apps/web` unless stated otherwise:

| Check                                                                                           | Actual result                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Focused client/component tests                                                                  | 23 search tests (12 client, 11 component/integration); mocked HTTP, included in the final suite                                         |
| Full frontend regression suite                                                                  | 237 passed across 23 files: `npm.cmd test -- --maxWorkers=1`                                                                            |
| ESLint, typecheck, Prettier                                                                     | ESLint/typecheck and scoped Prettier pass; repository-wide format check reports 47 pre-existing files                                   |
| `npm.cmd run build`                                                                             | Production Next.js build passes, including `/search`; initial restricted-network font download failed, rerun with network access passed |
| `node node_modules/@playwright/test/cli.js test --config playwright.search.config.ts`           | 5 Chromium tests passed against production Next.js on loopback port 3115; **mocked API**, no Nginx or live search services              |
| Root `node --test infrastructure/test/search-compose.test.cjs`                                  | 1 passed, static private topology/auth and preserved services                                                                           |
| Root Compose `config --quiet` with existing optional search override and synthetic secret paths | Passed; configuration render only                                                                                                       |
| Live Docker/Nginx PDF-to-Elasticsearch-to-browser                                               | **Blocked:** Docker engine pipe is missing; not executed                                                                                |
| OpenAI/Ollama hybrid, real lifecycle isolation and publication                                  | Not verified in T09; retain T04–T08 acceptance gates                                                                                    |

Browser cases exercise autocomplete keyboard selection, safe Unicode/HTML-like
text, exact page source and focus return, filters/reset, opaque paging, explicit
hybrid failure choice, logout, Back/form restoration, cross-tab session clearing,
390px layout, light/dark system themes, mobile sidebar dismissal and semantic-only evidence/exact chunk navigation in Hybrid mode. These are
real browser checks with controlled transport responses, **not live backend E2E**.
Initial browser failures were selector/mocked-session fixture issues, corrected
before the successful run. One concurrent full-suite run hit two existing 5-second timeouts (upload retry and catalog column toggle); the isolated full rerun passed all 237 tests without changing those tests. A punctuation-only suggestion error path and typing
after suggestion selection were fixed and covered by component tests.

To reproduce browser contract checks: build the app, start the existing production
server on loopback port 3115 (`npm.cmd run start -- --hostname 127.0.0.1 --port 3115`)
in a separate terminal, then run the command above; stop that server afterward.
No traces, screenshots or videos containing private responses are recorded. Temporary local Next.js servers started for these checks were stopped. Local Markdown target checks resolved 287 links in the touched guides; `git diff --check` passed. Historical release snapshots were not edited by T09.

`e2e/phase-five-search.spec.ts` defines a separate **unexecuted live** journey:
generated two-page PDF upload, publication polling, page source, private suggestions,
second account exclusion and archive filtering. It skips unless
`E2E_SEARCH_ENABLED=true` and `E2E_PROJECT_NAME=qyvra-e2e[-suffix]`; use the existing
Playwright config only against an isolated Nginx stack on port 18080 with Phase 5
enrollment/worker/serving enabled. It does not provision or enable those services.
Never point this fixture at production. Accounts/documents remain in the disposable
stack; isolated project teardown owns cleanup. Hybrid/model failure/recovery and
full existing live document/RAG browser regression remain separate required gates.

T09 is not marked fully accepted while applicable live checks remain blocked.
Next: **T10 — Backfill, rebuild, reconciliation and operator recovery**. Objective:
make the derived index maintainable after upgrades, loss and outages. No T10
maintenance, rebuild, cleanup or release functionality is implemented here.

## Browser continuation result

The [live continuation ledger](phase-5-live-verification.md) now records a passed
real Nginx/Chromium PDF-to-search/source/isolation/archive workflow (1 test,
15.5 seconds). Earlier Docker-blocked/unexecuted descriptions are historical
for that scenario. Hybrid and full quality/resource acceptance remain open.
