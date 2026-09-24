# API conventions and OpenAPI

[Documentation index](README.md) | [Feature workflows](README.md#features)

## Generated endpoint reference

Swagger is configured in [configure-swagger.ts](../apps/api/src/configure-swagger.ts)
from the implemented controllers and DTO decorators. Treat its generated OpenAPI as
the source of truth for endpoint-level documentation, rather than a parallel Markdown
catalog of current and future routes.

| Deployment    | Swagger UI                               | OpenAPI JSON                                   |
| ------------- | ---------------------------------------- | ---------------------------------------------- |
| Local Compose | [UI](http://localhost:8080/api/v1/docs/) | [JSON](http://localhost:8080/api/v1/docs-json) |
| Host defaults | [UI](http://localhost:3001/api/v1/docs/) | [JSON](http://localhost:3001/api/v1/docs-json) |

Both are available when the API runs. The global HTTP prefix is `/api/v1`; OpenAPI's
info version is `1`, distinct from product release v1.0.0. No standalone schema-export
or client-generation npm script exists. Future tooling can consume the running JSON
endpoint; do not claim it is already checked into the repository.

## Authentication and authorization

Register first, then log in to obtain opaque HttpOnly session/refresh cookies.
Send credentials with browser requests; do not copy token values into Swagger examples.
Cookie-authenticated mutations require `X-CSRF-Protection: 1`. Browser Origin, when
present, must exactly match `CORS_ORIGINS`, including same-origin login/mutations.
An absent Origin with `Sec-Fetch-Site: cross-site` is rejected. Non-browser clients
without Origin are permitted by that check but still need authentication and the
mutation header. This is a custom-header/Origin policy, not a CSRF token endpoint.

Cross-origin clients also require `CORS_CREDENTIALS=true`; CORS does not replace
ownership or override browser cookie restrictions. Every business query/mutation
uses trusted internal user context. Missing and foreign document/category/tag/version
IDs use indistinguishable errors. Refresh rotates both cookies and detects replay;
serialize it. See [authentication](features/authentication.md) for the flow and limitations.

## Responses, errors and validation

JSON successes use `{data, meta: {requestId}}`. Catalog/history lists use an array in `data` with
`meta: {requestId, nextCursor, hasMore}`. Final pages have a null cursor and false
hasMore. Session management instead returns `{sessions, nextCursor}` inside `data`;
consult OpenAPI for its shape. Binary download is the intentional success-envelope exception.

Errors use:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Bad Request",
    "details": {},
    "traceId": "<request UUID>"
  }
}
```

Messages/codes derive from HTTP status; validation errors do not expose field details,
SQL messages, paths or stack traces. Correlation is returned in `X-Correlation-Id`,
`X-Request-Id` and the envelope. Allowed CORS clients can read these and `Retry-After`.
API responses are no-store. Proxy-generated failures may not use the API JSON envelope.

DTOs reject unknown properties and validate IDs, dates and supported query options.
JSON bodies default to a 16 KiB limit; uploads use a separate bounded multipart parser.
Typical errors are 400 invalid input, 401 invalid session, 403 CSRF/Origin failure,
404 unavailable resource, 409 duplicate/lifecycle conflict, 413 oversized payload,
415 media mismatch, 429 admission/throttle limit and 503 dependency failure.
Consult OpenAPI for each operation's supported responses.

## Pagination and updates

Catalog/history collections are bounded (default limit 25, maximum 100). Documents use an opaque
base64url timestamp/UUID/order cursor with createdAt ordering. Categories/tags use
ascending UUID cursors; version history uses descending version-number order with
UUID cursors. Keep filters/order fixed across pages; pagination is not a multi-request
snapshot. Cursors never grant access or select an owner.

PATCH omission preserves values, supported nullable fields clear with null, and
empty tag arrays clear assignments. There is no ETag/If-Match optimistic concurrency
contract. Date-only metadata uses `YYYY-MM-DD`; timestamps use ISO UTC.

## File and lifecycle workflows

[Documents](features/documents.md) describes initial multipart creation, metadata
validation, duplicate checks, archive/restore and soft deletion. [Versioning](features/document-versioning.md)
describes append-only uploads and history. Both upload operations require a UUID
`Idempotency-Key`; retry with the same complete body/key for the same operation.
Receipts are scoped to owner/operation/target and are not current detail snapshots.

Current-file download is a binary attachment with trusted MIME, checked Content-Length,
sanitized ASCII/UTF-8 Content-Disposition, private no-store and Accept-Ranges: none.
Range headers are ignored. Early read failures return safe JSON; failures after headers
close the connection. Ownership is checked at admission and cannot revoke bytes already
sent. File paths, storage keys and checksums are not exposed by document/version APIs.

Processing, historical-version download, extracted text, search indexes and chat
endpoints are **Not Implemented**. The [specification](specification.md) contains a
**Planned** target catalog, not an alternative reference for available endpoints.
