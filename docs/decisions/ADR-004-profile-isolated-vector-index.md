# ADR-004: Profile-isolated Qdrant indexes with PostgreSQL publication

Status: Accepted; indexing/publication/cleanup implemented in T07, retrieval in T09
Date: 2026-10-04

Implementation: [T07 runtime contract and operational procedures](../phase-4-vector-indexing.md),
6 October 2026. It retains the T01 profile-isolation decision and T02 schema.
Artifact-only rebuild records validated durable reuse stages in a new run;
ten-minute manifest tombstone sweeps catch late writes. Permanent purge remains
outside Phase 4 and requires cleanup/quiescence before hard deletion.

## Context

Embedding vectors are only comparable within a compatible immutable profile.
Qdrant is the requested initial derived index; PostgreSQL owns document lifecycle
and authorization. SQL and vector writes cannot share a transaction.

## Decision

Use a shared-owner collection per immutable embedding profile and index schema
generation. Index one fixed-dimension dense Cosine vector per chunk/build manifest.
Payload carries owner/source/profile/manifest identifiers, never document text or
secrets. Stable point UUIDs make same-build upserts idempotent. Confirm complete
writes before publishing a ready manifest/pointer in PostgreSQL.

Every search includes trusted user ownership, exact profile and eligible manifest
filters, followed by authoritative PostgreSQL validation before loading context.
Retire eligibility immediately on archive/delete/supersession; durable removal and
reconciliation use Phase 3 jobs, including a reviewed cleanup eligibility exception.
Keep profiles separate through rebuilds and explicit serving-profile switches.
See the [canonical index/retrieval contract](../phase-4-ai-rag.md).

## Alternatives considered

- A collection per user/document: multiplies operational collection management.
- Mix equal-dimension models: dimension equality does not ensure compatibility.
- Trust vector payload readiness/access flags: stale writes can outlive lifecycle changes.
- Delete then rebuild: unnecessarily removes the previous eligible same-version index.

## Consequences

### Positive

The index is rebuildable; ownership is enforced before context creation; late
remote writes cannot activate an obsolete build. Model migrations have explicit boundaries.

### Negative

SQL validation and eligible-manifest filtering add query work. Cleanup is eventual
and needs reconciliation against late writes. During a profile switch, uncovered
versions are unavailable. Retired collections and manifests need retention policy.
