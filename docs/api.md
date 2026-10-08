# API conventions and OpenAPI

**Phase 4 T03 orchestration, T04 PDF extraction and T05 chunking are implemented:** [durable stage contracts and lifecycle](phase-4-processing.md)
cover atomic successor scheduling, v2 transport, shared retry/recovery, worker routing,
lifecycle fencing and the owned status extension. [Durable PDF text extraction](phase-4-pdf-extraction.md)
is implemented. [Deterministic chunks and citation provenance](phase-4-chunk-generation.md)
are implemented. [T06 embedding generation and durable checkpoints](phase-4-embedding-generation.md) are implemented. [T07 Qdrant indexing, activation and cleanup](phase-4-vector-indexing.md) are implemented. [T10 grounded answers and validated citations](phase-4-rag-answers.md) are implemented and opt-in. [T11 AI Search and authorized citation navigation](phase-4-ai-frontend.md) are implemented. OCR remains **Planned**. [T09 authorized semantic retrieval and search API](phase-4-semantic-search.md) are implemented and opt-in. [T08 upload/reprocess/restore enrollment and bounded backfill](phase-4-ingestion.md) are implemented and opt-in.

[Documentation index](README.md) | [Feature workflows](README.md#features)

## Generated endpoint reference

**T10 implemented:** `POST /api/v1/rag/answers` accepts `{question, documentIds?}`
through the existing session and CSRF/Origin guards. It returns an `answered` or
`insufficient_evidence` union in the standard no-store envelope. Answered claims
reference server-validated citation IDs; citation provenance comes from SQL, never
the LLM. Invalid generation returns safe 502 `AI_OUTPUT_INVALID`; provider outage
503, timeout 504 and admission/provider rate limit 429. See [T10 contracts and
configuration](phase-4-rag-answers.md) and the generated OpenAPI union. Citation-source
resolution and AI frontend are implemented in [T11](phase-4-ai-frontend.md).

T06 adds no HTTP routes. Embedding execution uses the existing owned processing-status
contract and optional `EMBEDDING` progress stage. Provider credentials, endpoints, input text
and vector arrays are never added to public job/status responses.

**Implemented Phase 4 API direction:** [the AI/RAG contract](phase-4-ai-rag.md#api-direction--t01-contract-and-current-slice-status)
defines owned semantic search, bounded cited answers, explicit idempotent current-version
reprocessing, citation-source resolution and additive processing-status fields.
`POST /search/semantic` is implemented in T09; RAG is implemented in [T10](phase-4-rag-answers.md); citation source resolution is implemented in [T11](phase-4-ai-frontend.md). T03 extends the existing processing-status DTO and generated
OpenAPI with optional pipeline metadata; it adds no route.
Ownership comes from session context; provider/profile/collection settings are
server controlled. Existing upload receipts and HTTP conventions are preserved.

Swagger is configured in [configure-swagger.ts](../apps/api/src/configure-swagger.ts)
from the implemented controllers and DTO decorators. Treat its generated OpenAPI as
the source of truth for endpoint-level documentation, rather than a parallel Markdown
catalog of current and future routes.

| Deployment    | Swagger UI                               | OpenAPI JSON                                   |
| ------------- | ---------------------------------------- | ---------------------------------------------- |
| Local Compose | [UI](http://localhost:8080/api/v1/docs/) | [JSON](http://localhost:8080/api/v1/docs-json) |
| Host defaults | [UI](http://localhost:3001/api/v1/docs/) | [JSON](http://localhost:3001/api/v1/docs-json) |

Both are available when the API runs. The global HTTP prefix is `/api/v1`; OpenAPI's
info version is `1`, distinct from product candidate v1.3.0. No standalone schema-export
or client-generation npm script exists. Future tooling can consume the running JSON
endpoint; do not claim it is already checked into the repository.

### Phase 4 implemented entry points

All routes use the authenticated internal user ID, strict DTOs and standard no-store
envelopes; request-provided ownership/profile/provider fields are rejected. POST
requests require `X-CSRF-Protection: 1` and the existing Origin policy. This table
links to detailed implemented contracts; controller-generated schemas remain authoritative.

| Method and route                                                           | Request / result                                                                                                        | Authorization, limits and failures                                                                                                                                                | Detailed contract                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/v1/documents/{documentId}/versions/{versionId}/processing`       | No input body; jobs, optional pipeline, SQL-derived `aiReadiness`                                                       | Owned UUID pair; unavailable/foreign version 404, anonymous 401; safe failures and disposable progress                                                                            | [Processing](phase-4-processing.md)                                         |
| `POST /api/v1/documents/{documentId}/versions/{versionId}/ai/reprocess`    | `{mode?}`; default `repair`, or `extraction`, `chunking`, `embedding`, `index`; 202 run ID/generation/status            | Owned eligible current version; UUIDv4 `Idempotency-Key` required; malformed 400, inaccessible 404, incompatible replay/state 409, disabled configuration 503                     | [Reprocessing](phase-4-ingestion.md#owned-reprocessing-contract)            |
| `POST /api/v1/search/semantic`                                             | `{query, limit?, documentIds?}`; canonical results/excerpts/profile/manifest IDs and similarity scores                  | Trimmed query 1–4,000 UTF-16 units; limit 1–20/default 8; optional 1–50 unique owned active document UUIDs; empty matches are valid; 429 admission, 503 unavailable, 504 deadline | [Search](phase-4-semantic-search.md)                                        |
| `POST /api/v1/rag/answers`                                                 | `{question, documentIds?}`; `answered` claims/citations or `insufficient_evidence` with null answer and empty citations | Question/scope bounds as above; authorized context and publication recheck; 502 invalid output, 429 rate limit, 503 outage/disabled, 504 timeout; insufficient evidence is 200    | [RAG](phase-4-rag-answers.md)                                               |
| `GET /api/v1/documents/{documentId}/versions/{versionId}/chunks/{chunkId}` | No query/body; exact canonical excerpt/hash/offsets, page spans and document/version/chunk metadata                     | Owned complete source; retained historical text is allowed, archived/deleted/foreign/missing source 404; malformed UUID/query/body 400                                            | [Citation source](phase-4-ai-frontend.md#minimal-additive-backend-contract) |

Common 400/401/403 validation/session/CSRF failures apply. Scores are similarity,
not confidence; limits and provider deadlines are validated server settings. No
public embedding, Qdrant-repair, permanent-purge or historical PDF-download route
is implied. Index-only reprocessing is the existing repair path after remote loss.

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

**Implemented in T10:** `GET /api/v1/documents/:documentId/versions/:versionId/processing`
returns the newest durable processing-job generation per type for one owned,
visible version. The session-authenticated, read-only route accepts UUID path
parameters and no query or body. `data` contains `documentId`,
`documentVersionId`, and a `jobs` array; `jobs: []` means no processing was
scheduled for that version. Each job exposes its ID, type, durable status,
attempt count/limit, timestamps, a `nextRetryAt` only while `RETRYING`, and a
sanitized failure category only while retrying or terminally failed. Archived
versions remain readable; missing, foreign, soft-deleted and `DELETING` resources
return the same `404`. The response is `no-store` and can be polled. It contains
no queue, outbox, worker, storage path or raw failure details. The generated
OpenAPI schema records the field-level contract. **Implemented in T11:** each job
also has nullable `progress` with `attempt`, `percent` (0–99), `stage` and
`updatedAt`. This is present only while PostgreSQL says `PROCESSING` and Redis
has current-attempt data; missing or unavailable Redis returns `null`. Durable
status always wins. Redis keys and connection details remain private. The frontend
status view is **Implemented in T12** on document detail and inspected versions.
The frontend reads this route through its authenticated API client; it never
reads Redis or the broker directly.

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

General processing mutation/retry endpoints, historical binary download, full extracted-text export and persistent chat endpoints remain **Planned**. T08 owned AI reprocessing, T09 semantic search, T10 grounded answers and T11 canonical chunk-source reads are implemented. The owned read-only
processing-status route above is implemented. The [specification](specification.md) contains a
**Planned** target catalog, not an alternative reference for available endpoints.

## v1.1.0 document contract

This section describes the implemented Phase 2 contract. Generated OpenAPI describes
available behavior. All routes below already exist; v1.1.0 adds no new route,
page-number pagination or search endpoint. Every operation requires the existing session cookie. Ownership always
comes from that session; a client-supplied `userId` is invalid. The existing
`{data, meta}` success and safe error envelopes remain unchanged.

The `description` and `currentVersion` additions to document list, detail, and
PATCH responses and the filename, MIME, all-of tags, and created/updated date
filters and allow-listed sorts are implemented. `currentVersion` is
either null or exactly the safe six-field summary
defined below; upload creation receipts and version-history responses are unchanged.

| Method and route                      | Existing behavior                                                            | v1.1.0 change and status                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/documents`               | Owned, non-deleted metadata page with filters, created-time sort and cursor. | Description, safe current-version summary, filename/MIME/all-of-tag/created/updated filters, and extended sorts implemented. |
| `GET /api/v1/documents/:documentId`   | Owned, non-deleted metadata detail.                                          | Description and safe current-version summary implemented.                                                                    |
| `PATCH /api/v1/documents/:documentId` | Owned metadata/association update.                                           | Optional description and current-version summary in response implemented.                                                    |
| `POST /api/v1/documents`              | Owned multipart creation with required file/title and idempotency key.       | Optional description implemented; the existing creation receipt shape, including immutable version metadata, is retained.    |

Existing category/tag CRUD, version routes, lifecycle routes and current download
are unchanged. The only document path parameter above is `:documentId`, an owned
UUID. Missing, foreign and soft-deleted documents remain indistinguishable 404s.
Read operations have no body; detail accepts no query parameters. PATCH remains a
nonempty JSON partial body. POST remains bounded multipart with exactly one file,
the existing metadata fields and a UUID `Idempotency-Key`. Mutations retain the
CSRF header/Origin policy. `description` is optional plain text: trim surrounding
whitespace, allow at most 2,000 characters after trimming, reject control
characters, and store an empty value as null. PATCH omission preserves the current
value and explicit null clears it. Upload omission or empty input stores null.
`verifiedSummary` remains read-only and separate from the owner's description.

Document list/detail/PATCH results add `description: string | null` and
`currentVersion: {id, versionNumber, originalFilename, mimeType, fileSize,
createdAt} | null`. `createdAt` in that object is the current version's upload
timestamp; document `createdAt` is catalog creation time. The current version is
the owned version with the highest `versionNumber`, as in download/history. Null
supports metadata-only legacy/test records. Storage keys, checksums, `userId`
and file bytes remain private. Existing response fields and the version-history
contract are retained. Old completed upload receipts remain valid and may omit
new fields because they are creation-time receipts, not document snapshots.

### Document list query

All parameters are optional on `GET /api/v1/documents`. They are explicit DTO
fields, never arbitrary Prisma column names. Multiple different filters combine
with AND; `q` searches the existing title/issuer/reference fields with OR inside
that filter. Filename matches only the current version, not any historical file.
Literal substring matching is case-insensitive and escapes SQL wildcard characters.

| Parameter                            | Values and behavior                                                                                                                               | Status                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `limit`                              | Integer 1–100; default 25.                                                                                                                        | Existing, unchanged                                       |
| `cursor`                             | Opaque next cursor from the preceding page, at most 4,096 encoded characters; keep filters and sort fixed.                                        | Implemented for all sorts; old createdAt cursors retained |
| `sort`                               | `-createdAt` (default), `createdAt`, `-updatedAt`, `title`, `-title`, `-fileSize`. Leading `-` means descending; no separate direction parameter. | Implemented                                               |
| `q`                                  | Nonblank literal substring, maximum 200 characters, across title, issuer and reference number.                                                    | Existing, unchanged; includes title search                |
| `categoryId`                         | One UUID; matching category owned by the caller. Foreign/unknown IDs yield no matches.                                                            | Existing, unchanged                                       |
| `tagId`                              | One UUID; match the owned tag.                                                                                                                    | Existing, unchanged                                       |
| `tagIds`                             | Comma-separated list of 1–10 distinct UUIDs; document must have **all** selected owned tags. Cannot accompany `tagId`.                            | Implemented                                               |
| `documentType`, `status`, `archived` | Existing validated type/status values and `true`/`false`; omitted archive filter includes active and archived.                                    | Existing, unchanged                                       |
| `dateFrom`, `dateTo`                 | Inclusive `YYYY-MM-DD` bounds on **documentDate**, not creation time.                                                                             | Existing, unchanged                                       |
| `expirationFrom`, `expirationTo`     | Inclusive bounds on `expirationDate`.                                                                                                             | Existing, unchanged                                       |
| `createdFrom`, `createdTo`           | Inclusive calendar-day bounds on document `createdAt` in UTC.                                                                                     | Implemented                                               |
| `updatedFrom`, `updatedTo`           | Inclusive calendar-day bounds on document `updatedAt` in UTC.                                                                                     | Implemented                                               |
| `filename`                           | Nonblank literal case-insensitive substring, maximum 200 characters, of current `originalFilename`.                                               | Implemented                                               |
| `mimeType`                           | Exact `application/pdf`, `image/jpeg` or `image/png` on current version.                                                                          | Implemented                                               |

Date-only values must be real calendar dates. Each supplied `From` must be on or
before its paired `To`; missing bounds are open. Timestamp ranges mean UTC
midnight at `From` through, but excluding, midnight after `To`. Documents with
null relevant dates do not match a supplied range. Repeated, malformed, unknown
or incompatible query parameters return 400, including `tagId` plus `tagIds`
and duplicate IDs within `tagIds` (case-insensitive).
Unknown or foreign category/tag IDs do not reveal their existence through errors.
`deletedAt` is always null in list results; no deleted-document listing is added.
Archive and all other filters combine with AND.

All sorts are server-side with a UUID tie-breaker in the same direction. `-fileSize`
orders the current version's file size descending and puts null current versions
last. `title` and `-title` use case-sensitive PostgreSQL `C` collation for stable
bytewise ordering; this differs intentionally from case-insensitive substring
filtering. Invalid sorts or a separate `direction` parameter return 400. Existing
`createdAt` cursors continue to decode for the two original sorts. New cursors
encode the selected sort key and UUID within the 4,096-character limit,
including a 300-character title. Cursors use canonical base64url encoding and
are validated against the selected sort; malformed or incompatible cursors return 400.
Cursors are navigation hints, not ownership grants or multi-request snapshots;
changing filters or sort restarts at the first page. Response pagination stays
`meta: {requestId, nextCursor, hasMore}` with `nextCursor: null` on the final page.
No offset/page number or exact total count is promised.

### Validation and expected responses

| Operation      | Success                                          | Expected failures                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List           | 200 with `data: Document[]` and cursor metadata. | 400 invalid/unsupported query or cursor; 401 unauthenticated; 500 unexpected persistence failure.                                                                                                                   |
| Detail         | 200 with `data: Document`.                       | 400 invalid UUID/unexpected query; 401 unauthenticated; 404 missing, foreign or deleted; 500 unexpected persistence failure.                                                                                        |
| PATCH          | 200 with updated `data: Document`.               | 400 malformed/empty body, invalid description or dates; 401 unauthenticated; 403 CSRF/Origin; 404 unavailable document/association; 409 lifecycle conflict; 413 body too large; 500 unexpected persistence failure. |
| Initial upload | 201 with the existing creation receipt.          | Existing 400/401/403/404/408/409/413/415/429/503 upload behavior, including invalid description as 400.                                                                                                             |

Adding description to upload must preserve the legacy fingerprint when description
is omitted or normalizes to null. A nonempty description participates in the
fingerprint. Replaying an old completed key returns its original 201 receipt
without rewriting it. New upload field-count and byte limits must accommodate
the bounded field while preserving all file validation and idempotency rules.

## v1.2.0 upload scheduling — Implemented in T07

**Implemented in T07:** successful initial and additional-version uploads now
schedule a `VERIFY_STORED_FILE` job and transactional outbox message for the
new immutable version. This is an internal side effect: multipart inputs and
the existing 201 response bodies are unchanged. Upload-key replay returns the
original receipt without scheduling another job. The request does not contact
RabbitMQ or run file verification. A scheduling failure rolls back the version
and receipt, and the existing upload compensation handles the stored object.
Actual verification is implemented in T08, and the owned status route is
implemented in T10. Both remain asynchronous to the upload request.

Archive and soft delete cancel unfinished version jobs atomically with the
document lifecycle change. Restore replays a cancelled integrity job when needed. With T08 ingestion enabled,
restore also enrolls the current PDF version using the earliest compatible stage;
complete retained extraction/chunks/embeddings lead to a new verified index. Historical
versions are excluded. The existing lifecycle response contracts are
unchanged; processing remains separate from `Document.status`. See the
[processing policy](phase-3-processing.md#archive-restore-and-deletion--implemented-processing-policy).

## Phase 4 owned AI reprocessing — Implemented in T08

POST /api/v1/documents/:documentId/versions/:versionId/ai/reprocess returns 202 with
the normal envelope and {runId,generation,status}. Session and mutation CSRF/Origin
rules, UUIDv4 Idempotency-Key and a strict optional mode (repair, extraction, chunking,
embedding, index) apply. Only active current owned PDFs qualify. See the
[canonical contract, modes and error behavior](phase-4-ingestion.md#owned-reprocessing-contract).
Provider/profile/collection settings and userId are never accepted. Upload responses
are unchanged; enabling ingestion enrolls AI runs in the upload transaction.
Semantic retrieval and RAG are implemented in T09/T10; citation-source resolution is implemented in [T11](phase-4-ai-frontend.md).

## Phase 4 T09 semantic search — Implemented

`POST /api/v1/search/semantic` accepts `{query, limit?, documentIds?}` through session and CSRF/Origin guards. Query is trimmed and capped at 4000 UTF-16 units; limit defaults to 8 (1–20); every optional document ID is owned and active. Returns `{results}` in the existing envelope, with SQL-canonical excerpts, source identifiers/page spans/offsets and cosine scores. No vectors or remote payload contents are public. See [full API/error/authorization contract](phase-4-semantic-search.md). Grounded RAG is implemented in [T10](phase-4-rag-answers.md).

## Phase 4 T11 owned source navigation and readiness — Implemented

`GET /api/v1/documents/:documentId/versions/:versionId/chunks/:chunkId` returns an owned complete canonical chunk with document/version identity, title, filename, ordinal, text/hash, scalar offsets and page spans. Session auth, UUID parameters, no query/body, standard no-store envelope and indistinguishable unavailable/foreign 404s apply. Retained historical sources are resolvable independently of index activation.

The existing version processing-status response adds `aiReadiness` (`READY`, `PROCESSING`, `FAILED`, `UNAVAILABLE`, `UNSUPPORTED`). READY requires the current active owned version, valid SQL ready pointer/complete manifest and API-compatible serving profile with semantic search enabled; a READY run alone is insufficient. It is durable eligibility rather than provider health. See [T11 fields, client behavior and security](phase-4-ai-frontend.md).
