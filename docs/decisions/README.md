# Architecture Decision Records

[Documentation index](../README.md) | [Architecture](../architecture.md)

ADRs explain consequential choices and their tradeoffs. Use sequential filenames
`ADR-001-<decision>.md`, `ADR-002-<decision>.md`, and link the owning architecture
or feature guide. Start a proposed decision as Proposed, mark it Accepted when
agreed, and link a replacement when superseded. Do not silently rewrite history.

For a retrospective ADR, distinguish the recording date from the original decision
and cite repository evidence. Do not invent alternatives, motivations or meeting dates.
If rationale is unknown, document observed behavior in architecture instead.

## Index

- [ADR-001: Create-only local file publication](ADR-001-create-only-file-publication.md)
  - Accepted; retrospective record of an explicitly documented storage tradeoff.
- [ADR-002: Durable processing jobs, transactional outbox, and separate worker](ADR-002-durable-processing-outbox-worker.md)
  - Accepted for v1.2.0; T02/T03 implement persistence and rules while delivery and execution remain planned.

## Template

```markdown
# ADR-XXX: Decision Title

Status: Accepted
Date: YYYY-MM-DD

## Context

## Decision

## Alternatives Considered

## Consequences

### Positive

### Negative
```

Use the template's Accepted status for accepted decisions; change it to Proposed
while under review. A release reference and evidence links belong in Context for
retrospective records. PostgreSQL, Prisma and local authentication are documented
as current architecture without inventing a historical vendor-selection rationale.
