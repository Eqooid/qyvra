# Brainless Database and Storage Model

## Implemented PostgreSQL foundation

### First immutable upload version and idempotency

Migration `20260915010000_document_upload` adds `document_versions` and
`document_uploads`. Follow-up `20260915020000_upload_completed_invariant` explicitly
forbids null completed fingerprints (PostgreSQL CHECK otherwise accepts UNKNOWN).
Existing migration history and developer databases are preserved.

DocumentVersion stores UUID id/documentId/userId, positive versionNumber, sanitized
originalFilename (255), unique relative storageKey (512), MIME (100), positive
fileSize in bytes (integer, hard ceiling 200 MiB), SHA-256 lowercase hex (64),
nullable positive pageCount, extractionStatus (default PENDING), and createdAt.
PDF requires pageCount; images require null. Initial document creation writes version 1.
Additional uploads allocate highest versionNumber + 1 under a document row lock.
Composite document/owner FK prevents cross-owner versions. Document deletion CASCADE
is intentional for future purge/isolated fixtures; current API deletion remains soft.
Unique document/version and owner/checksum constraints protect version numbering and
concurrent duplicate upload; checksum and document/createdAt/id indexes support lookup.
A trigger forbids changing original identity, ownership, file metadata, checksum,
version, page count or creation timestamp. Only extractionStatus can change later;
no processing mechanism is added now. Binary bytes are never stored in PostgreSQL.

DocumentUpload uses `(user_id,scope,key UUID)` as its primary key and an attempt UUID,
RECEIVING/COMPLETED state, nullable fingerprint/documentId/JSON response receipt,
createdAt/updatedAt/expiresAt and expiry index. Its owner FK restricts user deletion.
Null receipt fields are required while receiving; completed rows require all receipt
fields. The receipt document ID is not a cascading foreign key so maintenance can
retain a completed creation receipt independently. Rows are operation-specific,
contain safe response metadata only and expire according to docs/api.md.
Advisory locks serialize key reservations and completion; the entire document,
first version, tag joins and completed receipt commit in one short transaction.
Storage is staged before SQL, never while receiving inside a transaction. Failed
SQL is compensated by deletion; uncertain commits are read back under the same
lock, and files are preserved if the outcome cannot be established. Crash or cleanup
failure can leave an orphan; future reconciliation must compare server-generated
version keys with committed rows after a grace period and must not delete active uploads.

Migration `20260915030000_version_upload_scope` adds scope with default `create`,
preserving existing receipts, and expands the receipt primary key. A CHECK permits
only `create` or `versions:<document UUID>`. Additional uploads take the scoped
advisory lock and owned document FOR UPDATE lock during completion, recheck lifecycle,
allocate the next number and commit the new immutable version, UPLOADED document
state and receipt together. Receiving/inspection never holds the database transaction.
The original immutability trigger and owner/checksum unique constraint are unchanged.
Deploy this migration and regenerate the client before restarting the updated API;
do not run old and new API versions concurrently across this primary-key change.

### Document metadata migration

Migration `20260914050000_document_metadata` adds `documents` and `document_tags`.
Document uses a UUID internal owner, nullable owned category, title (1–300), flexible
uppercase `document_type` (1–50) and `status` (1–32) string columns, nullable issuer
and reference number (1–200), nullable date-only document/expiration dates, nullable
read-only verified summary (up to 10,000), archive flag and creation/update/deletion
timestamps. Defaults are OTHER and UPLOADED. No version, storage or processing tables
are introduced. Nullable fields represent absent metadata; null deletion means active.

Composite `(id, user_id)` keys on documents/categories/tags allow PostgreSQL to enforce
same-owner associations. `document_tags` has `(document_id, tag_id)` as its primary key,
an internal `user_id` for both owner-composite foreign keys, and `created_at`.
Deleting a tag or permanently deleting an isolated document fixture cascades only its
join rows. API deletion is soft and preserves joins. Categories referenced by any
document, including a soft-deleted document, cannot be deleted (RESTRICT; API 409).
There is no reassignment or permanent document purge endpoint.

Indexes cover `(user_id, created_at, id)`, `(user_id, status, document_date)`,
`(user_id, category_id)` and join `(user_id, tag_id, document_id)`. SQL checks enforce
archive/status consistency, valid date ordering, title hygiene and uppercase string
identifiers. They complement DTO validation; no PostgreSQL enums are introduced.
Metadata updates lock the owned document row and atomically validate associations,
update metadata and replace joins. Reads select safe fields and batch associations.
See `docs/api.md` for null/omission semantics and lifecycle transitions.

### Tags migration

Migration 20260914030000_tags adds tags with UUID id, required user_id, name
(varchar 100), created_at and updated_at. The owner foreign key references users.id
with RESTRICT; an index on (user_id, id) supports owned cursor pages. Like Categories,
a custom SQL expression unique index on (user_id, lower(name)) enforces case-insensitive
name uniqueness. Prisma cannot describe the expression index; preserve its migration
SQL. No alternate citext, normalized-name column or normalization strategy is added.

Categories and Tags share normalizeOwnedName (NFKC, trim and collapsed whitespace,
display case preserved). Name length is 1-100 Unicode code points. Database CHECK
constraints reject empty/padded/double-space/control-character names; direct writers
must submit normalized names too. Database locale defines case conversion, not accent
folding. Search escapes SQL LIKE metacharacters and applies the owner predicate.

Tags use permanent deletion, with no deleted_at field. The later document metadata
migration supplies owner-checked DocumentTag joins and tests cascade cleanup without
deleting documents. Tag writes remain
single atomic owner-filtered Prisma statements; no multi-record transaction is needed.

### Categories migration

Migration 20260914010000_categories adds categories with UUID id, required user_id
foreign key, name (varchar 100), nullable color (varchar 7), nullable icon (varchar
50), and required created_at/updated_at timestamps. The API preserves display case,
normalizes names with NFKC and collapsed/trimmed whitespace, and validates safe
styling. Null color/icon means no custom style; no other nullable fields are needed.
An owner/UUID index supports bounded list pagination. A unique SQL expression index
on (user_id, lower(name)) enforces case-insensitive uniqueness under PostgreSQL's
database locale; it is not accent folding. Prisma cannot represent this expression
index, so keep its SQL migration when evolving the schema. Do not replace it with
a case-sensitive Prisma compound unique declaration.

Database CHECK constraints reject empty/padded/double-space/control-character names,
non-lowercase six-digit hex colors and malformed icon slugs. API normalization runs
before persistence; direct database writers must submit normalized values too.
Ownership references users.id with RESTRICT on update/delete. Category writes and
deletions include both id and user_id in the SQL predicate. Categories are permanently
deleted when unused; no deleted_at column is added because only document recoverable
deletion is currently specified. Document foreign keys now restrict deletion of used
categories, including references preserved for recovery. Documents never cascade
from category deletion.

`packages/database` owns the Prisma 7 schema and generated client. It is a local
npm package linked from the API; the existing independent npm application layout
is preserved. `DatabaseModule` exports an injectable `PrismaService` with a reusable
`client`. The provider connects and executes `SELECT 1` before API startup completes,
then disconnects on application shutdown. Failures are reported without connection
details. The first authentication migration creates only the four tables described
below; the rest of the entity catalog remains planned work.

## Profile and password persistence

Profile updates select only public fields and filter by the authenticated users.id.
Password changes require the local identity (provider LOCAL, issuer local, subject
users.id). Argon2id work runs before the transaction. The transaction locks users,
local_credentials, then the current auth_sessions row, rechecks the credential hash
and current session validity, updates password_hash/password_changed_at, resets
failed-login state, and revokes every other owned session. Login uses the same
account/credential lock order and hash recheck, preventing stale verified passwords
from creating sessions after a password change. Logout-all locks the account before
revoking owned sessions, serializing with login. Current-session tokens are unchanged
by password changes. Existing consumed-refresh history remains intact.
There is no password-version column; no migration is added or modified.

## Phase 1 authentication schema

Migration `20260910160000_refresh_rotation` adds `consumed_refresh_tokens` with a
SHA-256 hex `token_hash` primary key, required session UUID foreign key, consumption
timestamp and session lookup index. No raw token is stored. Rows are retained for
the session lifetime and cascade only when that session is explicitly deleted.
There is no automated session/history cleanup job in this phase. Keep consumed
hashes while a session can still be used, including after later rotations.
Refresh locks the session row, archives the old refresh hash and replaces both
current token hashes in one transaction. A consumed or concurrently replaced hash
revokes the entire session and commits that revocation before returning 401.
The original `refresh_expires_at` remains the absolute session renewal deadline.
Logout performs an idempotent conditional revocation; it never deletes a session.
Session management uses the existing session columns and indexes without a new
migration. It lists unrevoked sessions with access or refresh eligibility, and uses
owner-filtered conditional updates for revocation. Consumed refresh history remains
intact. No device descriptions are fabricated or collected by these endpoints.

Migration `20260910090000_login_metadata` adds nullable `users.last_login_at`
(null until the first successful login) and required `auth_sessions.authentication_method`
(currently `LOCAL_PASSWORD`). No earlier migration was edited. Login stores session
creation/expiration timestamps and the authentication method as non-sensitive metadata;
it deliberately does not collect IP addresses, user-agent strings or device fingerprints.
Migration `20260910150000_session_last_seen` renames `last_used_at` to `last_seen_at`
and renames its CHECK constraint while preserving data and prior migrations.
Session authentication updates this nullable activity timestamp on first use and
at most once per minute thereafter, without extending session lifetime. Conditional
updates avoid duplicate writes across API processes. Null means not yet observed.
Login verifies Argon2id outside the transaction, then locks the user and credential
rows and rechecks deletion/password state. Failure counters commit independently
of the returned 401; session creation, failure reset and last-login update commit
atomically on success. Both tokens are independently random and persisted only as hashes.

Local registration now creates `users`, `user_identities` and `local_credentials`
in one transaction after Argon2id hashing. It does not create `auth_sessions`.
The registration integration suite uses an isolated migrated database, commits
registration requests to test concurrency, and cleans up only its randomly named
test accounts. Schema constraint tests continue to roll back their transactions.

The baseline specification previously listed entity responsibilities rather than
individual columns. The following choices make those requirements concrete:

| Table               | Fields and invariants                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`             | Database-generated UUID `id`, unique normalized lowercase/trimmed `email`, optional `display_name`, required `locale` (`en`) and `timezone` (`UTC`), `created_at`, `updated_at`, optional `deleted_at`. Deleted users retain their unique email reservation.                                                                     |
| `user_identities`   | UUID `id`, required `user_id`, `provider` (`LOCAL`, `KEYCLOAK`, `OIDC`), `issuer`, `subject`, creation/update timestamps. `(provider, issuer, subject)` is globally unique. Local identities require `issuer=local` and `subject=user_id`; external values come from the provider's stable issuer/subject, never email matching. |
| `local_credentials` | UUID `id`, unique required `user_id`, required Argon2id PHC `password_hash`, `password_changed_at`, nonnegative `failed_login_attempts` (zero initially), optional `last_failed_login_at`, optional `locked_until`, creation/update timestamps. A positive failed count requires a failure timestamp.                            |
| `auth_sessions`     | UUID `id`, required `user_id`, unique SHA-256 lowercase hex `token_hash`, required `expires_at`, optional paired `refresh_token_hash`/`refresh_expires_at`, optional `revoked_at` and `last_seen_at`, creation/update timestamps. Refresh hashes are unique when present.                                                        |

All timestamps are `timestamptz(3)`. Creation/update timestamps have database insert
defaults; Prisma `@updatedAt` updates modification timestamps for Prisma writes.
Direct SQL writers must maintain `updated_at` explicitly. Nullable fields represent
unprovided profile names, lifecycle events that have not occurred, or sessions with
no separate refresh token; no password data is nullable or stored on `users`.

Session expiration must follow creation. Refresh expiration cannot precede session
expiration. Revocation and last use cannot precede creation. Session state is derived
from revocation/expiration rather than stored in a stale status column: revoked
takes precedence, then expired, otherwise active. Failed-attempt and lockout fields
store policy state; local login now enforces the policy documented in `docs/api.md`.

SQL CHECK constraints enforce PHC/hash shapes, not cryptographic correctness.
Application authentication code must actually hash passwords with Argon2id and
random session/refresh tokens with SHA-256 before persistence. There are no plaintext
token/password columns. Never log hash values. All foreign keys reference the stable
internal UUID, with RESTRICT on delete/update to prevent silent credential/session
loss; normal user deletion uses `deleted_at`. Indexes support user identity lookup,
active-session lookup/revocation, and expiration cleanup. Email is not a domain
ownership key and can change without relinking identities or sessions.

Migration: `20260910080000_authentication_schema`. It includes the SQL-only CHECK
constraints in addition to the generated Prisma DDL, wrapped in a transaction.
No previously applied history was edited. Inject the target `DATABASE_URL` and run
`npm --prefix packages/database run migrate:deploy` before using these models.

Docker Compose provides PostgreSQL 17 with a named `postgres_data` volume and a
loopback-only host port. Set the placeholder initialization variables in root `.env`.
Initialization values apply only to an empty volume; changing them does not change
an existing database. Do not remove the volume to change credentials or apply schema.

The API validates `DATABASE_URL`, `DATABASE_CONNECT_TIMEOUT_MS` (1–1000, default 500),
`DATABASE_QUERY_TIMEOUT_MS` (1–1000, default 500), and `DATABASE_POOL_SIZE` (1–20,
default 5). PostgreSQL statement timeouts and driver query timeouts bound SQL work;
pool connection acquisition also has a timeout. Readiness executes only `SELECT 1`.
Timeout/pool overrides in connection URL query parameters are rejected; configure
these values through the dedicated typed settings instead.
Integration tests use `TEST_DATABASE_URL`. Connectivity checks are read-only;
authentication constraint tests insert/update rows inside transactions that always
roll back. Apply the migration to an isolated test database before running them.
Tests never reset, truncate, or drop existing tables.

# 6. Data and storage specification

| **Entity**              | **Purpose**                                         | **Key rule**                       |
| ----------------------- | --------------------------------------------------- | ---------------------------------- |
| users                   | Internal, provider-independent application identity | email unique; soft delete          |
| user_identities         | LOCAL/KEYCLOAK/OIDC identity mapping                | provider + issuer + subject unique |
| local_credentials       | Current PostgreSQL password authentication          | one per user; Argon2id             |
| auth_sessions           | Server-side session lifecycle                       | hashed token; expiry/revocation    |
| categories              | User-owned document category                        | user + name unique                 |
| tags                    | User-owned flexible label                           | user + name unique                 |
| documents               | Logical document and verified metadata              | owned by user                      |
| document_tags           | Document/tag many-to-many join                      | composite unique                   |
| document_versions       | Immutable uploaded file revision                    | document + version unique          |
| document_chunks         | Canonical extracted chunk text                      | version + index unique             |
| ai_model_profiles       | Provider/model/capability configuration             | code unique; no secrets            |
| chunk_embeddings        | Qdrant point reference and index status             | chunk + profile unique             |
| ai_processing_runs      | AI invocation audit and usage                       | correlation and prompt version     |
| extracted_fields        | AI/OCR/user metadata candidates                     | verification lifecycle             |
| processing_jobs         | Durable job state                                   | correlation ID unique              |
| processing_job_attempts | Retry/error history                                 | job + attempt unique               |
| reminders               | Scheduled document actions                          | idempotent delivery                |
| chat_sessions           | RAG conversation scope                              | owned by user                      |
| chat_messages           | User/assistant messages and usage                   | ordered by creation                |
| message_citations       | Message-to-chunk provenance                         | citation order                     |

## 6.1 Core relationships

- users 1:N documents, categories, tags, auth_sessions, chat_sessions

- users 1:N user_identities and users 1:0..1 local_credentials

- documents 1:N document_versions, reminders, processing_jobs, extracted_fields

- document_versions 1:N document_chunks, AI runs, and processing jobs

- document_chunks 1:N chunk_embeddings and message_citations

- ai_model_profiles 1:N AI runs, embeddings, and generated chat messages

## 6.2 Required indexes

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>users(email) UNIQUE<br />
user_identities(provider, issuer, subject) UNIQUE<br />
documents(user_id, created_at DESC)<br />
documents(user_id, status, document_date)<br />
document_versions(document_id, version_number) UNIQUE<br />
document_versions(checksum_sha256)<br />
document_chunks(document_version_id, chunk_index) UNIQUE<br />
chunk_embeddings(document_chunk_id, ai_model_profile_id) UNIQUE<br />
processing_jobs(status, available_at)<br />
reminders(status, remind_at)<br />
chat_messages(chat_session_id, created_at)</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 6.3 Storage paths

The shared `packages/storage` key generator now produces the original-object form
below with a validated extension in place of pdf. It uses trusted internal UUIDs;
original filenames are display metadata only. No storage key or absolute path is
accepted directly from clients or returned by current metadata/upload endpoints.
First original file/version persistence now uses this convention. See the
[storage contract](../packages/storage/README.md) for local volume and deletion semantics.

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>documents/{userId}/{documentId}/{versionId}/original.pdf<br />
documents/{userId}/{documentId}/{versionId}/preview/page-{n}.png<br />
documents/{userId}/{documentId}/{versionId}/extracted.txt</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 6.4 Deletion contract

Soft deletion hides a record but keeps recoverable data. Permanent deletion creates a background job that removes the original file, previews, Qdrant points, Elasticsearch record, chunks, citations, and derived data before finalizing the database tombstone. Failures remain retryable and auditable.

# Appendix A. Status models

| **Object**      | **States**                                                                  |
| --------------- | --------------------------------------------------------------------------- |
| Document        | UPLOADED, PROCESSING, READY, PARTIALLY_READY, FAILED, ARCHIVED, DELETING    |
| Extraction      | PENDING, PROCESSING, COMPLETED, PARTIAL, FAILED, CANCELLED                  |
| Job             | PENDING, QUEUED, PROCESSING, COMPLETED, FAILED, CANCEL_REQUESTED, CANCELLED |
| Embedding       | PENDING, PROCESSING, READY, FAILED, STALE                                   |
| Extracted field | PENDING, VERIFIED, REJECTED, SUPERSEDED                                     |
| Reminder        | SCHEDULED, SENT, FAILED, DISMISSED, CANCELLED                               |
| Session         | ACTIVE, EXPIRED, REVOKED                                                    |
