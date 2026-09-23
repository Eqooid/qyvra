# Frontend component audit — 22 September 2026

The application uses the official shadcn **base-nova / Base UI** registry,
Tailwind v4 (`app/globals.css`), neutral base and existing orange brand tokens,
CSS variables, Lucide icons and the existing `@/` aliases. The independent npm
package and `components.json` configuration are preserved. Reference:
[official components](https://ui.shadcn.com/docs/components).

## Audit and replacements

| Existing pattern | Location | Official foundation | Result |
| --- | --- | --- | --- |
| Existing generated primitives | `components/ui` | Button, Input, Field, Select, Accordion, Calendar, Popover, Table, Card, DropdownMenu, Label, Separator | Retained; no CLI overwrite |
| Fixed sidebar and separate mobile navigation | `components/layout` | Sidebar, Sheet, Tooltip | Replaced with one responsive composition |
| Account icon and theme menu | Application header | Avatar, DropdownMenu | Avatar added; account/logout and Light/Dark/System behavior retained |
| Hand-built alert-dialog surface | Confirmation wrapper | AlertDialog | Surface replaced; async pending/error, cancellation and retry retained |
| Hand-built modal surface | Category/tag editor | Dialog | Replaced; title/description, guarded dismissal and return focus retained |
| Raw auth and editor controls | Login, registration, metadata, organization | Input, NativeSelect, Field, Checkbox | Standardized without schema changes |
| Synthetic Select registration, incorrect label targets | Upload | Select + RHF Controller, Field | Controlled values, blur/ref/errors, associated labels and disabled state |
| Date picker form integration | Upload/edit | Calendar + Popover + Field | Reusable composition moved to `shared`; empty strings, focus ref and errors preserved |
| Status and tag pills | Catalog/detail/history | Badge | Standardized; textual status retained |
| Hand-built skeleton and progress | LoadingPanel and uploads | Skeleton, Spinner, Progress | Standardized; indeterminate progress and live status preserved |
| Repeated empty/error/success surfaces | Dashboard, catalog, history, categories/tags | Empty, Alert, Card | Standardized; retry/dismiss actions retained |
| Native version table | Version history | Table | Responsive rows and metadata inspection retained |
| Cursor pagination navigation | Catalog | Pagination with Button actions | Server cursor behavior unchanged |
| Existing configurable data table | Catalog | Table + existing TanStack Table | Retained, including column menu and server-owned ordering |
| Semantic layout and metadata | All routes | Native main, section, form, fieldset, dl, ul | Retained where no primitive adds value |

Audited routes: `/`, `/login`, `/register`, `/dashboard`, `/documents`,
`/documents/upload`, `/documents/[documentId]`,
`/documents/[documentId]/versions`, `/categories`, `/tags`. Their loading,
empty, unavailable, validation and API-error branches were included. Next.js
supplies the default global not-found page. There are no implemented profile,
password, session-management or application-settings pages, custom global error
page, toast system, or additional navigation destinations to standardize.

## Added official components

Sidebar, Sheet, Tooltip, Dialog, AlertDialog, Avatar, Badge, Skeleton, Spinner,
Progress, Alert, Empty, NativeSelect, Checkbox and Pagination. The CLI also added
`hooks/use-mobile.ts`. That hook uses `useSyncExternalStore` for the existing
768px breakpoint to satisfy React lint rules without an effect-triggered state
update. Existing primitives and theme variables were not overwritten.

## Removed duplicates and retained compositions

- Removed `components/layout/mobile-navigation.tsx`; Sidebar owns mobile Sheet
  behavior. `AppSidebar` composes the official primitives and Next.js Links.
- Removed the custom modal markup from organization editing and confirmation.
  `ConfirmationDialog` moved from `ui` to `shared`: it owns async submission,
  duplicate-submit protection, safe errors, initial Cancel focus and retry.
- Moved `DatePickerControl` from `ui` to `shared`: it adapts date-only form
  strings to Calendar and returns empty strings when cleared. It is not a
  competing date-picker primitive.
- Retained `LoadingPanel` and `StatusBadge` as labeled skeleton and document
  status compositions. Both now use official primitives.
- Retained feature forms, upload dropzone/file summary, document table,
  metadata/history and organization styling: these represent document behavior,
  data fetching, file validation, pagination or safe category styling.
- Retained the authenticated shell, theme provider and theme menu: they own
  authentication boundaries, preference persistence and the existing shortcut.

## Interaction and accessibility

SidebarProvider/SidebarInset replace fixed content offsets. SidebarMenuButton
uses `isActive`; nested routes retain `aria-current`. The header trigger exposes
expanded state and supports desktop collapse and the official Ctrl/Cmd+B shortcut.
Collapsed desktop navigation has tooltips; mobile navigation has a labeled close
button, focus containment, Escape dismissal and link dismissal. Tooltips are
mounted only for collapsed desktop links, preventing a hidden mobile tooltip
from consuming Escape. There is only one main landmark.

Forms consistently use Field/FieldLabel/FieldError with RHF and existing Zod
schemas. NativeSelect keeps native registration; Select, Checkbox and Calendar
use controlled bindings. Validation descriptions are associated with their
controls. Upload category/tag lookup loading, errors, retries and bounded Load
more controls are present. Cancel upload stays outside the disabled fieldset.
Progress uses accessible progressbar values, including indeterminate state.
Existing server errors, schemas, query keys, API clients and mutations remain.

## Verification

The original run passed 166 tests across 13 suites and a production build. Its
Edge checks covered all nine implemented pages in light/dark at 375, 768 and
1440px (54 combinations), without horizontal overflow, nested interactive markup,
or browser console errors. Desktop collapse/tooltips, mobile Escape/focus return
and navigation dismissal, organization dialogs, theme selection and the account
menu passed. Mobile/desktop screenshots were inspected. These browser checks
used intercepted API fixtures and temporary browser tooling; the tooling was
removed and dependencies restored to the existing lockfile afterward.

Continuation on 22 September recovered those results without repeating the audit
or installing components. All direct installed dependency versions were checked
against the lockfile: zero mismatches. The Sidebar migration was already complete.
The final document-route Suspense fallback uses the shared Skeleton composition.

| Continuation check | Result |
| --- | --- |
| `npm run typecheck` | Passed, no TypeScript errors |
| `npm run lint` | Passed, no warnings/errors |
| `npm run format:check` | Passed for all matched TypeScript/TSX files |
| `npm run build` | Passed on locked dependencies; 11 routes generated, including two dynamic document routes |
| Full test run, then affected-suite rerun | All 166 tests verified: 11 unchanged suites passed in the full run; both corrected suites passed all 34 tests on rerun |

The build required network access only for the existing Google Fonts. No theme
or font configuration was changed. The full test run used `npm test --
--maxWorkers=2`: 164 passed and two test failures were diagnosed. The new active
state assertion expected a string value instead of Base UI's boolean attribute;
the real calendar's thirteen month-navigation interactions exceeded the default
five-second timeout. The assertion was corrected and only that calendar test
received a 15-second timeout. Mobile-link testing now prevents jsdom's unsupported
native navigation while exercising the application's dismissal handler. Neither
fix changes production behavior. Both affected test files were formatted and
passed focused ESLint afterward.

The focused rerun was `npm test -- tests/auth.integration.test.tsx
tests/detail.integration.test.tsx --maxWorkers=1`: **34 passed, 2 suites passed**.
The other 11 passing suites were not repeated after test-only corrections.
Production code was unchanged after the successful build. Prior browser checks
were reused for the unchanged page compositions, rather than reinstalling
browser tooling. Temporary scripts, screenshots and verification logs were
removed after their results were recorded here. No known frontend verification
failure remains.

## Remaining review boundaries

Native browser navigation/unload confirmations remain: they protect unsaved
changes and active transfers, including browser-controlled unload. Category
color swatches remain domain data, not theme colors. File drop behavior and
selected-file summaries are specialized compositions. These are intentional
custom UI, not duplicate primitives. Live API cookie/CORS/storage integration,
physical-device and screen-reader verification remain separate from fixture-based
frontend checks.
