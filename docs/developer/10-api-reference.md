# 10 · API reference and route map

[Guide index](README.md) · [HTTP conventions](../api.md)

This is a navigation reference extracted from the inspected controllers. Full schemas and response decorators are generated at [Swagger UI](http://localhost:8080/api/v1/docs/) and [OpenAPI JSON](http://localhost:8080/api/v1/docs-json) when Compose is running. For host development use port 3001. Generation lives in [configure-swagger.ts](../../apps/api/src/configure-swagger.ts); no static OpenAPI export is checked in.

**All table paths are relative to `/api/v1`.** `Session` means the configured access cookie and `SessionAuthGuard`; `Refresh` means the configured refresh cookie. For protected mutations, **CSRF** means `X-CSRF-Protection: 1`, the browser Origin policy and rejection of query input. These shared requirements apply to every such row below.

JSON success is `{data, meta: {requestId}}`; collection pages add `meta.nextCursor` and `meta.hasMore`, except session listing. Errors use `{error: {code, message, details: {}, traceId}}`. Unknown DTO properties are rejected. Common transport failures are 400 invalid input, 413 body limit, 415 unsupported media, and safe 500 for unexpected failures. Protected routes can return 401; CSRF/Origin rejection returns 403. UUID path arguments are validated. All APIs are no-store. Proxy-generated errors may not follow the JSON envelope.

## Authentication

Sources: [registration controller/DTO](../../apps/api/src/modules/auth/registration.controller.ts), [RegistrationDto](../../apps/api/src/modules/auth/registration.dto.ts), [login controller](../../apps/api/src/modules/auth/login.controller.ts), [LoginDto](../../apps/api/src/modules/auth/login.dto.ts), [session lifecycle controller](../../apps/api/src/modules/auth/session-lifecycle.controller.ts), [current user controller](../../apps/api/src/modules/auth/current-user.controller.ts).

| Method | Path             | Auth/security                                         | Input and purpose                                | Success `data`                                    | Important errors                                                         |
| ------ | ---------------- | ----------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------ |
| POST   | `/auth/register` | Public; auth rate budget                              | JSON `email`, `password`; register local account | 201 `{id,email}`; no cookies                      | 400 policy/email; 409 duplicate; 429 throttle                            |
| POST   | `/auth/login`    | Public; allowlisted supplied Origin; auth rate budget | JSON `email`, `password`; establish session      | 200 `{user:{id,email},expiresAt}` and two cookies | 401 invalid/deleted/locked account or password; 403 Origin; 429 throttle |
| GET    | `/auth/me`       | Session                                               | Current authenticated profile                    | 200 profile                                       | 401                                                                      |
| POST   | `/auth/refresh`  | Refresh; CSRF                                         | No body or `{}`; rotate both credentials         | 200 `{expiresAt}` and replacement cookies         | 401 invalid/expired/replayed refresh; 403; 429                           |
| POST   | `/auth/logout`   | Cookies optional; CSRF                                | No body or `{}`; revoke identified session       | 200 `{loggedOut:true}` and cleared cookies        | 400 malformed body/query; 403                                            |

Email is trimmed/lowercased, max 320, validated without UTF-8 local parts. Login password is nonempty with transport max 2048; registration has the same transport ceiling and configurable strength enforced by `PasswordService` (default 15–128 code points). Passwords are never normalized. Refresh replay revokes the session; serialize calls. See [auth walkthrough](07-authentication-authorization.md).

## Account/profile and sessions

Sources: [ProfileController](../../apps/api/src/modules/auth/profile.controller.ts), [profile DTOs](../../apps/api/src/modules/auth/profile.dto.ts), [SessionManagementController](../../apps/api/src/modules/auth/session-management.controller.ts).

Profile shape is `{id,email,displayName,locale,timezone}`; displayName may initially be null.

| Method | Path                      | Auth/security                      | Input and purpose                                                         | Success `data`                                          | Important errors                                                     |
| ------ | ------------------------- | ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/me`                     | Session                            | Compatibility current-profile route                                       | 200 profile                                             | 401                                                                  |
| PATCH  | `/me`                     | Session; CSRF                      | Nonempty partial JSON: `displayName`, `locale`, `timezone`                | 200 updated profile                                     | 400 unsupported/invalid/null fields; 401/403                         |
| PATCH  | `/me/password`            | Session; CSRF; login/global budget | JSON `currentPassword`, `newPassword`; revoke other sessions after change | 200 `{passwordChanged:true}`                            | 400 new-password policy; 401 incorrect/non-local credential; 403/429 |
| POST   | `/auth/logout-all`        | Session; CSRF                      | No body or `{}`; revoke all owned sessions                                | 200 `{loggedOut:true}`, cleared cookies                 | 401 after revocation or no valid session; 403                        |
| GET    | `/me/sessions`            | Session                            | `limit` 1–100, default **50**; optional UUID `cursor`                     | 200 `{sessions:[...],nextCursor}`                       | 400 query; 401                                                       |
| DELETE | `/me/sessions/others`     | Session; CSRF                      | No body or `{}`; preserve current session                                 | 200 `{revokedCount}`                                    | 400/401/403                                                          |
| DELETE | `/me/sessions/:sessionId` | Session; CSRF                      | UUID ID; no body or `{}`                                                  | 200 `{revoked:true}`; current revocation clears cookies | 400/401/403; 404 missing/foreign                                     |

Display name is trimmed/nonempty/max 100; null is rejected. Timezone must be UTC or an IANA name supported by runtime; locale must be canonical supported BCP 47, max 35. Email is not editable. Session views expose ID, created/lastSeen/access/refresh expiry timestamps and `isCurrent`, with no hashes or device data. Sessions sort ascending UUID, and pagination is inside `data`, not generic collection `meta`.

## Documents

Sources: [DocumentsController](../../apps/api/src/modules/documents/documents.controller.ts), [UploadController](../../apps/api/src/modules/documents/upload.controller.ts), [document DTOs](../../apps/api/src/modules/documents/documents.dto.ts), [upload receipt](../../apps/api/src/modules/documents/upload.dto.ts).

| Method | Path                             | Auth/security                         | Input and purpose                                               | Success                                       | Important errors                                                                                                          |
| ------ | -------------------------------- | ------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/documents`                     | Session                               | Supported query fields below; list owned non-deleted metadata   | 200 document array and pagination meta        | 400 filters/cursor; 401                                                                                                   |
| POST   | `/documents`                     | Session; CSRF; UUID `Idempotency-Key` | Multipart one `file`, required `title`, optional metadata below | 201 creation receipt including safe version 1 | 400 input/inspection; 404 association; 408 timeout; 409 duplicate/key; 413 bytes; 415 media; 429 capacity; 503 dependency |
| GET    | `/documents/:documentId`         | Session                               | UUID ID; no supported query fields                              | 200 document metadata with category/tags      | 400; 401; 404 missing/foreign/deleted                                                                                     |
| PATCH  | `/documents/:documentId`         | Session; CSRF                         | Nonempty partial editable metadata JSON                         | 200 updated document metadata                 | 400 field/date rules; 401/403; 404 document/association                                                                   |
| POST   | `/documents/:documentId/archive` | Session; CSRF                         | No body or `{}`                                                 | 200 document metadata, ARCHIVED               | 400/401/403; 404 deleted/missing/foreign; 409 state                                                                       |
| POST   | `/documents/:documentId/restore` | Session; CSRF                         | No body or `{}`; archive or soft-deletion recovery              | 200 document metadata, UPLOADED when restored | 400/401/403/404; 409 state                                                                                                |
| DELETE | `/documents/:documentId`         | Session; CSRF                         | No body or `{}`; soft deletion only                             | 200 metadata including deletedAt              | 400/401/403/404; 409 state                                                                                                |

Read/list metadata includes ID, title/type/status, issuer/reference, document/expiration dates, verifiedSummary, archive/deletion and creation/update timestamps, category and tags. Owner/key/checksum are omitted. Initial upload has a distinct receipt projection including `version`; do not assume all document responses contain file metadata.

| Document query                   | Contract                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `limit`, `cursor`                | Limit default 25/max 100; opaque base64url cursor max 512                                              |
| `sort`                           | `-createdAt` default or `createdAt`; UUID tie-breaker                                                  |
| `q`                              | Trimmed literal case-insensitive substring of title/issuer/reference; 1–200 characters                 |
| `status`                         | UPLOADED, PROCESSING, READY, PARTIALLY_READY, FAILED, ARCHIVED, DELETING vocabulary; no worker implied |
| `documentType`                   | Uppercase identifier starting with letter, max 50                                                      |
| `categoryId`, `tagId`            | UUID association filters within owner scope                                                            |
| `archived`                       | Literal `true`/`false`; omission does not exclude archives                                             |
| `dateFrom`, `dateTo`             | Inclusive **documentDate** bounds, real `YYYY-MM-DD`                                                   |
| `expirationFrom`, `expirationTo` | Inclusive expiration-date bounds                                                                       |

Metadata fields: title (1–300 trimmed), documentType (uppercase max 50), nullable issuer/referenceNumber (nonempty max 200 when present), nullable documentDate/expirationDate, nullable categoryId, and tagIds (up to 100 deduplicated UUIDs). Dates must remain ordered. PATCH omission preserves; null clears supported nullable fields; `[]` clears tags. Ownership/status/summary/file metadata are not writable. For multipart, optional fields are strings and tagIds is a JSON array string; omit absent values. New document type defaults to OTHER.

## Document versions and download

Sources: [VersionsController](../../apps/api/src/modules/documents/versions.controller.ts), [VersionListQuery and view](../../apps/api/src/modules/documents/versions.dto.ts), [DownloadController](../../apps/api/src/modules/documents/download.controller.ts).

| Method | Path                                         | Auth/security                         | Input and purpose                                                     | Success                                    | Important errors                                                                 |
| ------ | -------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| GET    | `/documents/:documentId/versions`            | Session                               | `limit` default 25/max 100, UUID `cursor`, `sort=-versionNumber` only | 200 safe version array and pagination meta | 400 invalid/unavailable cursor/body/query; 401; 404 parent                       |
| GET    | `/documents/:documentId/versions/:versionId` | Session                               | UUID document/version IDs; no query/body input                        | 200 safe version metadata                  | 400/401; 404 missing/foreign/mismatched parent                                   |
| POST   | `/documents/:documentId/versions`            | Session; CSRF; UUID `Idempotency-Key` | Multipart exactly one file, **no metadata fields**                    | 201 `{documentId,status,version}`          | Upload errors above; 404 target; 409 archive/PROCESSING/DELETING, duplicate/key  |
| GET    | `/documents/:documentId/download`            | Session                               | UUID ID; no query/body; current original only                         | 200 binary attachment, no envelope         | 400/401; 404 parent; 409 no/ambiguous current version; 503 storage/read/metadata |

Version views expose id, versionNumber, originalFilename, mimeType, fileSize, nullable pageCount, extractionStatus, createdAt and isLatest. Archived history/download remain available; deleted/DELETING documents are unavailable. Latest is highest version number. A version-upload replay returns creation-time `isLatest`; refetch history for current truth. Download ignores Range and sends full bytes with `Accept-Ranges: none`. Post-header errors terminate the stream.

## Categories and tags

Sources: [CategoriesController](../../apps/api/src/modules/categories/categories.controller.ts), [category DTOs](../../apps/api/src/modules/categories/categories.dto.ts), [TagsController](../../apps/api/src/modules/tags/tags.controller.ts), [tag DTOs](../../apps/api/src/modules/tags/tags.dto.ts), [CursorQuery](../../apps/api/src/common/cursor-query.ts).

| Method | Path                      | Auth/security | Input and purpose                                       | Success                                | Important errors                            |
| ------ | ------------------------- | ------------- | ------------------------------------------------------- | -------------------------------------- | ------------------------------------------- |
| GET    | `/categories`             | Session       | `limit` default 25/max 100, UUID cursor, `sort=id` only | 200 category array and pagination meta | 400 unsupported query; 401                  |
| POST   | `/categories`             | Session; CSRF | JSON name, optional nullable color/icon                 | 201 category                           | 400/401/403; 409 duplicate                  |
| PATCH  | `/categories/:categoryId` | Session; CSRF | Nonempty partial name/color/icon                        | 200 category                           | 400/401/403/404; 409 duplicate              |
| DELETE | `/categories/:categoryId` | Session; CSRF | No body or `{}`; delete unused category                 | 200 `{deleted:true}`                   | 400/401/403/404; 409 any document reference |
| GET    | `/tags`                   | Session       | Same cursor settings; optional normalized `q` (1–100)   | 200 tag array and pagination meta      | 400; 401                                    |
| POST   | `/tags`                   | Session; CSRF | JSON name                                               | 201 tag                                | 400/401/403; 409 duplicate                  |
| PATCH  | `/tags/:tagId`            | Session; CSRF | JSON name required                                      | 200 tag                                | 400/401/403/404; 409 duplicate              |
| DELETE | `/tags/:tagId`            | Session; CSRF | No body or `{}`; delete tag and its joins               | 200 `{deleted:true}`                   | 400/401/403/404                             |

Names are normalized NFKC/trimmed/collapsed whitespace, 1–100 characters with no controls, unique per owner ignoring case. Category color is nullable six-digit hex stored lowercase; icon is a nullable lowercase kebab-case slug max 50. Omission preserves optional update values. Category/tag views expose id/name/createdAt/updatedAt; categories add color/icon. Both list in ascending UUID order. There are no individual category/tag GET routes. Repeat deletion returns 404. Category search is not supported. The tag deletion Swagger sentence claiming no relationships is stale; SQL cascades document-tag joins.

## Public application and health

Sources: [AppController](../../apps/api/src/app.controller.ts), [HealthController](../../apps/api/src/modules/health/health.controller.ts).

| Method | Path            | Auth   | Input/purpose                                 | Success                      | Important errors               |
| ------ | --------------- | ------ | --------------------------------------------- | ---------------------------- | ------------------------------ |
| GET    | `/`             | Public | Application information; no documented inputs | 200 `{name,apiVersion:"v1"}` | Safe 500 on unexpected failure |
| GET    | `/health/live`  | Public | Process-only liveness                         | 200 `{status:"ok"}`          | No dependency probe            |
| GET    | `/health/ready` | Public | Lifecycle and bounded PostgreSQL probe        | 200 `{status:"ready"}`       | 503 unavailable/shutting down  |

Swagger also serves `/api/v1/docs/` and `/api/v1/docs-json`. There are no processing, extracted-text, historical-download, search-index, chat, reminder, external-login, or permanent-purge routes in this release.
