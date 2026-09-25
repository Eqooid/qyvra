# Development and documentation conventions

[Documentation index](../README.md) | [Contributing](../../CONTRIBUTING.md)

## Code and ownership

Use strict TypeScript and existing patterns. Keep routes/controllers thin, domain
rules in services, infrastructure access behind established boundaries, and frontend
HTTP calls in `lib/api`. Reuse UI primitives. Do not create empty modules for future
features. Derive ownership from authenticated `users.id`, validate all external
inputs and use safe projections/errors/logs. Read [architecture](../architecture.md),
[database](../database.md) and [API conventions](../api.md) before changing boundaries.

Preserve applied migrations, SQL-only constraints and unrelated working-tree changes.
Use the four independent npm projects; do not invent root workspace commands.
Tests and verification expectations live in [testing](testing.md).

## Documentation ownership

- README and feature guides explain what exists and the user workflow.
- Architecture, development and deployment guides explain how it works/runs.
- [ADRs](../decisions/README.md) record why consequential decisions were made, with evidence.
- Swagger generated from controllers/DTOs owns endpoint-level reference. Do not maintain
  a competing endpoint catalog in Markdown.
- Prisma schema plus migration SQL own entities and constraints. Explain invariants in
  prose; do not manually duplicate every column.
- Package scripts, environment validation and Compose configuration own runnable commands/defaults.

Use relative Markdown links, one canonical guide per topic and explicit **Planned**,
**Future** or **Not Implemented** labels. Dated implementation reports are historical
evidence, not current setup instructions. Preserve release snapshots as records of
that version; correct factual errors with clear attribution. Human docs stay separate
from agent instructions in `AGENTS.md`.

## Versioning

Brainless uses Semantic Versioning: `MAJOR.MINOR.PATCH`.

| Part  | Use                                                                            |
| ----- | ------------------------------------------------------------------------------ |
| MAJOR | Breaking changes or major product/architecture changes.                        |
| MINOR | Backward-compatible feature releases / major development phases.               |
| PATCH | Bug fixes, security fixes, documentation fixes and small maintenance releases. |

Examples: `v1.0.0` is the Phase 1 initial stable release; `v1.0.1` is Phase 1
maintenance; `v1.1.0` is the next compatible feature/phase release; `v1.1.1` fixes
that release; `v2.0.0` is a major breaking release. These examples are policy, not
claims that later releases exist.

Represent versions with Git tags/releases, normally not permanent version branches.
Move completed [Unreleased changelog](../../CHANGELOG.md) entries to a dated release
and capture the shipped scope/evidence in `docs/releases/`. Future backlog belongs
in the [roadmap](../roadmap.md), not Unreleased until work actually starts.

The four private npm manifests currently say `0.0.1`; generated OpenAPI uses version
  `1`, and HTTP uses `/api/v1`. Those identifiers serve different purposes and do not
  change the product release designation. The v1.1.0 release candidate retains
  them; the maintainer publishes the product version with a Git tag. Tag/release
  automation is **Not Implemented**.
