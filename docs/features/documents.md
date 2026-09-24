# Documents, uploads and downloads

[Documentation index](../README.md) | [Versioning](document-versioning.md)

## Purpose and workflow

Use `/documents` to browse and filter owned documents, `/documents/upload` to add
one PDF/JPEG/PNG, and `/documents/[documentId]` to view/edit metadata, download the
current original, archive, restore an archive or confirm soft deletion. The list
keeps filters in the URL and uses cursor navigation. Its search matches metadata
(title, issuer, reference number), not extracted file contents.

[DocumentsModule](../../apps/api/src/modules/documents) coordinates metadata,
lifecycle, upload and download services. [Document components](../../apps/web/features/documents)
and [API clients](../../apps/web/lib/api) own list/forms/detail and upload transport.
Models are `Document`, `DocumentTag`, `DocumentVersion`, `DocumentUpload` and owned
category/tag associations. See [database](../database.md) and [OpenAPI](../api.md).

## Validation and ownership

Every private operation filters by the authenticated internal user. Missing/foreign
resources are indistinguishable. Mutations require the CSRF header and browser Origin
policy; supplied owner IDs, status and infrastructure fields are not writable metadata.

Titles are trimmed, nonempty and at most 300 characters; document types are uppercase
identifiers up to 50 characters. Issuer/reference fields allow up to 200 characters.
Dates are real `YYYY-MM-DD` values, with expiration no earlier than document date.
Up to 100 tag UUIDs are accepted and duplicates removed; category/tags must be owned.
PATCH omission preserves fields, null clears nullable fields, and `[]` clears tags.
Verified summary is read-only; there is no summary generation in v1.0.0.

Metadata updates and associations commit atomically under a document row lock.
There is no ETag/If-Match conflict contract. The UI preserves recoverable form input,
but navigation guards cannot intercept every browser-history/programmatic transition.

## Upload and retry behavior

Creation uses multipart `POST /api/v1/documents`: exactly one file, required title,
optional metadata and a UUID `Idempotency-Key`. `tagIds` is a JSON array of owned IDs,
not tag names. Extra files/fields, mismatched MIME/extension/signature, empty input,
encrypted/damaged PDFs and configured resource-limit violations are rejected.
Defaults are 50 MiB, 500 PDF pages and 40 million image pixels. qpdf validates PDF
structure/encryption/pages; Sharp inspects images. This is not malware scanning or
complete image pixel-stream integrity verification.

Uploads stream through storage while computing SHA-256. Same-owner duplicate content
is forbidden across all versions, including archived/soft-deleted documents; different
owners may upload identical bytes. Successful creation yields `UPLOADED` and version 1
with extraction status `PENDING`. No processing job is queued.

Durable receipts last 24 hours. A matching replay revalidates bytes and normalized
metadata and returns the original creation receipt; conflicting input or concurrent
receiving returns 409. Receiving leases use receive timeout + three inspection timeouts

- 120 seconds. Expired keys can be reused, but checksum uniqueness still applies.
  There is no automatic receipt janitor. See [storage consistency](../architecture.md#file-storage-and-consistency).

XHR gives progress/cancellation. The form retains its retry key for unchanged input,
uses a new key for changed input, and does not automatically retry network failures.
Leaving/reloading loses the in-memory file/key; check the list before uploading again.
Cancellation near completion may race a committed upload; verify the list after an
ambiguous result. Storage/SQL compensation and abort tests cover handled failures;
crash orphan reconciliation is **Not Implemented**.

## Lifecycle and download

| Operation                              | Result                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Archive                                | Sets ARCHIVED and isArchived; metadata/joins/files remain.               |
| Soft delete                            | Sets deletedAt; ordinary list/detail/download/history hide the document. |
| Restore                                | Clears archive/deletion and returns UPLOADED; active rows are unchanged. |
| PROCESSING/DELETING lifecycle mutation | Conflicts; no processing is started by these routes.                     |

Archive/delete are idempotent for eligible owned rows. The API can restore an owned
soft-deleted ID, but a Trash/deleted-document recovery UI and permanent purge are
**Not Implemented**. Archived documents remain downloadable. The UI hides metadata editing on archived
documents, but the metadata PATCH API permits owned non-deleted records regardless
of archive state. New-version upload has stricter API lifecycle checks and rejects
archived/PROCESSING/DELETING documents.

Current download selects the highest immutable version number and returns an
attachment stream, never a storage path or signed URL. Archived originals are readable;
missing objects fail with 503 rather than falling back to an older version. Range
requests are not implemented. The UI probes headers, cancels that stream, then navigates
to the API for a native browser download: two authorized requests. It announces initiation,
not durable completion; a session/file change between requests can still fail.

## Tests and evidence

[API tests](../../apps/api/test) include document metadata/lifecycle, upload and
download HTTP and PostgreSQL integration suites. Service/parser specs cover bounded
streams, failures and ownership. [Storage tests](../../packages/storage/test) exercise
create-only files and traversal/symlink rejection. Frontend `documents`, `upload` and
`detail` client/integration tests are under [web tests](../../apps/web/tests).
[Browser workflows](../../apps/web/e2e/phase-one.spec.ts) compare downloaded bytes,
and [cancellation tests](../../apps/web/e2e/cancellation.spec.ts) verify cleanup.
Historical detail is retained in [upload](../upload-implementation.md),
[download](../download-implementation.md) and [metadata](../document-metadata-implementation.md) reports.
