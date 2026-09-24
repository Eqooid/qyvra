# Brainless delivery roadmap

[Documentation index](README.md) | [v1.0.0 snapshot](releases/v1.0.0.md)

## Current release

**Phase 1 is complete and released as v1.0.0 on 24 September 2026.** The
[acceptance review](phase-1-review.md) and [browser verification](phase-1-browser-verification.md)
record evidence. Completed scope:

- API configuration, HTTP envelopes/validation, logging, health and generated OpenAPI.
- PostgreSQL/Prisma lifecycle, constraints and migrations.
- Local authentication, profile/password settings and session APIs.
- Categories/tags and owned document metadata/lifecycle.
- Private storage, validated uploads, checksums, idempotency and immutable versions.
- Current-file download, catalog/detail/upload/history/organization/account UI.
- Local Compose/Nginx startup, migrations, persistence and isolated browser verification.

CI was a foundation target but no CI/CD workflow is checked in. It is a deferred
engineering gap, not evidence that the delivered usable-tracker acceptance failed.
See the snapshot for precise limitations; do not redo completed Phase 1 slices.

## Planned phases - not implemented

| Phase | Planned deliverable                                   | Planned additions                                                |
| ----- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| 2     | Document processing, progress, retries and reminders  | Workers, RabbitMQ, Redis, extraction/OCR extension points        |
| 3     | Reviewable AI metadata, semantic search and cited Q&A | Independent generation/embedding adapters, Ollama/OpenAI, Qdrant |
| 4     | Advanced keyword and hybrid search                    | Elasticsearch, highlights, autocomplete and ranking              |
| 5     | Identity upgrade                                      | Keycloak/OIDC integration retaining internal ownership IDs       |

These are the existing [product targets](specification.md), not installed services
or promises that all features fit a particular next release. Select a bounded scope
before implementation; v1.1.0 is the example next compatible feature release under
[versioning policy](development/conventions.md#versioning).

Historical slice results remain in the [audit/evidence index](documentation-audit.md).
Future work should update the owning feature/architecture/environment/API guides,
add justified ADRs, record actual verification and create a separate release snapshot.
