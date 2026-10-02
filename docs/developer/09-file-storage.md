# 09 · File storage

[Guide index](README.md) · [Upload/download walkthroughs](08-document-lifecycle.md) · [Storage package reference](../../packages/storage/README.md)

Only local private filesystem storage is implemented. [StorageModule](../../apps/api/src/infrastructure/storage/storage.module.ts) binds the `STORAGE` token to `LocalFileStorage`; use cases depend on the shared interface from [storage.ts](../../packages/storage/src/storage.ts).

## Contract and keys

| Method              | Contract                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `save(key, source)` | Consume a readable stream and create an object; existing keys fail instead of being overwritten |
| `open(key)`         | Return a readable stream with bounded buffering and safe read errors                            |
| `metadata(key)`     | Return key, byte size and last-modified metadata for internal use                               |
| `exists(key)`       | Return false only for absence; propagate other failures                                         |
| `delete(key)`       | Return whether an object was removed; absence is harmless, other errors propagate               |

`StorageError` codes include `NOT_FOUND`, `INVALID_KEY`, `ALREADY_EXISTS`, `UNAVAILABLE`, `READ_FAILED`, `WRITE_FAILED` and `DELETE_FAILED`. They do not reveal filesystem paths.

[originalDocumentKey](../../packages/storage/src/storage-key.ts) generates:

```text
documents/<user UUID>/<document UUID>/<version UUID>/original.<extension>
```

UUIDs and extension come from validated/generated server values. The original filename is sanitized display metadata, never the storage path. Keys reject absolute paths, traversal, unsafe characters, Windows reserved names and excessive length/depth. They are not public URLs. API views exclude storage keys and checksums.

## Local adapter behavior

[LocalFileStorage](../../packages/storage/src/local-storage.ts) requires an absolute dedicated root. API configuration additionally rejects roots inside the checkout or containing it. The adapter walks existing ancestors, rejects symlinks/non-directories, creates directories privately, and checks regular-file identity while opening. Trusted local writers and private parent permissions remain necessary; this is not isolation against an attacker controlling the filesystem.

Saving streams into a sibling exclusive `.pending-<UUID>` file with private permissions, then publishes it with a hard link and unlinks the temporary name. A preexisting destination returns `ALREADY_EXISTS`. [ADR-001](../decisions/ADR-001-create-only-file-publication.md) records why portable rename was unsuitable: it can overwrite an immutable original during concurrent writes. The filesystem must support hard links. Publication provides atomic visibility, not an atomic SQL transaction or a promise of power-loss durability.

Opening validates file type/inode, then pipes through a 64 KiB PassThrough with safe errors. The API inspector may make a temporary copy to run qpdf/Sharp; it remains behind `Storage.open`, and inspection temporary directories are removed in `finally`.

## SQL/filesystem consistency

The [upload service](../../apps/api/src/modules/documents/upload.service.ts) coordinates two independent persistence systems:

| Outcome                              | Action                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Receive/inspection fails             | Attempt cleanup and release receiving reservation                            |
| SQL completion succeeds              | Keep original and return committed receipt                                   |
| Matching receipt replay              | Delete newly staged replay object; return prior receipt                      |
| Known SQL failure                    | Delete staged object and release reservation                                 |
| Completion acknowledgement fails     | Query receipt under the same lock before deciding whether deletion is safe   |
| Commit outcome cannot be established | Preserve object, emit `upload.commit_outcome_unknown`, return failure safely |
| Cleanup fails                        | Emit safe cleanup event; object may require later reconciliation             |

There is no background orphan/pending-file reconciler. Crash leftovers, expired receipts and session history are not automatically scavenged. Never delete a file solely because an HTTP client reported cancellation: completion may already have committed. Future maintenance would need to compare committed version references and active reservations with a grace period.

Soft deletion/archive do not call storage delete. Every version's bytes remain; checksum uniqueness still applies to those versions. Downloads open only the latest version and fail safely if its object is absent or size mismatches, rather than silently serving an older original.

## Host and container operations

For host development provision `LOCAL_STORAGE_ROOT` outside the repository, accessible only to trusted application users. Do not place it in web `public`, mount it into Nginx, or choose a directory containing unrelated data.

Compose mounts `storage_data` only into API at `/data/qyvra`. The API image provisions that directory for non-root `node` with private permissions; existing volume ownership is not recursively rewritten. Host storage and Compose storage are independent. See [Docker operations](12-docker-nginx.md) for diagnosing permissions and preserving volumes.

Back up PostgreSQL and original files at the same maintenance point with writers stopped. Database-only backups cannot reconstruct binaries; filesystem-only backups cannot reconstruct ownership/metadata. The [Compose runbook](../compose.md#persistence-and-manual-backups) contains manual backup commands. There is no automated backup/restore system in this release.

Tests live in [packages/storage/test](../../packages/storage/test), API parser/service specs and upload/download/version integration suites. They exercise immutable publication, concurrent creation, traversal/symlink rejection, interrupted writes, compensation and stream failures. See [testing](13-testing.md).
