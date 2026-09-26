# Brainless developer documentation

**Current: v1.1.0 — document organization and metadata.** Start with the
[v1.1.0 developer changes](versions/v1.1.0.md) for descriptions, current-version
summaries, filters, sorting, cursor navigation, code navigation and upgrade notes.
It builds on the complete v1.0.0 guide below without duplicating unchanged domains.

Version history:

- [v1.1.0 developer changes](versions/v1.1.0.md): verified implementation delta and current document behavior.
- [v1.0.0 baseline chapters](#reading-map): preserved Phase 1 architecture and walkthroughs.
- [Release snapshots](../README.md#releases): scope and recorded acceptance evidence.

## Historical v1.0.0 developer guide

The 16 numbered chapters and the baseline inspection record below describe
v1.0.0. Use the v1.1.0 delta for changed behavior; source links open files in your
current checkout, so select the recorded baseline commit to inspect historical code.

This guide explains the completed **Phase 1 private document catalog** from its implementation. Start here if you know TypeScript but have not worked on Brainless. For a runnable first session, follow [development workflow](14-development-workflow.md), then read the architecture and workflow walkthroughs.

## Inspected baseline

| Item                        | Value                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Branch                      | `v1.0.0` (also tracked by `origin/v1.0.0` at inspection)                                         |
| Commit                      | `f208e8fa188b0942c16f5c356a7b17bbedc948ba`                                                       |
| Commit subject              | `Update docs version 1.0.0`                                                                      |
| Product release             | v1.0.0 / Phase 1, 24 September 2026                                                              |
| Tag at inspected commit     | None                                                                                             |
| Other locally available tag | `v1.1.0`, pointing to `f55dacf9bb5faecbf54460ce1daf3d4d6ebaf102`; not inspected as this baseline |

The working tree was clean before documentation generation. The branch, root README, [release snapshot](../releases/v1.0.0.md), and implemented modules agree on Phase 1. The private npm package versions remain `0.0.1`; OpenAPI reports `1`, and HTTP paths use `/api/v1`. These are separate identifiers. A v1.0.0 Git tag is not available locally, so this guide identifies the exact commit rather than claiming tag verification.

## Reading map

| Guide                                                                     | What you will learn                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [01 Project overview](01-project-overview.md)                             | Capabilities, boundaries, and why each major dependency appears                 |
| [02 Architecture](02-architecture.md)                                     | Runtime topology and request flow                                               |
| [03 Repository structure](03-repository-structure.md)                     | Where code belongs and “Where do I change...?”                                  |
| [04 Backend](04-backend.md)                                               | Bootstrap, modules, validation, persistence, and errors                         |
| [05 Frontend](05-frontend.md)                                             | Routes, forms, query state, HTTP clients, and themes                            |
| [06 Database](06-database.md)                                             | Models, ownership, constraints, and migration history                           |
| [07 Authentication and authorization](07-authentication-authorization.md) | Login walkthrough, cookies, refresh, CSRF, and ownership                        |
| [08 Document lifecycle](08-document-lifecycle.md)                         | Upload, metadata, versions, archive, restore, delete, and download walkthroughs |
| [09 File storage](09-file-storage.md)                                     | Streaming abstraction, immutable originals, and compensation                    |
| [10 API reference](10-api-reference.md)                                   | Controller-derived route map and contract notes                                 |
| [11 Configuration](11-configuration.md)                                   | Environment variables and differences between execution modes                   |
| [12 Docker and Nginx](12-docker-nginx.md)                                 | Images, routing, health, persistence, and commands                              |
| [13 Testing](13-testing.md)                                               | Unit, HTTP, database, component, storage, and browser suites                    |
| [14 Development workflow](14-development-workflow.md)                     | Install, configure, migrate, run, debug, and verify                             |
| [15 Troubleshooting](15-troubleshooting.md)                               | Symptoms traced to actual configuration and behavior                            |
| [16 Extending Brainless](16-extending-brainless.md)                       | A hypothetical document-field change through every layer                        |

Each chapter links to repository source. Existing [architecture](../architecture.md), [database](../database.md), [API conventions](../api.md), and [Compose operations](../compose.md) remain useful canonical references. Generated Swagger owns full transport schemas; this guide provides a version-specific navigation map. Historical implementation reports are evidence of earlier checks, not newly executed tests.

## Implementation discrepancies found

Use executable behavior and SQL when comments or descriptions disagree:

| Location                                                              | Discrepancy and verified behavior                                                                                                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Root web layout](../../apps/web/app/layout.tsx)                      | Page metadata describes processing/searching/discussing documents as current scope. Only metadata substring search exists; processing and chat are not implemented.                                        |
| [Tag controller](../../apps/api/src/modules/tags/tags.controller.ts)  | Delete Swagger text says no document relationships exist. `DocumentTag` exists; deleting a tag cascades joins and preserves documents.                                                                     |
| [Document DTO](../../apps/api/src/modules/documents/documents.dto.ts) | Comments call `dateFrom`/`dateTo` creation-date filters. [DocumentsService.list](../../apps/api/src/modules/documents/documents.service.ts) applies them to `documentDate`. `createdAt` controls ordering. |
| [Existing document guide](../features/documents.md)                   | Receiving-lease formula is split into a misleading list item. The repository adds **120 seconds** to receive timeout plus three inspection timeouts.                                                       |
| [Versioning convention](../development/conventions.md)                | Recommends release tags rather than permanent version branches; this checkout uses a `v1.0.0` branch with no matching local tag.                                                                           |

Application descriptions and comments were not modified by this documentation-only task.

## Scope and confidence

No workers, RabbitMQ, Redis, Qdrant, Elasticsearch, OCR, AI, reminders, external login, or full-text content search run in this baseline. Some schema/status vocabulary anticipates those features; vocabulary is not an implemented workflow. See [release limitations](../releases/v1.0.0.md#known-limitations-and-deferred-functionality).

This guide describes checked-in source and configuration. It does not establish the state of a developer's private database, secrets, volumes, or deployed services. Runtime acceptance evidence remains separately labeled in the [test guide](13-testing.md).

## Documentation verification record

Completed across the initial generation and its continuation, finalized 26 September 2026:

- The initial automated pass resolved 414 local Markdown links/anchors across these guides and the two entry-point READMEs. References added during final review were checked separately.
- TypeScript controller-decorator extraction matched all 34 documented HTTP routes, with no missing or invented routes. Swagger UI/JSON setup was inspected separately.
- Checked 47 explicit npm command references against package manifests, all 39 validated API environment setting names against the configuration guide, and all 11 Prisma models against the database guide. Reviewed DTO fields, defaults, ten migrations, Dockerfiles, Compose mappings and Nginx policy against source.
- Re-read the guides and manually reviewed all eight Mermaid diagrams, including relationship cardinalities and request sequencing. Replaced semicolons in sequence messages to avoid statement-separator ambiguity. Mermaid renderer execution was not completed: temporary validator installation from the interrupted run did not produce an available package. No project dependency was added.
- Markdown formatting, targeted final links and whitespace checks were performed after the final corrections. Git scope checks confirmed that the task changes only Markdown documentation.

Application tests, production builds, live Swagger requests and Docker startup were not rerun for this documentation-only change. Existing release evidence remains historical. The absence of a local v1.0.0 tag and lack of a Mermaid renderer check are explicit verification limitations; no deployed-service state or undocumented architectural rationale is inferred.
