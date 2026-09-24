# Shared streaming storage

`@brainless/storage` is an independent npm package, matching `packages/database`.
Use Node 24+. Run `npm ci`, `npm run build`, `npm test`, and
`npm run test:integration` here. Tests use only isolated `mkdtemp` directories.

## Contract

`Storage` exposes `save(key, readable)`, `open(key)`, `exists(key)`, `metadata(key)`
and `delete(key)`. `STORAGE` is the shared runtime injection token. Save consumes
the source stream; callers must consume or destroy streams returned by open.
Metadata contains only key, byte size and last-modified time. Storage keys are
private server references, not HTTP response fields or authorization credentials.
The consuming use case must verify the authenticated document owner first.

Save always creates a new object; replacement is intentionally unsupported.
Concurrent creates at the same key produce one success and ALREADY_EXISTS for
the other. Delete returns true when removed, false when missing, and never removes
directories recursively. Missing reads/metadata return NOT_FOUND; missing existence
checks return false. Other stable codes are INVALID_KEY, UNAVAILABLE, READ_FAILED,
WRITE_FAILED and DELETE_FAILED. Messages never contain raw errors or host paths.
Late stream errors are sanitized too. No credentials, keys or contents are logged.

## Local adapter

The publication rationale is recorded in [ADR-001](../../docs/decisions/ADR-001-create-only-file-publication.md).

`LocalFileStorage` uses a dedicated absolute root supplied by configuration. It
performs no disk writes at construction; operations check accessibility and create
needed directories lazily. Upload and current-version download use this adapter. API readiness checks
PostgreSQL only; the Compose API healthcheck additionally checks storage-root access.
The root must be provisioned and accessible to the service account.

Writes use backpressure through Node pipeline into exclusive, private temporary
files beside the destination. Atomic hard-link publication followed by temporary
unlink is intentional: portable rename would overwrite an existing destination.
This preserves create-only semantics without a check-then-rename race. A local
filesystem supporting hard links (such as NTFS or the Linux Docker volume) is
required; unsupported filesystems fail safely. Handled source/write failures and
interruptions clean up temporary files. Objects are visible only after input ends.
There is no whole-file buffer, checksum, MIME or file-signature validation here.

Keys use lowercase ASCII segments, bounded lengths/depth, and forward slashes.
Absolute paths, backslashes, dot/traversal segments, null/control bytes, percent
encoding, empty segments, Windows device aliases, alternate streams and trailing
dots/spaces are rejected. `originalDocumentKey` builds
`documents/{userId}/{documentId}/{versionId}/original.{extension}` from trusted
UUIDs and a validated lowercase extension. Original filenames are display metadata
only and must never be passed as keys. DocumentVersion records are coordinated by the API, not this package.

The adapter checks every ancestor with lstat and rejects symlinks/junctions and
non-directories. Reads reject non-regular files, use O_NOFOLLOW where available,
and compare the opened inode to the checked file. Internal directories/files use
0700/0600 on POSIX; configure equivalent private ACLs on Windows. Restrict write
access to the root AND its parents to trusted processes. Portable Node filesystem
APIs do not offer an openat-style directory capability that protects against a
privileged local attacker concurrently replacing ancestors. This adapter is not a
sandbox for hostile local filesystem writers.

A process kill or power loss can leave private `.pending-*` files, never a partial
public object. They are rejected as storage keys. No automatic scavenger deletes
potentially active writes; inspect stale files during maintenance with all storage
writers stopped. Cleanup failures return WRITE_FAILED and need operator attention.
Atomic visibility does not promise power-loss durability or an atomic PostgreSQL
transaction. API upload coordination handles storage/database compensation; automatic crash
reconciliation is not implemented. See [architecture](../../docs/architecture.md).

## API and Compose

`StorageModule` binds STORAGE to LocalFileStorage using typed settings. Set
`STORAGE_PROVIDER=local` (default) and required `LOCAL_STORAGE_ROOT` to an absolute
directory outside the repository, not an ancestor containing it. Unsupported
providers, placeholders and invalid roots fail startup. A host-run API uses that
host directory; it does not share Docker's volume automatically.

The canonical Compose stack mounts `storage_data` at `/data/brainless` in the API
only. No public static server or web mount exists. Keep the existing Compose project
name and `postgres_data` volume. Compose builds DATABASE_URL from POSTGRES_*, runs
migrations automatically, and starts Nginx/web/API with `docker compose up --build`.
The image runs as UID 1000 (`node`); fresh volumes inherit its private directory
ownership. Existing mounts must already permit that account. See
[Compose setup](../../docs/compose.md) for HTTP cookie policy, backups, host development
and recorded passing Docker/browser verification. Never use `down -v` to update code.

A future S3-compatible adapter implements the same interface and neutral errors,
using conditional create semantics and streaming bodies. Only provider selection
and provider-specific validated configuration change; use cases continue injecting
STORAGE. No S3 SDK/server or signed URLs exist. The API now uses this package for
streaming upload with first-version creation and secure current-version download.
