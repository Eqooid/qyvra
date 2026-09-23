# Brainless API — Agent Instructions

These instructions apply to `apps/api` and extend the repository-root `AGENTS.md`. If they conflict, follow the more specific rule unless it violates a project-wide security or data-ownership requirement.

## Required context

Before changing the API, read:

- The repository-root `AGENTS.md`.
- `docs/specification.md` for product behavior.
- `docs/architecture.md` for system boundaries and asynchronous workflows.
- `docs/database.md` before changing entities, Prisma models, indexes, or migrations.
- `docs/api.md` before adding or changing HTTP contracts.
- `docs/roadmap.md` to confirm the current implementation phase.

Inspect the existing NestJS configuration and conventions before introducing a new pattern or dependency.

## Application responsibility

`apps/api` owns synchronous HTTP use cases, authorization, validation, persistence orchestration, file-upload coordination, and publishing background jobs.

It must not perform expensive document extraction, OCR, embedding generation, Qdrant indexing, Elasticsearch indexing, or reminder delivery inside HTTP request handlers. Those operations belong to workers.

## Module organization

Organize business capabilities under `src/modules`:

```text
src/
├── common/
├── configuration/
├── database/
├── infrastructure/
├── modules/
│   ├── auth/
│   ├── users/
│   ├── categories/
│   ├── tags/
│   ├── documents/
│   ├── processing/
│   ├── search/
│   ├── ai/
│   ├── reminders/
│   └── chat/
├── app.module.ts
└── main.ts
```

Within a module, prefer clear folders such as `controllers`, `application`, `domain`, `infrastructure`, and `dto` only when the module is large enough to benefit. Do not create empty architectural layers or one-file folders merely to imitate a pattern.

Modules expose intentional public APIs. Do not reach into another module's internal folders. Avoid circular dependencies and do not use `forwardRef()` to hide a poor boundary without documenting why it is unavoidable.

## Controllers and HTTP contracts

- Keep controllers thin: parse the request, invoke an application service or use case, and map the result.
- Use the `/api/v1` prefix and follow `docs/api.md`.
- Validate all path parameters, query parameters, headers, and bodies.
- Use DTOs for transport contracts; do not expose Prisma-generated types as public API contracts.
- Never accept `userId` as proof of ownership. Obtain it from the authenticated request context.
- Use correct HTTP status codes and the project's standard response and error envelopes.
- Do not leak stack traces, internal exceptions, storage paths, provider responses, or infrastructure details.
- Add Swagger decorators and examples for new public endpoints when Swagger is enabled.
- Preserve backward compatibility unless the task explicitly authorizes a breaking API change.

## Authentication and authorization

- Initially use PostgreSQL-backed local authentication and Argon2id password hashing.
- Store only password hashes; never log passwords or credential DTOs.
- Store session and refresh-token values as hashes where persistent storage is required.
- Use secure, HttpOnly, SameSite cookies when cookie-based sessions are selected.
- Apply login throttling, generic authentication errors, session expiration, rotation, and revocation.
- Use the stable internal `users.id` for ownership throughout the application.
- Keep external authentication provider-neutral through `provider + issuer + subject` so Keycloak can be added later.
- Do not use email as the permanent external identity key.
- Enforce authorization in application use cases or guards, not only in the frontend.
- Every read, update, delete, download, search, chat, and job-status operation must verify ownership.

## PostgreSQL and Prisma

- PostgreSQL is the source of truth.
- The shared Prisma schema and migrations belong in `packages/database` when that package exists; do not create a competing schema inside the API.
- Access Prisma through the established database module or repository boundary.
- Use explicit transactions for operations that must succeed or fail together.
- Keep transactions short and do not call external APIs, RabbitMQ, Qdrant, Elasticsearch, or file storage while holding a database transaction open unless the design explicitly requires it.
- Add database-level unique constraints, foreign keys, and indexes described in `docs/database.md`.
- Use soft deletion only for entities whose specification defines it, and apply the filter consistently.
- Avoid unbounded queries and N+1 access patterns.
- Use pagination for collections.
- Select only fields needed by the use case, especially for large document text.
- Never edit an existing applied migration to change history. Create a new migration.
- Do not run destructive migrations or reset a database without explicit user authorization.

When persistence and RabbitMQ publication must be atomic from the application's perspective, use a transactional outbox pattern rather than pretending a database transaction can include the broker.

## Files and document uploads

- Access uploaded files through the shared storage interface; controllers and use cases must not depend directly on local disk or a cloud SDK.
- Store binaries outside PostgreSQL. Persist only metadata, checksums, ownership, version details, and storage keys.
- Stream uploads where practical; do not load large PDFs fully into memory.
- Validate file signature, MIME type, extension, configured size limit, and ownership.
- Calculate SHA-256 checksums using streaming I/O.
- Use generated storage keys; never trust a client-provided filesystem path or filename as a storage path.
- Sanitize display filenames and prevent path traversal.
- If database creation succeeds but storage fails, or the reverse, use compensating cleanup and record a useful processing state.
- Do not send file bytes, base64 content, full extracted text, or vectors through RabbitMQ.

## RabbitMQ and background jobs

- The API creates durable job records and publishes compact messages containing stable identifiers, storage references, correlation IDs, and schema versions.
- Treat message delivery as at least once; consumers must be idempotent.
- Use durable exchanges and queues, explicit bindings, publisher confirms, retry policies, and dead-letter routing according to the architecture document.
- Do not acknowledge work in a consumer before its durable side effects are complete.
- Do not implement long-running work in the API merely because a worker does not exist yet. Create the contract and leave the feature unavailable until its roadmap phase is implemented.
- Keep message contracts in the shared messaging/contracts package when available.
- Version message schemas when introducing incompatible changes.

## Redis, Elasticsearch, Qdrant, and AI

- Redis is for ephemeral caching, locks, throttling, and job progress; it is not the system of record.
- Elasticsearch and Qdrant are rebuildable indexes. Do not treat either as authoritative ownership storage.
- Apply the authenticated internal `userId` filter to every Elasticsearch and Qdrant query.
- Keep text-generation and embedding providers behind separate interfaces.
- Domain and application services must not import OpenAI or Ollama SDKs directly.
- Query embeddings and stored document embeddings must use the same embedding profile.
- Never store API keys or secrets in model profiles, database metadata, request logs, or job payloads.
- Validate structured AI output before persisting it.
- Keep unverified AI-extracted fields separate from trusted user-verified document data.
- RAG responses must retain chunk and page citations and must not claim unsupported document facts.

## Errors, logging, and observability

- Use centralized exception mapping for predictable API errors.
- Define domain/application errors explicitly instead of throwing generic HTTP exceptions deep in business logic.
- Propagate or create a correlation ID for every request and background job.
- Use structured logs with stable event names and appropriate log levels.
- Redact authorization headers, cookies, passwords, tokens, API keys, document contents, and sensitive personal fields.
- Never silently catch an error. Handle it, translate it, retry it at the correct boundary, or rethrow it.
- Provide liveness and readiness endpoints. Readiness should reflect only dependencies required to serve the API safely.
- Support graceful shutdown for HTTP, database, cache, and messaging connections.

## Configuration and secrets

- Validate environment variables during startup and fail fast with a clear configuration error.
- Keep `.env.example` updated with placeholder values and explanations.
- Never commit real credentials.
- Do not give browser code access to server secrets.
- Prefer typed configuration access over scattered `process.env` reads.
- Keep provider URLs, timeouts, retry limits, upload limits, and feature flags configurable.

## TypeScript and NestJS conventions

- Use strict TypeScript and avoid unjustified `any`, unsafe casts, and non-null assertions.
- Prefer dependency injection and constructor injection.
- Keep providers focused and avoid oversized services.
- Use descriptive tokens for interfaces because TypeScript interfaces do not exist at runtime.
- Avoid global mutable state.
- Do not add a new library when NestJS, the standard library, or an existing dependency already solves the problem adequately.
- Do not introduce CQRS, event sourcing, or generic repository abstractions unless the current use case benefits materially and the decision is documented.

## Testing requirements

- Add unit tests for domain rules and application use cases.
- Add integration tests for Prisma repositories, authentication persistence, storage adapters, and messaging adapters.
- Add end-to-end tests for critical API workflows, including authentication, authorization, uploads, ownership isolation, pagination, and error responses.
- Test that one user cannot read or modify another user's resources.
- Test validation failures and duplicate or idempotent requests.
- Mock infrastructure at boundaries in unit tests; do not mock the behavior being tested.
- Use isolated test data and do not depend on execution order.

Before completing an API change, run the repository's relevant formatting, linting, type-checking, unit, integration, end-to-end, and build commands. Report any command that could not be run and why.

## Change checklist

For each API task:

1. Confirm the applicable specification and roadmap scope.
2. Inspect existing modules, database schema, and conventions.
3. Identify authorization and ownership requirements.
4. Define or update the transport contract.
5. Implement the use case and persistence/infrastructure boundaries.
6. Add database migrations only when required.
7. Add or update Swagger documentation.
8. Add tests at the appropriate levels.
9. Run verification commands and fix failures caused by the change.
10. Update `docs/api.md`, `docs/database.md`, or `docs/architecture.md` when the implementation changes an agreed contract.

