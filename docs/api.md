# Brainless API Reference

## Implemented API foundation

### Immutable version history

All routes below require the session cookie and owned, non-deleted document UUID.
Missing and foreign resources return the same 404. No storage keys, owner IDs or
checksums are returned. Historical-version download and processing are unavailable.

- `GET /api/v1/documents/:documentId/versions`: bounded cursor pagination (`limit`
  defaults to 25, maximum 100; UUID `cursor`; only `sort=-versionNumber`). Newest
  version first, with UUID descending as a stable tiebreaker. Returns the standard
  paginated envelope. An unavailable cursor returns 400. Archived history is readable;
  soft-deleted and DELETING documents return 404.
- `GET /api/v1/documents/:documentId/versions/:versionId`: safe version metadata;
  a version from a different document returns 404. The response includes id,
  versionNumber, originalFilename, mimeType, fileSize, pageCount, extractionStatus,
  createdAt and isLatest. List items have the same shape. Reads use a consistent
  transaction snapshot; pagination across requests does not freeze history.
- `POST /api/v1/documents/:documentId/versions`: exactly one multipart `file`, no
  metadata fields or query parameters. Requires UUID Idempotency-Key, CSRF header
  and trusted Origin as initial upload does. All existing streaming size, signature,
  PDF encryption/page, image and receive-time limits apply. Archived, PROCESSING
  and DELETING documents return 409; missing/soft-deleted documents return 404.
  HTTP 201 data is `{documentId,status,version}`. The version has the safe shape
  above. New state is UPLOADED/PENDING; logical metadata and older versions remain
  unchanged. `isLatest=true` in this creation receipt describes creation time.

Version numbers use highest number + 1 under an owned document row lock, with the
existing unique constraint as a backstop. SHA-256 duplicates remain forbidden across
all versions owned by one user, including archived/deleted documents; different
owners may upload identical content. Duplicate conflicts clean the staged object.

Durable idempotency is scoped to owner, operation and target document. The same UUID
can independently identify initial creation and uploads to different documents.
Replay revalidates the file and compares normalized filename, detected MIME, size
and checksum; matching input returns the original 201 receipt, even after a later
version exists. Incompatible input or concurrent receiving requests return 409.
Target ownership/lifecycle is rechecked before replay and commit. The existing
24-hour receipt/lease expiration policy applies. No bytes are stored in receipts.
Errors use the standard envelopes: 400 validation, 401 authentication, 403 CSRF,
404 unavailable resource, 409 duplicate/lifecycle/replay conflict, 413 size,
415 media mismatch, 408 receive timeout, 429 admission limit and 503 infrastructure.

### Secure current-version download

`GET /api/v1/documents/:documentId/download` requires the existing session cookie
and a UUID documentId. It accepts no query or body input; callers cannot select an
owner, storage key, path, version ID or version number. Authorization filters the
document query by authenticated internal userId, deletedAt=null and status!=DELETING
before any storage access. Archived owned documents remain downloadable.

There is no current-version pointer. The highest immutable versionNumber is current;
UUID descending is a deterministic secondary order. The existing document/version
unique constraint prevents two versions claiming the same number. The query also
detects duplicate highest numbers defensively. No version or ambiguity returns 409.
No fallback to an older version occurs when the selected object is unavailable.

Success is a streamed **binary HTTP 200**, without the JSON success envelope:

- Content-Type: trusted stored application/pdf, image/jpeg or image/png.
- Content-Length: positive stored byte size, checked against private object metadata;
  actual streamed bytes are checked for truncation or excess.
- Content-Disposition: attachment, sanitized ASCII filename fallback and RFC 5987
  UTF-8 filename*. Stored original filenames are display metadata only.
- X-Content-Type-Options: nosniff; Cache-Control: private, no-store.
- Accept-Ranges: none. Range headers are ignored; the complete original is returned.
- Existing correlation/request-ID headers remain present.

Invalid UUID/unsupported query/body input returns 400. Missing, foreign, soft-deleted
and DELETING documents return the same 404 envelope. No/ambiguous current version
returns 409. Missing keys/objects, invalid stored media/size, storage failure or
database unavailability return sanitized 503, not a document-not-found response.
The first storage read completes before committing binary headers, allowing early
read failures to return the standard JSON error envelope. Once binary headers are
sent, read/length failures terminate the connection; no JSON is appended. Client
disconnect destroys the source. Only fully streamed server responses log
download.completed; interruptions log safely with the existing correlation ID.
These logs do not prove the client durably saved the file.

No storage key, absolute path, provider metadata, owner ID or token appears in
headers/errors. Original file bytes are returned only after ownership verification.
Ownership/visibility is checked at request admission; a deletion or session revocation
after streaming starts does not retroactively revoke bytes already sent. No version
history, old-version download, preview, range implementation or new upload endpoint
is added. See [download verification](download-implementation.md).

### Streaming document creation

`POST /api/v1/documents` accepts **multipart only**, one `file`, a required `title`,
and optional `documentType`, `issuer`, `referenceNumber`, `documentDate`,
`expirationDate`, `categoryId`, `tagIds`. It requires the existing session cookie,
`X-CSRF-Protection: 1`, a trusted browser Origin and a UUID `Idempotency-Key`.
Query parameters, duplicate fields, unsupported fields and additional files are rejected.
`tagIds` is a JSON array of up to 100 owned UUIDs; duplicates are removed. It does
not create tags by name. Metadata uses the PATCH lengths/date rules below. Omitted
type becomes OTHER; omitted optional fields become null and tags become []. Text
"null" is not a null sentinel. Title cannot be omitted or derived implicitly.

PDF, JPEG (.jpg/.jpeg), and PNG require matching extension, declared MIME and magic
bytes. Display filenames are normalized basenames of at most 255 characters; they
never determine storage paths. Empty files are rejected. Defaults: 50 MiB/file,
500 PDF pages, 40 million image pixels, 120 seconds receive time, 15 seconds per
PDF inspection command, two concurrent uploads per process. `UPLOAD_*` settings
are validated at startup. Images undergo parser/header/dimension and final-marker
checks; these are not a complete pixel-stream integrity or malware scan. qpdf
strict structure checks reject damaged/recovered and encrypted PDFs (including
empty-password encryption), and enforce page count. No content extraction occurs.

HTTP 201 returns `{data,meta:{requestId}}`. Data contains id, title, documentType,
status=UPLOADED, issuer, referenceNumber, date-only documentDate/expirationDate,
createdAt, safe category, safe tags, and `version` containing id, versionNumber=1,
originalFilename, detected mimeType, fileSize (bytes), pageCount (null for images),
extractionStatus=PENDING and createdAt. No storage key, checksum, owner ID, file
bytes or processing/queued claim is returned. Existing metadata reads retain their
metadata-only shape; current-version download and version history are described above.

SHA-256 is calculated incrementally. A PostgreSQL `(user_id, checksum_sha256)`
unique constraint rejects identical content owned by the same user, even if the
document is archived/deleted; another user's identical content is allowed. This
policy prevents concurrent duplicate creation without exposing other owners.

Idempotency is scoped to owner and this operation. A short advisory-locked database
reservation rejects concurrent receiving requests with 409. Completed responses
are retained for 24 hours; replay resubmits the multipart body, validates it and
compares normalized metadata, display filename, MIME, size and checksum. A match
returns the original data and HTTP 201 (with a fresh request ID); mismatch is 409.
Completed replay is a creation receipt, not a fresh document detail view. Receiving
leases last receive timeout + three inspection timeouts + 120 seconds. Expired
keys can be replaced on reuse; checksum uniqueness still applies. No automatic
janitor runs yet; expired reservation rows may be removed by maintenance after
their expiry, and no file bytes are stored in these rows.

Failures use standard sanitized envelopes: 400 invalid/empty/multiple/malformed
or encrypted input and page/pixel limits; 401 unauthenticated; 403 CSRF/Origin;
404 unavailable category/tag; 408 receive timeout; 409 duplicate/in-progress/key
mismatch; 413 size limit; 415 media mismatch or non-multipart/compressed input;
429 local upload capacity; 503 storage/database/inspection unavailable.
See [upload implementation notes](upload-implementation.md) for compensation,
crash recovery, setup and verification. Processing remains unimplemented.

### Document metadata foundation contract

Metadata routes expose GET /documents, GET/PATCH/DELETE /documents/:documentId,
and POST /documents/:documentId/archive and /restore. Collection POST is the
streaming creation contract above. Metadata reads do not fabricate file/version,
preview or processing sections.

All routes use existing session authentication and owner predicates. Mutations require
X-CSRF-Protection: 1, the Origin allowlist, and no query fields. Detail accepts no
query/body fields. Lifecycle actions accept no body or {}. Missing/unowned/deleted
detail/update/archive targets return identical 404 responses; restore/delete can
address owned soft-deleted rows. Unsupported inputs return 400 and conflicts 409.

Lists exclude deleted rows and include archived rows unless archived=true/false is
supplied. Optional filters: q (literal case-insensitive title/issuer/reference substring,
1-200 characters), status (Appendix A strings), documentType (uppercase identifier,
1-50 characters), categoryId, tagId, archived, dateFrom/dateTo (document date), and
expirationFrom/expirationTo. Date ranges are inclusive YYYY-MM-DD bounds. Unknown
filters are rejected. Limit defaults to 25, maximum 100. Sort is -createdAt (default)
or createdAt with UUID as a same-direction tiebreaker. The opaque base64url cursor
contains a validated timestamp/UUID/order tuple and never determines ownership.
Keep filters/order fixed across pages; this is keyset pagination, not a snapshot.
Responses use data arrays and meta {requestId,nextCursor,hasMore}.

Safe metadata: id, title, documentType, status, issuer, referenceNumber, documentDate,
expirationDate, verifiedSummary, isArchived, createdAt, updatedAt, deletedAt, category
(safe category object or null), and tags (safe tag objects ordered by UUID). Date-only
fields use YYYY-MM-DD; timestamps use ISO UTC. Internal user IDs and join fields are
omitted. Relationships are fetched in bounded batches, never once per document.

PATCH accepts title (trimmed, 1-300 characters), documentType (uppercase identifier,
1-50), issuer (trimmed, 1-200), referenceNumber (trimmed, 1-200), documentDate,
expirationDate, categoryId, and tagIds (maximum 100 UUIDs; duplicates deduplicated).
Omission preserves existing values. Null clears issuer/reference/dates/category;
title/type/tagIds cannot be null, and [] clears tags. Empty updates are invalid.
Strings reject control characters. Dates must be real calendar dates in years
0001-9999 and expiration must not precede documentDate after merging the update.
Status, summary, ownership, archive/delete flags and infrastructure fields are not
client-writable. Category and tag availability is verified by owned queries; missing
or foreign associations return generic 404. Metadata and joins commit atomically.
Updates serialize on the owned document row; no ETag contract previously existed.

Archive sets status=ARCHIVED and isArchived=true, preserving metadata and joins.
Soft delete sets deletedAt and preserves status/archive/relationships. Repeated
archive/delete does not change timestamps. Restore clears deletedAt/isArchived and
sets UPLOADED for archived or deleted rows, never READY. Restore on an active row
is a no-op. PROCESSING and DELETING lifecycle changes conflict (409); no such work
is started here. Archive of deleted rows is unavailable (404). Actions return safe
document data in the standard envelope; no permanent purge is exposed.

Deleting a referenced category returns 409, including references from deleted rows.
Deleting a Tag cascades only its join records; Documents and other Tags remain.

### Tags (Phase 1)

Tags reuse Categories authentication, mutation security, pagination and name
normalization. All routes require the session cookie. Ownership comes only from
the authenticated internal user ID; body/query userId fields are rejected and
headers cannot select another user. Safe tag fields are id, name, createdAt and
updatedAt. No userId, credentials or database metadata is returned.

- GET /api/v1/tags accepts limit (default 25, maximum 100), an exclusive UUID cursor,
  sort=id (ascending UUID, the only supported order), and optional q. It returns
  HTTP 200 with data as an array and meta: {requestId, nextCursor, hasMore}.
  Final/empty pages have nextCursor=null and hasMore=false. q is normalized using
  the same NFKC/trim/collapsed-whitespace policy as names and must contain 1-100
  Unicode code points without controls. Omit q to list all owned tags; blank q is
  invalid. Search is a case-insensitive literal substring under PostgreSQL locale
  rules. Percent, underscore and backslash are literal characters, not SQL wildcard
  operators. Keep q/sort unchanged while following cursors. A cursor does not imply
  ownership or require that its row exists. GET accepts no body or {} only.
- POST /api/v1/tags accepts exactly {name} and returns HTTP 201 with the safe tag
  in data and meta.requestId. Names are NFKC-normalized, trimmed and whitespace-
  collapsed, then validated as 1-100 Unicode code points without controls. Display
  case is preserved. PostgreSQL lower(name) is unique per owner, exactly as for
  Categories. finance, Finance, padded finance and FINANCE conflict for the same
  user; different users can each use the name. Duplicates return generic 409 CONFLICT.
- PATCH /api/v1/tags/:tagId accepts exactly {name}; no other fields are mutable.
  Empty bodies, null names and unsupported properties return 400. Success is 200
  with the same safe tag shape. Duplicate renames return 409. Foreign/missing IDs
  both return generic 404 NOT_FOUND; the owner predicate is part of the write.
- DELETE /api/v1/tags/:tagId permanently deletes only the owned tag and returns
  HTTP 200 with data: {deleted:true} and meta.requestId. No soft deletion is used.
  Missing, foreign and already-deleted IDs all return 404; deletion retries have
  no further effect, and the name becomes reusable. No body or {} is accepted.

All mutations require X-CSRF-Protection: 1 and the established browser Origin
allowlist, and reject query fields. Invalid UUID/DTO input returns 400, missing or
invalid authentication 401, and CSRF/Origin failures 403. Failures use the existing
safe error envelope and all responses are no-store. Database errors are not exposed.

DocumentTag now uses owner-composite foreign keys with ON DELETE CASCADE for
join rows only. Deleting a tag preserves documents; PostgreSQL integration tests
verify cleanup and ownership isolation, including soft-deleted documents.

### Categories (Phase 1)

All routes require the existing session cookie and use the authenticated internal
owner ID. Supplied userId body/query fields are rejected; headers cannot override
ownership. Only id, name, nullable color/icon, createdAt and updatedAt are returned.
No role or frontend change is introduced.

- GET /api/v1/categories accepts limit (default 25, range 1-100), cursor (exclusive
  UUID bound) and sort=id (the only supported order, ascending UUID). It returns
  HTTP 200 with data as an array and meta containing requestId, nextCursor (UUID
  or null), and hasMore. Empty/final pages use null/false. A cursor never supplies
  ownership and need not identify an existing row. This follows the general list
  envelope in section 7.3; existing authentication response shapes are unchanged.
- POST /api/v1/categories accepts name and optional color/icon, returns HTTP 201
  with data containing the created category and meta.requestId. Name is normalized
  with Unicode NFKC, trimmed and whitespace-collapsed, then validated as 1-100
  Unicode code points without control characters. Display case is preserved.
  Per-user uniqueness uses PostgreSQL lower(name) after API normalization;
  database locale rules define case conversion, not accent-insensitive matching.
  Concurrent duplicates return generic 409 CONFLICT; another user may reuse the name.
- PATCH /api/v1/categories/:categoryId accepts a nonempty partial object with only
  name/color/icon. Name cannot be null. Omitted fields stay unchanged. Success is
  HTTP 200 with the updated safe category in the standard envelope. Duplicate names
  return 409. Missing and foreign IDs both return generic 404 NOT_FOUND.
- DELETE /api/v1/categories/:categoryId permanently deletes an owned unused category
  and returns HTTP 200 with data: {"deleted":true} and meta.requestId. Categories do
  not use soft deletion: the documented recoverable deletion applies to documents.
  Deleted rows disappear from lists; their names become reusable. Repeated deletion,
  missing IDs and foreign IDs all return the same 404. No body or {} is accepted.

Color is null or exactly #RRGGBB (six hex digits), stored lowercase. Icon is null
or a lowercase kebab-case slug (1-50 characters, first character a-z, remaining
segments alphanumeric), such as folder-open. It is a renderer-neutral identifier,
never a URL, path, SVG or HTML. A future UI must map supported slugs to components
and provide a fallback for unknown slugs, rather than execute stored markup.
Null clears optional styling. Empty strings and unsupported properties return 400.

Mutations require X-CSRF-Protection: 1 and the existing exact Origin allowlist;
cross-site requests without Origin are rejected. No query fields are accepted on
mutations. Missing authentication is 401, invalid UUID/DTO input is 400, and CSRF
failures are 403. Errors use the standard safe envelope, and responses are no-store.

Referenced categories now return 409 through a restrictive composite owner foreign
key, including references from soft-deleted documents. There is no automatic
reassignment. Update the owned documents' category metadata before deleting a used
category; soft-deleted documents must first be restored.

The Next.js frontend now consumes these authentication contracts. Its public
`NEXT_PUBLIC_API_BASE_URL` lives in `apps/web/.env.local`; the API still reads root
`.env`. Include the frontend's exact origin in `CORS_ORIGINS` and enable credentials
for cross-origin cookie requests. See `apps/web/README.md` for client refresh
serialization, browser requirements, tests and deployment limitations. No backend
contract or migration was changed for the frontend integration.

### Phase 1 authentication hardening

Registration, login and refresh have fixed-window request budgets before JSON
parsing, validation, database access or Argon2 work. Per socket peer and endpoint,
defaults are 10 registration, 30 login/password-change and 60 refresh requests per 60 seconds.
`AUTH_REGISTER_RATE_LIMIT`, `AUTH_LOGIN_RATE_LIMIT`, `AUTH_REFRESH_RATE_LIMIT`
allow 1-1000; `AUTH_RATE_WINDOW_SECONDS` allows 1-3600. All three also share a
process-wide budget (`AUTH_GLOBAL_RATE_LIMIT`, default 300, range 1-10000), bounding
both work admission and counter memory even with many distinct source addresses.
Every admitted attempt counts, including malformed and successful requests.
HTTP 429 returns the standard `TOO_MANY_REQUESTS` envelope and `Retry-After` seconds.
For allowed credentialed CORS origins, `Retry-After` is exposed so browser clients
can read the delay. Counters reset at the window boundary and process restart. This is a single-process
Phase 1 safeguard, not distributed throttling. Forwarded/X-Forwarded-For headers
cannot choose the key; a reverse proxy's callers share its peer budget. Deploy an
additional edge limiter before multiple API replicas, and tune budgets for capacity.
IPv6 address rotation is still bounded by the shared budget. Logout and health
remain accessible when the authentication budget is exhausted.

Except the streaming collection upload above, request bodies must be JSON and fit `HTTP_BODY_LIMIT_BYTES` (default
16384, range 1-1048576), including chunked bodies. Oversized bodies return the
standard 413 `PAYLOAD_TOO_LARGE` envelope; malformed JSON returns 400 and non-JSON
or compressed bodies return 415. Uploads use their separate bounded streaming policy.
Helmet supplies CSP, anti-framing, MIME-sniffing, referrer and other HTTP protections.
All responses, including authentication failures and rate limits, use `no-store`.
Parser errors never expose the original body. Structured logs redact credential
keys, cookies, bearer/basic credentials, labeled token/hash strings and Argon2 PHC
strings. Application code must never submit DTOs or unlabelled secrets to logging.

Development/test allow HTTP with Secure cookies off by default; HSTS and CSP HTTPS
upgrading are disabled there. Production requires Secure cookies and HTTPS CORS
origins and enables one-year HSTS and CSP HTTPS upgrading. TLS terminates at the
deployment proxy. CORS allows only explicit origins; credentialed browser clients
must enable `CORS_CREDENTIALS` and send `credentials: include`. Prefer host-only
cookies (omit Domain), Lax/Strict SameSite, and the narrow configured paths.
SameSite=None requires Secure even locally. Existing Origin/custom-header CSRF
checks remain required independently of CORS and SameSite.

Argon2id's 64 MiB, three iterations, one lane and 32-byte hash remain the shared
registration/dummy-verification policy. Benchmark deployment capacity when tuning
request budgets; lowering hash strength is not a throttling substitute. Login
continues dummy verification and generic 401 responses across account states.
Registration retains its public 201/409 contract: conflict still reveals that an
address is unavailable, but no profile/account-state details. Throttling reduces
automated probing; it does not make that contract enumeration-proof.
Session activity updates recheck the presented hash to reject tokens rotated
between lookup and update. Revoked/expired/deleted-user sessions fail closed;
row-locked refresh rotation and retained consumed hashes reject replay across API
processes, revoking the session on reuse. Clients must serialize refresh requests.

Historical authentication-hardening dependency review: `npm audit --omit=dev` reported 11 production-tree
findings (4 high, 6 moderate, 1 low), including existing NestJS core/platform,
Multer, YAML, lodash, file-type, qs and body-parser dependencies. This task does
not upgrade the NestJS major version. Upload now uses Busboy directly rather than
Multer. Body limits are validated and errors sanitized, but these controls do not
constitute a clean dependency audit. Review and test framework/transitive upgrades
before public production deployment; rerun the audit because advisory data changes.

### Session management

All session-management routes require the configured session cookie. No role or
admin functionality is involved. Ownership comes only from authenticated context.

- `GET /api/v1/me/sessions?limit=50&cursor=<uuid>` returns HTTP 200 with
  `data: { sessions: [...], nextCursor: <uuid-or-null> }` and standard `meta.requestId`.
  Limit is 1–100 (default 50). Results are ordered by UUID ascending; cursor is an
  exclusive UUID bound and never changes the owner filter. Each item contains only
  `id`, `createdAt`, nullable `lastSeenAt`, `expiresAt`, nullable `refreshExpiresAt`,
  and `isCurrent`. Active means unrevoked with either unexpired access or unexpired
  refresh eligibility. Fully expired/revoked sessions are excluded. Device descriptions
  are omitted because device/user-agent data is not collected. No token, hash,
  credential or ownership identifier is returned alongside the safe session metadata.
- `DELETE /api/v1/me/sessions/:sessionId` revokes one owned session and returns
  HTTP 200 with `data: { revoked: true }`. Already revoked owned rows return the
  same success without changing their revocation timestamp. Missing and foreign
  UUIDs both return the standard 404 `NOT_FOUND` envelope. Malformed UUIDs return 400. Revoking the current session clears both authentication cookies; subsequent
  requests with that session return 401, including a repeated self-revocation.
- `DELETE /api/v1/me/sessions/others` revokes all unrevoked owned sessions except
  the authenticated session, including expired rows, and returns HTTP 200 with
  `data: { revokedCount: <number> }`. Repeating it returns zero if no new sessions
  were created. Foreign sessions and the current session remain untouched. The
  separate `/auth/logout-all` route also includes the current session.

All responses use standard envelopes and `Cache-Control: no-store` on success.
DELETE requests require `X-CSRF-Protection: 1` and the same browser Origin checks
as logout. They accept no body/query fields. Unknown list query fields, including
`userId`, are rejected. Supplied user/session IDs in headers never override trusted
context. Revocation invalidates both access and refresh for that session. Concurrent
sessions created after a bulk revocation statement require a subsequent revocation.
No new schema or migration is needed. Other modules can use typed `@CurrentSession()`
to read the authenticated session ID; it is kept separate from public profile data.

### Refresh and logout

`POST /api/v1/auth/refresh` consumes only `COOKIE_REFRESH_NAME`. It validates the
SHA-256 token hash, session revocation, user deletion and refresh expiration, then
atomically archives the consumed hash and rotates both the session and refresh
tokens. It returns HTTP 200 with `{"data":{"expiresAt":"ISO-8601 UTC"},"meta":{"requestId":"uuid"}}`
and sets both HttpOnly cookies using the same validated attributes as login.
The previous access token immediately stops authenticating new requests.

Access expiration can be renewed while the refresh token remains valid. The refresh
deadline is absolute from login and is never extended; renewed access expiration
is the earlier of `now + AUTH_SESSION_TTL_SECONDS` and that deadline. Missing,
malformed, unknown, expired, revoked, deleted-user or reused refresh credentials
return the standard HTTP 401 `UNAUTHORIZED` envelope and clear both cookies.
Consumed hashes remain associated with their session so reuse of any generation
revokes the current session, including its newest tokens. There is no replay grace
period: clients must serialize refresh calls; concurrent use of the same token
allows one rotation, then revokes the session when the losing request detects reuse.
A lost successful response followed by a retry therefore requires login again.

`POST /api/v1/auth/logout` revokes only the session identified by the current
session cookie, with fallback to the current or consumed refresh cookie if the
session cookie cannot identify a row (including when the browser has removed an
expired access cookie). If two cookies identify different sessions, the session
cookie takes precedence. Missing, malformed, unknown, expired or already revoked
credentials still return HTTP 200 with `{"data":{"loggedOut":true},"meta":{"requestId":"uuid"}}`.
Repeating logout does not change an existing revocation timestamp. Both cookies
are cleared with their configured names, Domain, Path, SameSite, Secure and HttpOnly
attributes, without reusing the original Max-Age/Expires. Database failures return
a generic 500 and do not report successful logout.

Both endpoints set `Cache-Control: no-store`, accept no query/body fields (no body
or `{}` is accepted), and require `X-CSRF-Protection: 1`. This non-simple custom
header forces browser preflight; supplied Origin must exactly match `CORS_ORIGINS`.
Missing Origin is allowed for non-browser callers except when `Sec-Fetch-Site` is
`cross-site`. Missing/incorrect headers or untrusted origins return 403 before
database work or cookie changes. This is an Origin/custom-header CSRF defense,
not a synchronizer-token scheme; only trusted browser origins belong in the allowlist.
Cross-origin callers must use `credentials: include`. No raw token or hash is logged
or returned in JSON/Swagger examples. Authenticated logout-all is described below.

### Profile updates, password changes and logout-all

All four routes require the configured authentication cookie and derive ownership
only from the trusted internal user ID. Missing, invalid, expired, revoked and
deleted-user sessions return the generic 401 envelope. All successes return HTTP
200 with the standard data/meta envelope; no credentials or security metadata are
returned. Existing GET /auth/me remains available alongside GET /me.

- PATCH /api/v1/me accepts a nonempty JSON object containing only displayName,
  timezone and/or locale. Omitted fields are preserved. displayName is trimmed and
  must contain 1-100 characters, without control characters. timezone must be UTC
  or an IANA region/name supported by the Node runtime (including valid aliases),
  at most 100 characters; numeric offsets are rejected. locale must be a canonical
  BCP 47 tag supported by the runtime, at most 35 characters (for example en-US).
  Nulls, empty updates, userId, email, and all unsupported properties return 400.
  The response data contains only id, email, displayName, timezone and locale.
- PATCH /api/v1/me/password accepts exactly currentPassword and newPassword.
  Both are preserved verbatim. A local identity and credential are required;
  an incorrect current password or non-local account returns generic 401.
  The shared configurable registration password policy applies to newPassword;
  policy/DTO failures return 400. Argon2id verification and hashing precede a
  short transaction that locks and rechecks account, credential and session state,
  updates passwordChangedAt, resets failed-login state, and revokes all other
  unrevoked owned sessions, including expired rows. The current session stays
  active; other users are unaffected. Success data is {"passwordChanged":true}.
  No password-version column exists; locked hash comparison rejects concurrent
  stale-password writes and logins. A failed revocation rolls back the password.
  This endpoint shares AUTH_LOGIN_RATE_LIMIT with login and consumes the global
  authentication budget; 429 includes Retry-After. Neither password/DTO is logged.
- POST /api/v1/auth/logout-all revokes all unrevoked owned sessions, including
  the current one, and clears both cookies with matching configured attributes.
  Success data is {"loggedOut":true}. Revocation is idempotent: already revoked
  rows retain their timestamps. A retry using the now-revoked or missing session
  returns 401 with no further changes. Concurrent already-authenticated requests
  may both succeed. A new login after the transaction creates a new valid session.

All three mutations require X-CSRF-Protection: 1 and the existing browser Origin
checks. Query parameters are rejected. Logout-all accepts no body or an empty
object. Browser clients must send credentials: include. CSRF/origin failures are
403; persistence failures are sanitized 500 errors, never successful acknowledgements.
No migration or new environment variable is required for these endpoints.

### Authenticated current user

`GET /api/v1/auth/me` resolves only the configured `COOKIE_NAME` session cookie.
`GET /api/v1/me` is also available with the same safe response; `/auth/me` remains compatible.
Success returns HTTP 200 with `data` containing only `id`, `email`, `displayName`
(nullable), `locale`, and `timezone`, plus standard `meta.requestId`.
The endpoint sets `Cache-Control: no-store`. No credentials, session identifiers,
token hashes, failure counters or security metadata are returned.

Missing, malformed, ambiguous duplicate, unknown, expired or revoked session cookies
return the same standard HTTP 401 `UNAUTHORIZED` envelope. Sessions owned by a
soft-deleted user are also rejected. Only canonical 32-byte base64url session tokens
are accepted; the token is SHA-256 hashed before database lookup. Refresh cookies,
refresh tokens, Authorization headers and request-provided user IDs cannot authenticate
a request. Extra body/query/header user IDs are ignored and never select a profile.

Every request checks current database validity; there is no authentication cache.
`auth_sessions.last_seen_at` is updated on first use and at most once per 60 seconds,
using a conditional update safe across concurrent API processes. Activity does not
extend expiration. A database failure fails closed with the standard generic 500.

Other modules can import `AuthModule`, apply `@UseGuards(SessionAuthGuard)`, and use
`@CurrentUser()` with `Readonly<AuthenticatedUser>` from the auth module's public
`index.ts`. The context is request-local, frozen, and stored under a symbol unrelated
to incoming HTTP fields. Swagger describes the configured cookie name as the `session`
security scheme; authenticate through login to set its HttpOnly cookie. No role or
permission system is implemented. State-changing protected endpoints must additionally
implement the project's CSRF and ownership rules when introduced.

### Local login

`POST /api/v1/auth/login` accepts JSON with exactly `email` and `password`.
Email uses registration normalization/validation. The existing password is preserved
exactly and verified with Argon2id; new registration strength rules do not invalidate
existing passwords. Login accepts 1–2048 Unicode code points as a resource bound.

HTTP 200 returns `{"data":{"user":{"id":"uuid","email":"normalized@example.invalid"},"expiresAt":"ISO-8601 UTC"},"meta":{"requestId":"uuid"}}`.
Two separate HttpOnly cookies carry independently generated 32-byte random session
and refresh tokens. Only SHA-256 hashes are stored in PostgreSQL. Tokens never appear
in response JSON, Swagger examples or application logs. Responses use `Cache-Control: no-store`.
Malformed input returns the standard HTTP 400 envelope. Unknown, external-only,
soft-deleted and locked accounts and incorrect passwords all return HTTP 401 with
`UNAUTHORIZED`, `Unauthorized`, empty details and the request's `traceId`; no cookies
are issued. Unknown/deleted accounts perform dummy Argon2id verification.

Failures are serialized per user in PostgreSQL and committed even though login
returns 401. `AUTH_LOGIN_MAX_ATTEMPTS` defaults to 5. The counter resets after
`AUTH_LOGIN_WINDOW_SECONDS` (default 900) without a failed attempt, or after an
expired lockout. Reaching the threshold locks the account for
`AUTH_LOGIN_LOCKOUT_SECONDS` (default 900, range 1–86400). Attempts during a lockout
neither extend it nor increment the counter. Success clears failure state, creates
the session and updates `users.last_login_at` in one transaction. Password changes
or deletion between verification and persistence prevent session creation.

`AUTH_SESSION_TTL_SECONDS` defaults to 604800; `AUTH_REFRESH_TTL_SECONDS` defaults
to 2592000 (range 1–7776000, at least the session lifetime). Cookie Max-Age and
Expires use the persisted expiration times. `COOKIE_NAME` and `COOKIE_REFRESH_NAME`
must differ. Session path defaults to `/`; refresh path defaults to `/api/v1/auth`.
Validated `COOKIE_PATH` allows `/`, `/api`, `/api/v1`; `COOKIE_REFRESH_PATH` also
allows `/api/v1/auth`. Omit `COOKIE_DOMAIN` for host-only scope; an explicit lowercase
DNS domain must belong to the deployment and grants access to its subdomains.
Never use a public suffix. `__Host-` names require host-only scope and path `/`.
Secure defaults to true in production and cannot be disabled there; development
and test default to false for local HTTP. SameSite defaults to Lax; None requires
Secure. Production must serve HTTPS. See `.env.example` for validated settings.

To prevent browser login CSRF, login requires JSON and any supplied Origin must
exactly match `CORS_ORIGINS` (include the UI origin even when served on the API origin).
Missing Origin is allowed for non-browser clients, except requests marked
`Sec-Fetch-Site: cross-site`. Untrusted origins return the standard HTTP 403 envelope;
non-JSON requests are rejected with 400 or 415 depending on DTO parsing.
Cross-origin browser clients need `CORS_CREDENTIALS=true` and `credentials: include`.
Edge/distributed throttling and CSRF protection for future business mutations
remain separate work; process-local request budgets supplement account lockout.

### Local registration

`POST /api/v1/auth/register` accepts JSON with exactly `email` and `password`.
Email is trimmed and lowercased before validation/persistence. Valid addresses
must fit 320 characters; internationalized local parts are not currently accepted.
Passwords are preserved exactly, including spaces and Unicode; whitespace-only
passwords are rejected. `AUTH_PASSWORD_MIN_LENGTH` defaults to 15 (allowed 15–128),
and `AUTH_PASSWORD_MAX_LENGTH` defaults to 128 (allowed 64–1024, at least the minimum).
Lengths count Unicode code points. There are no mandatory character-class rules.
These settings are validated at startup. This length policy does not implement a
compromised-password blocklist. Registration request throttling is described above.

Success is HTTP 201 with `{"data":{"id":"uuid","email":"normalized@example.invalid"},"meta":{"requestId":"uuid"}}`.
Only the public ID and email are returned. Responses set `Cache-Control: no-store`.
Malformed input, unknown properties and password-policy failures return HTTP 400
with the standard `BAD_REQUEST` envelope. Duplicate normalized email, including
soft-deleted accounts, returns HTTP 409 with `CONFLICT`, message `Conflict`, empty
details and the correlation ID as `traceId`. This status distinguishes a conflict
from creation but discloses no profile, provider, credential or deletion details.
Unknown failures use the existing generic HTTP 500 envelope.

Argon2id uses a fresh random salt, 64 MiB memory, three iterations, one lane and
a 32-byte hash. Hashing occurs before a short PostgreSQL transaction creates the
user, LOCAL identity (`issuer=local`, `subject=users.id`) and local credentials.
Database uniqueness handles concurrent duplicates. No request DTO, password or hash
is logged. Registration creates no session and sets no cookie; use login separately.

### Health probes

`GET /api/v1/health/live` returns HTTP 200 when the application process can
respond: `{"data":{"status":"ok"},"meta":{"requestId":"uuid"}}`.

`GET /api/v1/health/ready` returns HTTP 200 after application bootstrap:
`{"data":{"status":"ready"},"meta":{"requestId":"uuid"}}`.
Before initialization or during graceful shutdown it returns HTTP 503:
`{"error":{"code":"SERVICE_UNAVAILABLE","message":"Service Unavailable","details":{},"traceId":"uuid"}}`.

Both probes set `Cache-Control: no-store` and the standard correlation headers.
They contain no secrets, connection addresses, or detailed diagnostics. A process
that cannot serve HTTP cannot return a liveness response; the probe caller must
set a short HTTP timeout (for example, one second).

Readiness checks PostgreSQL using `SELECT 1` on the API's shared Prisma client.
Connection acquisition and query execution each default to 500 ms, configurable
up to 1000 ms each. Database failures return the same safe HTTP 503 envelope;
successful responses do not reveal connection details. Liveness performs no
dependency I/O. No deferred infrastructure is checked.

Swagger UI is available at `/api/v1/docs/`, with OpenAPI JSON at
`/api/v1/docs-json`. It documents application information, all implemented authentication/session routes and these two probes, including envelopes
and readiness 503. Probes are intended for internal deployment monitoring; no
authentication or network restriction is implemented yet.

`GET /api/v1` is public and returns application information:

```json
{
  "data": { "name": "Brainless API", "apiVersion": "v1" },
  "meta": { "requestId": "uuid" }
}
```

Every request receives a validated or generated correlation UUID in both
`X-Correlation-Id` and the compatible `X-Request-Id` response header. Incoming
`X-Correlation-Id` takes precedence over `X-Request-Id`; the first valid value is
used. Values must be a single canonical UUID (versions 1–8, RFC variant); absent,
invalid, duplicated/comma-separated, and nil IDs are replaced with a generated
UUID when neither header is valid. IDs are untrusted tracing metadata, never
authentication or ownership evidence. Both response headers are exposed through
CORS for allowed origins. Success `meta.requestId` uses this same UUID.

Errors use the documented
error envelope, with generic HTTP status messages and the same ID as `traceId`.
The unprefixed `/` route is not served. This information endpoint is not a
dependency readiness check.

Centralized exception mapping preserves recognized HTTP error statuses (400–599)
and maps unknown exceptions or invalid statuses to 500. Codes are uppercase
status names such as `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, and
`INTERNAL_SERVER_ERROR`. Error `details` is currently empty; arbitrary exception
messages, response objects, stack traces, and infrastructure details are never
returned. Malformed JSON and DTO validation errors use HTTP 400.

DTO validation transforms requests into DTO instances, whitelists decorated
properties, and rejects unexpected properties with HTTP 400. Property conversion
must be explicit (for example, `@Type(() => Number)`); implicit conversion is off.
Invalid values and unknown properties are not echoed in error responses.

CORS uses the validated `CORS_ORIGINS` exact-origin allowlist and
`CORS_CREDENTIALS` boolean. Missing or blank origins disable cross-origin browser
access. An unlisted origin receives no `Access-Control-Allow-Origin`; CORS is a
browser policy, not authentication or server-side authorization.

The endpoint catalog below remains the target specification; only application
information, local registration/login/refresh/logout, authenticated current-user
retrieval, owned-session listing/revocation and the two health probes are currently
implemented. See [the Phase 1 review](phase-1-review.md) for outstanding acceptance work.

# 7. API standards

| **Concern**    | **Standard**                                                                 |
| -------------- | ---------------------------------------------------------------------------- |
| Base path      | /api/v1                                                                      |
| Format         | JSON; multipart/form-data only for uploads                                   |
| Authentication | HttpOnly session cookie now; OIDC bearer validation later                    |
| CSRF           | Required for cookie-authenticated state-changing requests                    |
| Dates          | ISO 8601 UTC timestamps; date-only fields use YYYY-MM-DD                     |
| IDs            | UUID strings                                                                 |
| Pagination     | Cursor preferred; offset allowed for small admin tables                      |
| Idempotency    | Idempotency-Key for upload, retry, reminder creation, and permanent deletion |
| Concurrency    | ETag/If-Match or version number for mutable document metadata                |
| Errors         | Stable code, message, details, traceId                                       |

## 7.1 Success envelope

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"data": { ... },<br />
"meta": { "requestId": "uuid" }<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 7.2 Error envelope

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"error": {<br />
"code": "DOCUMENT_NOT_FOUND",<br />
"message": "Document was not found.",<br />
"details": {},<br />
"traceId": "uuid"<br />
}<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 7.3 List contract

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>GET /api/v1/documents?limit=25&amp;cursor=...&amp;status=READY&amp;categoryId=...&amp;sort=-createdAt<br />
<br />
{<br />
"data": [...],<br />
"meta": { "nextCursor": "...", "hasMore": true }<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 7.4 HTTP status guidance

| **Status** | **Use**                                                           |
| ---------- | ----------------------------------------------------------------- |
| 200        | Successful read/update/action with immediate result               |
| 201        | Resource created                                                  |
| 202        | Accepted asynchronous operation                                   |
| 204        | Successful deletion or action without body                        |
| 400        | Malformed request                                                 |
| 401/403    | Unauthenticated / authenticated but forbidden                     |
| 404        | Missing or inaccessible resource                                  |
| 409        | Duplicate, invalid transition, or optimistic concurrency conflict |
| 413/415    | Too large / unsupported media type                                |
| 422        | Valid JSON but failed business validation                         |
| 429        | Rate limited                                                      |

# 8. API endpoint catalog

All paths below are relative to /api/v1. USER endpoints are ownership-scoped. ADMIN endpoints require an operational administrator role. Internal worker commands should not be exposed publicly.

## 8.1 Authentication and profile

| **Method** | **Path**                 | **Access** | **Purpose**                                                   | **Phase** |
| ---------- | ------------------------ | ---------- | ------------------------------------------------------------- | --------- |
| POST       | /auth/register           | Public     | Create user, LOCAL identity and credentials; login separately | MVP       |
| POST       | /auth/login              | Public     | Authenticate local credentials and create session             | MVP       |
| POST       | /auth/refresh            | Session    | Rotate/extend session according to policy                     | MVP       |
| POST       | /auth/logout             | USER       | Revoke current session                                        | MVP       |
| POST       | /auth/logout-all         | USER       | Revoke all sessions                                           | MVP       |
| GET        | /auth/keycloak/start     | Public     | Begin OIDC authorization-code flow                            | Later     |
| GET        | /auth/keycloak/callback  | Public     | Validate callback and map issuer + subject                    | Later     |
| GET        | /auth/me                 | USER       | Return the authenticated public profile                       | MVP       |
| GET        | /me                      | USER       | Return the authenticated public profile (alias)               | MVP       |
| PATCH      | /me                      | USER       | Update display name, timezone and locale                      | MVP       |
| PATCH      | /me/password             | USER       | Change local password and revoke other sessions               | MVP       |
| GET        | /me/sessions             | USER       | List active application sessions                              | MVP+      |
| DELETE     | /me/sessions/others      | USER       | Revoke all owned sessions except the current session          | MVP+      |
| DELETE     | /me/sessions/{sessionId} | USER       | Revoke selected session                                       | MVP+      |

## 8.2 Categories and tags

| **Method** | **Path**                 | **Access** | **Purpose**                            | **Phase** |
| ---------- | ------------------------ | ---------- | -------------------------------------- | --------- |
| GET        | /categories              | USER       | List categories                        | MVP       |
| POST       | /categories              | USER       | Create category                        | MVP       |
| PATCH      | /categories/{categoryId} | USER       | Rename/re-style category               | MVP       |
| DELETE     | /categories/{categoryId} | USER       | Delete if unused or reassign documents | MVP       |
| GET        | /tags                    | USER       | List/search tags                       | MVP       |
| POST       | /tags                    | USER       | Create tag                             | MVP       |
| PATCH      | /tags/{tagId}            | USER       | Rename tag                             | MVP       |
| DELETE     | /tags/{tagId}            | USER       | Remove tag and joins                   | MVP       |

## 8.3 Documents

| **Method** | **Path**                         | **Access** | **Purpose**                                          | **Phase** |
| ---------- | -------------------------------- | ---------- | ---------------------------------------------------- | --------- |
| GET        | /documents                       | USER       | List/filter/sort owned documents                     | MVP       |
| POST       | /documents                       | USER       | Upload and create document/version                   | MVP       |
| GET        | /documents/{documentId}          | USER       | Get detail, verified metadata and processing summary | MVP       |
| PATCH      | /documents/{documentId}          | USER       | Update title/category/dates/reference/tags           | MVP       |
| POST       | /documents/{documentId}/archive  | USER       | Archive document                                     | MVP       |
| POST       | /documents/{documentId}/restore  | USER       | Restore archived/soft-deleted document               | MVP+      |
| DELETE     | /documents/{documentId}          | USER       | Soft delete document                                 | MVP       |
| POST       | /documents/{documentId}/purge    | USER       | Queue permanent deletion                             | Phase 2   |
| GET        | /documents/{documentId}/download | USER       | Authorized original-file download                    | MVP       |
| GET        | /documents/{documentId}/preview  | USER       | Return preview manifest or signed links              | MVP+      |
| GET        | /documents/{documentId}/activity | USER       | Audit processing and user changes                    | Phase 2   |

## 8.4 Versions, processing and extracted fields

| **Method** | **Path**                                          | **Access** | **Purpose**                     | **Phase** |
| ---------- | ------------------------------------------------- | ---------- | ------------------------------- | --------- |
| GET        | /documents/{id}/versions                          | USER       | List versions                   | MVP+      |
| POST       | /documents/{id}/versions                          | USER       | Upload new immutable version    | MVP+      |
| GET        | /documents/{id}/versions/{versionId}              | USER       | Version detail                  | MVP+      |
| GET        | /documents/{id}/versions/{versionId}/chunks       | USER       | Paged extracted chunks          | Phase 2   |
| GET        | /documents/{id}/processing                        | USER       | Current job states and progress | Phase 2   |
| POST       | /documents/{id}/reprocess                         | USER       | Queue selected processing steps | Phase 2   |
| POST       | /documents/{id}/processing/cancel                 | USER       | Request cancellation            | Phase 2   |
| GET        | /documents/{id}/extracted-fields                  | USER       | List AI/OCR suggestions         | Phase 3   |
| POST       | /documents/{id}/extracted-fields/{fieldId}/verify | USER       | Accept and promote field        | Phase 3   |
| POST       | /documents/{id}/extracted-fields/{fieldId}/reject | USER       | Reject candidate                | Phase 3   |
| POST       | /documents/{id}/summary/regenerate                | USER       | Queue summary regeneration      | Phase 3   |

## 8.5 Search

| **Method** | **Path**            | **Access** | **Purpose**                             | **Phase** |
| ---------- | ------------------- | ---------- | --------------------------------------- | --------- |
| GET        | /search/documents   | USER       | Unified keyword/semantic/hybrid search  | Phase 3/4 |
| POST       | /search/semantic    | USER       | Semantic search with structured filters | Phase 3   |
| POST       | /search/hybrid      | USER       | Hybrid retrieval and rank fusion        | Phase 4   |
| GET        | /search/suggestions | USER       | Autocomplete issuers, tags and titles   | Phase 4   |

## 8.6 RAG chat

| **Method** | **Path**                             | **Access** | **Purpose**                           | **Phase** |
| ---------- | ------------------------------------ | ---------- | ------------------------------------- | --------- |
| GET        | /chat-sessions                       | USER       | List chat sessions                    | Phase 3   |
| POST       | /chat-sessions                       | USER       | Create scoped chat                    | Phase 3   |
| GET        | /chat-sessions/{sessionId}           | USER       | Get session and messages              | Phase 3   |
| PATCH      | /chat-sessions/{sessionId}           | USER       | Rename/change allowed scope           | Phase 3   |
| DELETE     | /chat-sessions/{sessionId}           | USER       | Soft delete chat                      | Phase 3   |
| POST       | /chat-sessions/{sessionId}/messages  | USER       | Ask question and return/stream answer | Phase 3   |
| GET        | /chat-messages/{messageId}/citations | USER       | Resolve cited chunks/pages            | Phase 3   |
| POST       | /chat-messages/{messageId}/feedback  | USER       | Store helpful/not-helpful feedback    | Later     |

## 8.7 Reminders

| **Method** | **Path**                        | **Access** | **Purpose**                | **Phase** |
| ---------- | ------------------------------- | ---------- | -------------------------- | --------- |
| GET        | /reminders                      | USER       | List upcoming/history      | Phase 2   |
| POST       | /reminders                      | USER       | Create reminder            | Phase 2   |
| GET        | /reminders/{reminderId}         | USER       | Reminder detail            | Phase 2   |
| PATCH      | /reminders/{reminderId}         | USER       | Reschedule/update reminder | Phase 2   |
| POST       | /reminders/{reminderId}/dismiss | USER       | Dismiss reminder           | Phase 2   |
| POST       | /reminders/{reminderId}/snooze  | USER       | Create next delivery time  | Later     |
| DELETE     | /reminders/{reminderId}         | USER       | Cancel reminder            | Phase 2   |

## 8.8 Operations and configuration

| **Method** | **Path**                       | **Access** | **Purpose**                           | **Phase** |
| ---------- | ------------------------------ | ---------- | ------------------------------------- | --------- |
| GET        | /health/live                   | Internal   | Process liveness                      | MVP       |
| GET        | /health/ready                  | Internal   | Required dependency readiness         | MVP       |
| GET        | /admin/jobs                    | ADMIN      | Filter job and attempt history        | Phase 2   |
| POST       | /admin/jobs/{jobId}/retry      | ADMIN      | Retry eligible failed job             | Phase 2   |
| POST       | /admin/search/reindex          | ADMIN      | Queue Elasticsearch rebuild           | Phase 4   |
| POST       | /admin/vectors/reindex         | ADMIN      | Queue embedding profile rebuild       | Phase 3   |
| GET        | /admin/ai-profiles             | ADMIN      | List provider-neutral profiles        | Phase 3   |
| POST       | /admin/ai-profiles             | ADMIN      | Create profile without secret         | Phase 3   |
| PATCH      | /admin/ai-profiles/{profileId} | ADMIN      | Activate/update safe profile settings | Phase 3   |
| GET        | /admin/usage/ai                | ADMIN      | Usage, latency and estimated cost     | Phase 3   |

## 8.9 Important endpoint behavior

- POST /documents returns 201 after durable file and database creation, even though processing continues asynchronously.

- Reprocessing accepts explicit steps such as TEXT_EXTRACTION, AI_METADATA, EMBEDDINGS, and SEARCH_INDEX.

- Search results return document IDs plus page/chunk references; authorization is checked again when opening a result.

- Chat scope is immutable once messages exist unless the product explicitly warns that context is changing.

- Permanent deletion returns 202 and remains visible as DELETING until every derived store is cleaned.

# Appendix B. Example contracts

## B.1 Create document

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>POST /api/v1/documents<br />
Content-Type: multipart/form-data<br />
Idempotency-Key: uuid<br />
<br />
file: &lt;binary&gt;<br />
title: Laptop Warranty<br />
categoryId: uuid<br />
tagIds: ["owned-tag-uuid"]<br />
documentDate: 2026-08-10</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"data": {<br />
"id": "document-uuid",<br />
"status": "UPLOADED",<br />
"version": { "id": "version-uuid", "versionNumber": 1, "extractionStatus": "PENDING" }<br />
},<br />
"meta": { "requestId": "request-uuid" }<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## B.2 Reprocess document

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"steps": ["AI_METADATA", "EMBEDDINGS", "SEARCH_INDEX"],<br />
"aiProfileCode": "ollama-qwen-generation-v1",<br />
"embeddingProfileCode": "ollama-qwen-embedding-v1"<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## B.3 Semantic search

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"query": "documents related to laptop repair",<br />
"embeddingProfileCode": "ollama-qwen-embedding-v1",<br />
"filters": {<br />
"documentTypes": ["WARRANTY", "RECEIPT"],<br />
"dateFrom": "2025-01-01"<br />
},<br />
"limit": 20<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## B.4 Ask a document

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"content": "When does the warranty expire?",<br />
"generationProfileCode": "ollama-qwen-generation-v1",<br />
"embeddingProfileCode": "ollama-qwen-embedding-v1"<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"data": {<br />
"messageId": "uuid",<br />
"answer": "The warranty expires on 10 August 2028.",<br />
"citations": [<br />
{<br />
"documentId": "uuid",<br />
"chunkId": "uuid",<br />
"pageFrom": 2,<br />
"pageTo": 2<br />
}<br />
]<br />
}<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>
