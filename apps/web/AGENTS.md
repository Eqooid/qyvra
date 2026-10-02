# QYVRA Web — Agent Instructions

These instructions extend the repository-root `AGENTS.md` for `apps/web`.

Read [the documentation index](../../docs/README.md), [frontend architecture](../../docs/architecture.md#frontend-and-api-communication)
and the relevant feature guide before editing.

## Frontend stack

- Next.js App Router
- React and strict TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query for remote server state
- React Hook Form with Zod for forms

## Frontend rules

- Reuse existing components from `components/ui`; do not recreate shadcn primitives.
- Use Server Components by default and add `"use client"` only when browser APIs, client hooks, local interactive state, or event handlers require it.
- Keep route composition in `app`, feature behavior in `features`, reusable layout in `components/layout`, and generic components in `components/shared`.
- Keep HTTP access in `lib/api` or the established API-client layer.
- Do not duplicate NestJS business logic in Next.js.
- Never expose secrets through `NEXT_PUBLIC_*` variables.
- Every data-driven page must provide loading, empty, error, and success states.
- Forms must provide accessible labels, keyboard support, validation messages, and safe submission states.
- Interfaces must work on desktop and mobile.
- Use `docs/api.md` for conventions and generated OpenAPI for endpoint contracts; do not silently invent incompatible response shapes.
- Temporary mock data must be isolated behind the same interface used by the future API client and clearly marked for removal.

Before completing frontend work, run the available lint, type-check, test, and production-build commands from this application or the workspace root.

