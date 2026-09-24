# Immutable document versions

[Documentation index](../README.md) | [Documents and shared upload rules](documents.md)

From document detail, open `/documents/[documentId]/versions` to inspect paginated
history, expand safe file metadata, or upload one new PDF/JPEG/PNG. New versions
preserve logical document metadata and all prior originals. The highest version
number is current; there is no current-version pointer or version promotion endpoint.

## Implementation

`VersionsController`, `VersionsService`, `UploadService` and `UploadRepository` live
in [DocumentsModule](../../apps/api/src/modules/documents). Models are
`DocumentVersion`, `DocumentUpload` and `Document`. Frontend `version-history`,
`version-metadata` and `version-upload` components use the
[versions client](../../apps/web/lib/api/versions.ts).

The API provides list/detail metadata and upload under `/api/v1/documents/:documentId/versions`.
See [OpenAPI](../api.md) for DTOs. Metadata excludes storage keys, checksums and owner IDs.
History sorts newest first with a UUID cursor; unknown/unavailable cursors return 400.
Reads use a consistent per-request transaction snapshot, not a multi-page snapshot.

## Authorization, validation and edge cases

Owned non-deleted documents are required; foreign document/version combinations
return 404. Archived history is readable; DELETING history is hidden. Upload rejects
archived/PROCESSING/DELETING state and rechecks lifecycle before commit or replay.

Additional uploads accept exactly one file and no metadata, use the same inspection,
size and duplicate rules as initial upload, and require session, CSRF and a UUID
idempotency key. Receipt scope includes owner, operation and target document, so a
key used for initial creation is independent of that key used for a version upload.

A short owned document row lock allocates highest version number + 1. Unique constraints
and an SQL immutability trigger protect originals; only extraction status is available
for future updates. New versions set document state UPLOADED and extraction PENDING.
The `(user_id, checksum_sha256)` constraint also rejects re-uploading an older version's
bytes, even under another owned document.

Replay returns the original 201 receipt, whose `isLatest` describes creation time.
The UI refreshes authoritative history/detail after success instead of treating a
stale replay as current. Retries keep the same key only for unchanged input.
Historical-version downloads, version edits/deletion and processing are **Not Implemented**.

## Tests and evidence

[Version service specs](../../apps/api/src/modules/documents/versions.service.spec.ts),
[PostgreSQL integration](../../apps/api/test/versions.integration-spec.ts) and
[HTTP tests](../../apps/api/test/versions.e2e-spec.ts) cover ordering, concurrency,
replay, immutability and ownership. [Frontend tests](../../apps/web/tests/versions.integration.test.tsx)
cover history states, confirmation, progress/cancellation and replay refresh.
[Browser verification](../phase-1-browser-verification.md) confirms new versions and
latest-file downloads. Historical [backend](../versioning-implementation.md) and
[frontend](../web-versioning-implementation.md) reports retain implementation evidence.
