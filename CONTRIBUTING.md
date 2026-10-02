# Contributing to QYVRA

Start with the [documentation index](docs/README.md), [local setup](docs/development/getting-started.md)
and [current release](docs/releases/v1.0.0.md). Phase 1 is complete; agree on a
specific feature or fix before implementing later [roadmap](docs/roadmap.md) work.

1. Inspect the relevant feature, architecture, source and tests. Preserve unrelated changes.
2. Keep changes focused. Use strict TypeScript and existing module/component boundaries.
3. Add tests for changed behavior and run relevant [checks](docs/development/testing.md).
4. Update the owning guide when behavior changes. Update Swagger decorators for HTTP
   changes and preserve applied migration history. Record significant decisions as [ADRs](docs/decisions/README.md).
5. Describe the problem, resulting behavior, verification and limitations in the PR.
   Add a concise changelog entry for completed changes awaiting release.

Do not commit populated environment files, uploaded documents, credentials, token/hash
values or test artifacts containing private data. Use isolated test databases and fixtures.
See [conventions and versioning](docs/development/conventions.md). No CI/CD workflow
is currently checked in; record checks actually performed without implying CI ran.

Documentation-only changes need link/path, command and factual verification; application
builds and database/browser workflows are unnecessary when behavior is unchanged.
`AGENTS.md` files are coding-agent instructions, not substitutes for these human guides.
