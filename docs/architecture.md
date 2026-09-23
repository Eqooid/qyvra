# Brainless Architecture

## Local Phase 1 entry point

The canonical Compose configuration routes Nginx to Next.js and `/api/v1` to NestJS.
PostgreSQL and document storage retain their named volumes; migrations are a one-shot
startup dependency. Browser API requests are same-origin and files are served only
through authorized API downloads. See [Compose setup](compose.md) for local HTTP
cookie policy, private networking and streaming limits. Runtime and real-browser
verification passed; see [acceptance results](phase-1-browser-verification.md).
No Phase 2 service is included.

The implemented Phase 1 boundaries are described below and in the API contract.
Later worker, search and AI sections describe the target architecture for future
roadmap phases; they are not services required by the current Compose application.

## Implemented private storage boundary

Initial and additional-version uploads share one streaming ingestion/inspection and
storage compensation pipeline. Additional uploads stage a new create-only key, then
use a short PostgreSQL transaction with scoped receipt locking and an owned document
row lock for lifecycle checks and sequential numbering. No transaction is held while
receiving bytes. Old objects and immutable version records remain unchanged. Failure
cleanup and uncertain-commit readback use the same strategy as initial upload; the
documented crash-orphan reconciliation limitation remains. Version history reads
safe metadata only; historical download and processing are not implemented.

`packages/storage` owns the single provider-neutral streaming `Storage` contract,
`STORAGE` injection token, key utility, neutral errors and local filesystem adapter.
The API's `infrastructure/storage/StorageModule` selects the adapter from typed
configuration; use cases and future workers depend on Storage, not filesystem SDKs.
Upload now depends on this Storage token. Root validation is eager; directory access
is lazy. Metadata readiness still depends only on PostgreSQL; an unavailable storage
root or inspection tool makes upload fail safely with 503 without disabling metadata.

The required `LOCAL_STORAGE_ROOT` is an absolute dedicated directory outside the
repository. `STORAGE_PROVIDER` defaults to local and rejects unsupported providers.
The optional Compose API profile mounts private `storage_data` at `/data/brainless`
only in the API, leaving PostgreSQL unchanged. No web/static/Nginx access is added.
See [shared storage](../packages/storage/README.md) for streaming/create-only
publication, cleanup, symlink constraints, trusted local-writer assumptions and
future S3 adapter replacement. Current-version download now uses the same Storage
token after an owned, visible document query. It checks object size, opens a readable
stream, pre-reads one bounded chunk, and pipes the original to Express with backpressure.
Early failures return sanitized JSON; failures after binary headers close the
connection. Disconnect destroys the source; no filesystem path reaches the controller.

Authenticated Busboy multipart admission streams through bounded buffers and incremental
SHA-256 into the storage adapter's create-only publication. The infrastructure-level
UploadInspector copies the staged object as a stream into a private OS temporary
directory for random-access qpdf/Sharp inspection, then removes that directory. Only
that infrastructure component knows Node filesystem APIs; upload use cases use Storage.
qpdf checks structure/encryption/page count; Sharp checks image headers/dimensions and
final markers. No OCR, extraction, preview or processing job is performed. qpdf uses
an executable/argument array (no shell), bounded output and command timeouts. Configure
TMPDIR/TEMP on a private disk outside the repository with space for concurrent staging.

Storage precedes the short SQL transaction that creates document/version/joins and
the durable idempotency receipt. Failed SQL triggers compensating storage deletion;
cleanup failures log generated IDs only. Lost commit acknowledgements are read back
under the same advisory lock before deleting. An unknowable outcome preserves the
object and returns 503 for safe reconciliation. Crashes between storage and SQL can
leave orphans; a future reconciliation job must use committed version references and
a grace period longer than active upload leases. No RabbitMQ is introduced for cleanup.

## Implemented health boundary

`HealthModule` exposes process liveness and application readiness under
`/api/v1/health`. Readiness tracks bootstrap and graceful shutdown and queries
PostgreSQL through the shared Prisma client. Connection acquisition and query
execution each default to 500 ms (configurable up to 1000 ms each). Driver query
timeouts and PostgreSQL statement timeouts bound SQL execution. Liveness remains
local. No optional or deferred services are checked. Monitoring callers must also set
a short HTTP timeout to detect an unresponsive process. See `docs/api.md` and
`/api/v1/docs/` for response contracts.

## Implemented observability boundary

`ObservabilityModule` exports `RequestContext` and `StructuredLogger`. Request
context uses Node AsyncLocalStorage, preserving each request's correlation UUID
through asynchronous service calls without mixing concurrent requests. Import
the module in consuming modules and inject these services.

Application/Nest logs are JSON lines on stdout, with timestamp, level, stable event
name, correlationId (null outside requests), and sanitized data. Request completion
records method, status, and duration; aborted responses are logged once. Logs omit
raw headers, bodies, query strings, and URLs. Request failures log safe status/code
metadata instead of exception objects. Structured fields recursively redact
authorization, cookies, passwords, tokens, secrets, API keys, session credentials,
database URLs, request contents, and stacks. Error objects are suppressed and known
credential patterns in text are redacted. Application callers must use stable event
names and safe structured fields; never place sensitive content in free-form text.

The centralized HTTP exception filter emits the documented envelope and correlation
UUID. Request correlation is established before body parsing, so malformed JSON
also receives correlated errors. Authentication uses this shared observability boundary.

## Implemented configuration boundary

The API uses its existing `@nestjs/config` dependency through
`src/configuration/ConfigurationModule` and a typed `ConfigurationService`.
Startup validates and freezes application, HTTP, PostgreSQL URL/timeouts/pool, CORS,
session policy, and cookie settings before opening the HTTP listener. `DATABASE_URL`
is required in all environments. After validation, `DatabaseModule` connects through
`packages/database` before startup completes and disconnects after HTTP shutdown.
Only the configuration boundary reads process environment variables. The root
`.env` is supported in source and compiled execution, with process variables
taking precedence; process-level `NODE_ENV=test` disables `.env` loading.
See `apps/api/README.md` for defaults, units, and production cookie constraints.
Local registration and login now use these settings. Login verifies Argon2id before
a short PostgreSQL transaction serializes account failure/lockout updates or creates
a session and updates last-login metadata. Only hashes of independent random session
and refresh tokens are persisted. Cookies use validated scope and security attributes.
Browser login checks Origin against the configured allowlist. `AuthModule` exports
a reusable `SessionAuthGuard` and typed `CurrentUser` decorator. The guard hashes
the configured session cookie, checks PostgreSQL validity on every request, and
attaches a frozen public profile to a symbol-keyed request context. Activity writes
are throttled to once per minute with a database condition. Refresh rotates both
tokens under a session row lock; retained consumed hashes detect replay and revoke
that session. Logout conditionally revokes the current session and clears matching
cookies. Both use a mandatory custom CSRF-protection header plus the exact browser
Origin allowlist. CSRF protection for future business mutations remains required.

Session management uses the trusted user and current-session IDs attached by the
authentication guard. Queries and updates always include the owner ID. Listing is
bounded and projects only safe metadata; bulk revocation excludes the current
session. No device tracking or roles are introduced. `CurrentSession` exposes the
typed context separately from `CurrentUser` so `/auth/me` retains its public shape.

# 5. System architecture

<img src="docs/media/media/image1.png" title="Runtime architecture showing the client, Nginx, NestJS API and worker, PostgreSQL, Redis, object storage, RabbitMQ, Qdrant, Elasticsearch, and an AI provider." style="width:6.45in;height:3.655in" alt="Runtime architecture showing the client, Nginx, NestJS API and worker, PostgreSQL, Redis, object storage, RabbitMQ, Qdrant, Elasticsearch, and an AI provider." />

_Figure 1. Recommended modular-monolith runtime topology_

## 5.1 Component responsibilities

| **Component**  | **Responsibility**                             | **Must not own**                   |
| -------------- | ---------------------------------------------- | ---------------------------------- |
| Nginx          | TLS, reverse proxy, upload limits, compression | Authentication business logic      |
| NestJS API     | REST contracts, authorization, orchestration   | Long-running extraction            |
| NestJS worker  | Extraction, OCR, AI, embeddings, indexing      | Public HTTP sessions               |
| PostgreSQL     | Authoritative metadata, chunks, audit state    | Original file binaries             |
| Object storage | Original files and derived previews            | Search or user identity            |
| RabbitMQ       | At-least-once task delivery                    | Permanent job history or PDF bytes |
| Redis          | Cache, rate limits, locks, progress            | Durable business records           |
| Qdrant         | Vector similarity and vector payload filters   | Canonical text or document records |
| Elasticsearch  | Keyword index, highlights, aggregations        | Canonical metadata                 |
| AI adapters    | Embedding and generation provider calls        | Domain rules or authorization      |

## 5.2 NestJS code organization

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>apps/<br />
api/<br />
worker/<br />
libs/<br />
auth/<br />
documents/<br />
processing/<br />
search/<br />
ai/<br />
reminders/<br />
persistence/<br />
contracts/<br />
infrastructure/<br />
nginx/<br />
docker/</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

Begin as a modular monolith. The API and worker may be separate deployable processes in one repository and share contracts, while domain modules remain isolated behind interfaces.

## 5.3 Provider abstraction

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>EmbeddingProvider.embed(inputs) -&gt; vectors, model, dimensions, usage<br />
TextGenerationProvider.generate(prompt, schema?) -&gt; text/structured output, model, usage<br />
<br />
Adapters:<br />
OpenAIEmbeddingProvider<br />
OpenAITextGenerationProvider<br />
OllamaEmbeddingProvider<br />
OllamaTextGenerationProvider</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

| **Embedding compatibility:** Document and query vectors must use the same embedding profile. Switching from OpenAI to Ollama/Qwen requires re-embedding, not merely changing an API URL. |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |

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

# 10. Asynchronous jobs and events

<img src="docs/media/media/image2.png" title="Large-document ingestion pipeline from upload and file storage through page extraction, chunking, batch embedding, indexing, and ready status." style="width:6.45in;height:1.892in" alt="Large-document ingestion pipeline from upload and file storage through page extraction, chunking, batch embedding, indexing, and ready status." />

_Figure 2. Resumable large-file ingestion_

## 10.1 Queue catalog

| **Queue**                | **Input reference**           | **Output**                 |
| ------------------------ | ----------------------------- | -------------------------- |
| document.text-extraction | documentVersionId             | chunks and page count      |
| document.thumbnail       | documentVersionId             | preview files              |
| document.ai-extraction   | documentVersionId + profileId | candidate fields           |
| document.summary         | documentVersionId + profileId | candidate summary          |
| document.embedding       | documentVersionId + profileId | Qdrant points              |
| document.search-index    | documentId                    | Elasticsearch projection   |
| reminder.delivery        | reminderId                    | delivery status            |
| document.deletion        | documentId                    | removed derived data/files |

## 10.2 Message envelope

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"messageId": "uuid",<br />
"type": "document.embedding.requested",<br />
"occurredAt": "2026-09-05T10:00:00Z",<br />
"correlationId": "uuid",<br />
"causationId": "uuid",<br />
"attempt": 1,<br />
"payload": {<br />
"documentId": "uuid",<br />
"documentVersionId": "uuid",<br />
"profileId": "uuid"<br />
}<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

| **Message-size rule:** RabbitMQ messages carry identifiers and safe metadata only. Workers retrieve files and chunks from durable storage. Never publish PDF bytes, Base64 files, complete extracted text, or vector arrays. |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |

## 10.3 Retry policy

- Acknowledge only after durable state and downstream writes succeed.

- Use exponential backoff with jitter for temporary provider/network failures.

- Do not retry validation errors, unsupported files, or invalid model configuration indefinitely.

- Move exhausted messages to a dead-letter queue and mark the durable job FAILED.

- Use deterministic Qdrant point IDs and idempotency keys for repeat delivery.

- Resume missing chunks instead of reprocessing completed chunks.

## 10.4 Redis key conventions

| **Pattern**                      | **Purpose**                 | **TTL**         |
| -------------------------------- | --------------------------- | --------------- |
| rate:{userId}:{route}            | API rate limit              | window duration |
| job-progress:{jobId}             | Fast progress polling       | 24 hours        |
| lock:document:{versionId}:{step} | Duplicate worker prevention | bounded lease   |
| cache:dashboard:{userId}         | Dashboard summary           | 1-5 minutes     |
| upload:{uploadId}                | Temporary multipart state   | 1 hour          |

# 11. Search and RAG design

## 11.1 Qdrant point model

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"id": "deterministic-uuid",<br />
"vector": [0.012, -0.034, 0.056],<br />
"payload": {<br />
"userId": "uuid",<br />
"documentId": "uuid",<br />
"documentVersionId": "uuid",<br />
"chunkId": "uuid",<br />
"pageFrom": 3,<br />
"pageTo": 4,<br />
"embeddingProfile": "ollama-qwen-v1",<br />
"contentHash": "sha256"<br />
}<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

- Create payload indexes only for fields used in filters, especially userId, documentId, documentType, and categoryId.

- Keep canonical chunk text in PostgreSQL; Qdrant payload should stay compact.

- Use one collection per incompatible embedding profile during early implementation, or explicitly designed named vectors later.

- Query and stored vectors must come from the same model/profile.

## 11.2 Elasticsearch projection

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"documentId": "uuid",<br />
"userId": "uuid",<br />
"title": "ASUS Laptop Warranty",<br />
"documentType": "WARRANTY",<br />
"categoryId": "uuid",<br />
"tags": ["laptop", "warranty"],<br />
"issuer": "ASUS",<br />
"referenceNumber": "WR-123",<br />
"documentDate": "2026-08-10",<br />
"expirationDate": "2028-08-10",<br />
"summary": "...",<br />
"content": "...",<br />
"status": "READY"<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 11.3 Hybrid ranking

18. Run keyword and semantic retrieval independently with the same ownership and metadata filters.

19. Normalize or rank-fuse results rather than directly adding incomparable raw scores.

20. Optionally rerank a small candidate set after initial retrieval.

21. Return explainable result metadata: source mode, page, snippet, and matched filters.

## 11.4 RAG guardrails

- Retrieve only chunks authorized for the current internal user.

- Treat document text as untrusted data, not system instructions.

- Instruct the model to answer only from supplied context.

- Return an explicit insufficient-evidence response when context does not support an answer.

- Persist citations before showing the response as complete.

- Do not expose hidden system prompts, secrets, storage keys, or another user's identifiers.

## 11.5 Model migration

22. Create a new ai_model_profile and Qdrant collection.

23. Dual-write new chunks when appropriate.

24. Backfill existing chunks in resumable batches.

25. Evaluate retrieval quality using a fixed test set.

26. Switch the active profile and retain rollback temporarily.

27. Remove the old collection only after verification.

# 12. Security and privacy

Phase 1 HTTP hardening is detailed in `docs/api.md`: bounded JSON bodies, Helmet
headers, HTTPS-only production CORS origins, and bounded per-process authentication
request budgets supplement PostgreSQL account lockout. Forwarding headers are not
trusted; behind a proxy its callers share a budget. Before adding replicas, enforce
an additional shared edge rate limit. No Redis or other new service is introduced.
Development disables HSTS/HTTPS upgrading for local HTTP; production requires TLS
and Secure cookies. Cookie mutation routes currently use explicit Origin allowlisting
plus a non-simple custom CSRF header as documented in the API contract.

| **Area**       | **Requirement**                                                               |
| -------------- | ----------------------------------------------------------------------------- |
| Passwords      | Argon2id hash; never reversible encryption                                    |
| Sessions       | Hashed server token, Secure/HttpOnly/SameSite cookie, rotation and revocation |
| CSRF           | Token validation for cookie-authenticated mutations                           |
| Uploads        | Signature/MIME validation, byte/page limits, malware scanning extension       |
| Authorization  | Internal user ownership enforced in every repository/query                    |
| AI secrets     | Environment or secret manager; never database/log/frontend                    |
| Sensitive text | Do not log prompts, extracted text, chat context, or vectors by default       |
| Transport      | TLS at Nginx; private container network internally                            |
| Storage        | Encryption at rest in production and private object buckets                   |
| Deletion       | Propagate permanent deletion to every derived store                           |
| Audit          | Security events and administrative operations without content leakage         |
| Backups        | Encrypted PostgreSQL/object snapshots; tested restoration                     |

## 12.1 Keycloak migration boundary

Keycloak later owns authentication, federation, login UI, password policy, MFA, and token issuance. The application continues to own its internal user, documents, preferences, and domain authorization. Match external users by (provider, issuer, subject), not by email alone.

## 12.2 AI privacy choices

- Allow an account-level choice between disabled AI, local-only AI, and approved hosted AI.

- Display which provider/model will receive document text before enabling hosted processing.

- Allow reprocessing with a different provider and deletion of derived vectors/summaries.

- Record provider/model/prompt version and usage without storing hidden credentials.

# 13. Non-functional requirements

| **Category**   | **Initial target**                                                      |
| -------------- | ----------------------------------------------------------------------- |
| Availability   | Personal deployment; graceful degradation when AI/search is unavailable |
| Upload         | Configurable 50-200 MB maximum; resumable processing after upload       |
| API latency    | p95 under 500 ms for metadata CRUD on a healthy local deployment        |
| Search latency | p95 under 1.5 s for personal-scale index, excluding cold model startup  |
| Processing     | No whole-document memory requirement; bounded page/chunk batches        |
| Reliability    | At-least-once jobs with idempotent consumers and dead-letter handling   |
| Recovery       | Indexes rebuildable from PostgreSQL and object storage                  |
| Observability  | Structured logs, correlation IDs, metrics and dependency health         |
| Accessibility  | Keyboard navigation, visible focus, labels, adequate contrast           |
| Portability    | Docker Compose local environment; provider adapters selected by config  |

## 13.1 Graceful degradation

| **Unavailable dependency** | **Expected behavior**                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Redis                      | Core reads/writes continue where safe; cache and rate-limit behavior fails according to policy |
| RabbitMQ                   | Upload remains durable; processing status stays queued and publisher retries                   |
| Qdrant                     | Metadata and keyword search continue; semantic/RAG temporarily unavailable                     |
| Elasticsearch              | Metadata and semantic search continue; keyword mode unavailable                                |
| AI provider                | Documents remain usable; AI jobs retry or become visibly failed                                |
| Object storage             | Reject new upload; metadata reads continue; downloads unavailable                              |

## 13.2 Large-document rules

- Extract and OCR pages incrementally.

- Checkpoint processed page/chunk ranges.

- Embed batches rather than one request per chunk.

- Limit concurrent OCR and embedding work by available CPU/GPU and provider quotas.

- Expose progress and allow cancellation between safe checkpoints.

- Do not treat compressed upload bytes as the only resource limit; inspect page count and decompressed work.
