# Categories and tags

[Documentation index](../README.md) | [Documents](documents.md)

Categories provide one optional grouping per document; tags provide multiple labels.
Manage them at `/categories` and `/tags`, then select them during upload or metadata
editing. Both pages support creation, editing, bounded lists and confirmed deletion.
Tags additionally support API substring search; the category API has no search parameter.

## Implementation and API interaction

[CategoriesModule](../../apps/api/src/modules/categories) and
[TagsModule](../../apps/api/src/modules/tags) own CRUD and validation. Models are
`Category`, `Tag`, `Document` and `DocumentTag`. The shared frontend
[organization feature](../../apps/web/features/organization) and
[organization client](../../apps/web/lib/api/organization.ts) serve both pages.
Mutations invalidate organization options and affected document caches.

The clients use the `/api/v1/categories` and `/api/v1/tags` collections and their
item routes. [Generated OpenAPI](../api.md) owns exact DTOs and responses. Both use
session authentication, owner predicates, UUID IDs, cursor pagination and the CSRF
header/Origin policy for mutations. Missing and foreign IDs return the same 404.

## Validation and deletion

Names use NFKC normalization, trimming and collapsed whitespace, with 1-100 Unicode
code points and no controls. PostgreSQL enforces per-owner case-insensitive uniqueness
with `lower(name)` indexes; accent folding is not promised. Concurrent duplicate
creates/renames return 409. Different users may reuse the same name.

Categories also allow a nullable six-digit hex color (stored lowercase) and a nullable
lowercase kebab-case icon slug of at most 50 characters. Slugs are identifiers, never
executable SVG/HTML or paths. The UI maps supported icons and gives unknown ones a
safe fallback. Omission preserves optional values on update; null clears them.

| Action          | Behavior and important edge case                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Delete category | Permanent only when unused; any document reference, including soft-deleted documents, returns 409. No automatic reassignment. |
| Delete tag      | Permanent; removes document-tag joins while retaining every document, including soft-deleted ones.                            |
| Repeat deletion | Returns 404 for the now-missing item; names become reusable.                                                                  |

To remove a used category, reassign or clear the documents' category first. A
soft-deleted document must first be restored through the API; there is no Trash UI.
See [database constraints](../database.md) for composite ownership foreign keys.

## Tests

Category/tag service specs and the corresponding `.e2e-spec.ts` and
`.integration-spec.ts` files in [API tests](../../apps/api/test) cover ownership,
normalization, concurrent uniqueness and deletion constraints.
[Frontend organization tests](../../apps/web/tests/organization.integration.test.tsx)
cover forms, errors, confirmations and cache refresh; [browser tests](../../apps/web/e2e/phase-one.spec.ts)
exercise assigned-category conflicts and tag removal. Historical reports:
[categories](../categories-implementation.md), [tags](../tags-implementation.md),
[organization UI](../web-organization-implementation.md).
