# QYVRA architecture — v1.2.0 release candidate

[Documentation index](README.md) | [Release snapshot](releases/v1.0.0.md)

## Runtime overview

QYVRA is a modular monolith: a NestJS HTTP API, separate outbox and worker
processes, and a Next.js application. PostgreSQL is the durable system of record;
private file storage holds originals. RabbitMQ transports processing messages and
Redis holds optional disposable progress. The local Compose deployment also runs
Nginx and a one-shot migration task.

```mermaid
flowchart TD
    Browser -->|"HTTP localhost:8080"| Nginx
    Nginx -->|"/ and page routes"| Web[Next.js :3000]
    Nginx -->|"/api/ unchanged"| API[NestJS :3001]
    API -->|Prisma| DB[(PostgreSQL 17)]
    API -->|Storage interface| Files[(Private storage_data volume)]
    API -->|version + job + outbox transaction| DB
    Outbox[Outbox dispatcher and recovery] -->|due intents and retries| DB
    Outbox -->|confirmed publish| MQ[(RabbitMQ)]
    MQ -->|manual acknowledgement| Worker[Dedicated worker]
    Worker -->|job state| DB
    Worker -->|read-only original| Files
    Worker -.->|temporary progress| Redis[(Redis)]
    API -.->|optional progress| Redis
    Migrate[One-shot Prisma migrations] --> DB
    DB --- Data[(postgres_data volume)]
```

Only Nginx publishes a port, bound to loopback. There is no static file mount in
Nginx or Next.js. Downloads pass through API ownership checks. Compose waits for
PostgreSQL health, successful migrations, then API/web health before Nginx starts.
See [Compose](compose.md) for actual HTTP policy and production limitations.

## Backend

[AppModule](../apps/api/src/app.module.ts) composes Auth, Categories, Tags, Documents
and Health modules with Configuration, Storage and Observability providers. Controllers
validate transport inputs; services coordinate owned queries and transactions through
`PrismaService`. Document services also use the injected `STORAGE` interface.

[Application setup](../apps/api/src/configure-application.ts) supplies `/api/v1`,
strict DTO validation, bounded JSON parsing, CORS, security headers, no-store
responses, request correlation, envelopes and Swagger. Unknown input properties
are rejected. Business ownership always comes from session authentication.

Configuration is validated and frozen before the listener opens. `DatabaseModule`
connects and executes `SELECT 1` at startup and disconnects on shutdown. API readiness
checks lifecycle state and PostgreSQL; liveness performs no dependency I/O. Compose
adds a storage-root access check to its API healthcheck, but API readiness does not
check qpdf or storage. Upload failures can therefore coexist with healthy metadata reads.

`ObservabilityModule` provides AsyncLocalStorage request context and JSON stdout
logging. Correlation UUIDs survive asynchronous calls. Logs omit raw request bodies,
headers, URLs and query strings and redact credentials and sensitive fields. Use
stable event names and safe fields; redaction is not permission to log document content.

## Frontend and API communication

[Next.js App Router](../apps/web/app) composes routes; `features` contains behavior,
`components/ui` contains shadcn/Base UI primitives, and `lib/api` owns HTTP clients.
TanStack Query holds server state in memory; React Hook Form/Zod supports forms.
Tailwind CSS and next-themes supply responsive styling and Light/Dark/System themes.

Private data is currently fetched by the browser. The authentication provider checks
`/auth/me` before displaying protected content. This client gate is navigation/UI
protection; NestJS authorizes every private request. It does not protect future
private React Server Component payloads automatically.

Compose builds the web client with `/api/v1`, giving same-origin cookie requests
through Nginx. Host development uses `NEXT_PUBLIC_API_BASE_URL` and credentialed CORS;
Next.js has no automatic API proxy. Fetch uses credentials and no-store; multipart
XHR uses credentials, upload progress and cancellation. See [authentication](features/authentication.md)
for refresh synchronization and [web notes](../apps/web/README.md) for UI details.

## File storage and consistency

[Shared storage](../packages/storage/README.md) exports streaming save/open/metadata/
exists/delete operations and neutral errors. Only the local adapter is implemented.
Generated keys are private references; original filenames are display metadata.
Create-only publication preserves originals; see [ADR-001](decisions/ADR-001-create-only-file-publication.md).

Busboy receives bounded multipart streams while calculating SHA-256. After storage
staging, the infrastructure inspector streams a temporary copy for qpdf/Sharp checks.
A short database transaction commits metadata, immutable version and idempotency
receipt. No SQL transaction is held while receiving bytes. Failed SQL triggers
compensating deletion; uncertain commits are read back before deleting. If the outcome
cannot be determined, the object is preserved for reconciliation and the API fails safely.

Storage and SQL are not one atomic transaction. Crashes can leave orphan objects or
private pending files; automatic reconciliation is **Not Implemented**. Metadata
soft deletion preserves binaries. Download selects the highest version number,
checks size, pre-reads a bounded chunk and streams with backpressure. Early failures
produce safe JSON; failures after binary headers terminate the connection.

## Related boundaries and future scope

[Database](database.md) owns model/constraint details; [API](api.md) owns HTTP
conventions; [feature guides](README.md#features) explain user workflows and tests.
The [specification](specification.md) retains the **Planned** worker/search/AI/identity
architecture. No workers, broker, cache, search indexes or AI providers run in v1.0.0.

## v1.1.0 document query boundary

Phase 2 extends the current Documents module and frontend document feature. It
does not change the runtime topology above. DTOs validate an explicit list of
query and metadata fields; controllers pass authenticated owner context and
validated input to application services. The document service builds bounded,
owner-scoped Prisma queries and chooses the highest immutable version for current
file metadata. A small query helper within the module is appropriate if sort
cursor and predicate logic becomes hard to read; a generic repository/search
framework is not required. PostgreSQL remains authoritative for category, tags,
description, lifecycle and file metadata. File bytes remain behind `STORAGE`.

`apps/web/lib/api` owns the request/response schemas and query serialization.
`features/documents/query.ts` owns URL parsing; list and detail components use
those values and existing TanStack Query keys. Changing a filter or sort clears
the cursor. Reuse existing shadcn/Base UI primitives, organization selectors,
cache invalidation and responsive/theme patterns. React components must not
recreate API filtering or authorization rules.

The future search and AI phases may build derived projections from PostgreSQL
metadata and private files. They must preserve authenticated ownership filters
and can expose separate ranked search contracts when implemented. The v1.1.0
catalog keeps its explicit metadata filters and cursor contract; it requires no
Elasticsearch, Qdrant, embedding provider, broker, Redis or AI adapter.

## v1.2.0 processing boundary — implemented foundation

The runtime overview above includes the implemented Phase 3 deployment. The
[Phase 3 processing contract](phase-3-processing.md) distinguishes implemented
jobs, outbox delivery, worker transport, integrity execution, PostgreSQL
recovery, owned status reads, and implemented disposable Redis progress.
[ADR-002](decisions/ADR-002-durable-processing-outbox-worker.md) records why
these components share that boundary. **Implemented in T02/T03:** PostgreSQL
schema, atomic job/outbox creation, and conditional lifecycle/retry/outbox
repository operations. **Implemented in T04:** a transport-neutral publisher
interface, RabbitMQ adapter and broker service in Compose. **Implemented in T05:** a separate outbox process relays committed
intents to RabbitMQ with confirmation; the HTTP API does not publish directly.
**Implemented in T06:** a separate, non-HTTP worker context consumes the processing
queue, validates messages, and uses the T03 job boundary. **Implemented in T07:** the shared upload commit
transaction creates a version-specific verification job and outbox intent for
initial and later versions. RabbitMQ and worker availability do not gate upload
success. **Implemented in T08:** a production handler streams the original through
private storage and checks immutable size and SHA-256, returning an outcome for T03
to persist. **Implemented in T09:** the outbox runtime also polls PostgreSQL for
due retries and expired worker leases, creating new durable outbox intents without
publishing directly. **Implemented in T10:** the owned read-only API follows
client → processing-status controller → query service/repository → PostgreSQL.
**Implemented in T11:** the worker reports expiring, attempt-scoped progress
through an infrastructure-neutral interface; the owned API reads it only after
PostgreSQL ownership and active-state checks. Redis loss removes optional progress
only. **Implemented in T12:** document detail and inspected version history
consume the owned processing API through the shared frontend client and bounded
TanStack Query polling. The catalog does not issue one status request per row.
See the [processing contract](phase-3-processing.md)
for topology and confirm semantics.

Document lifecycle state and background job state have different purposes.
`Document.status` continues to describe the document and archive state; it must
not be used to represent a running worker. The first implemented worker operation
verifies stored-file integrity. Extraction and search indexes are outside this
foundation. Future ranked retrieval must preserve owner filtering and remain
separate from the existing catalog cursor contract.
