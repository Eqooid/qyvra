# ADR-009: Search maintenance generations and bounded SQL cutover

Status: **Accepted for T10 implementation; live acceptance pending.**
Date: 15 October 2026.

## Context

The [approved T10 plan](../phase-5-search.md) requires isolated rebuilds, verified
SQL cutover, resumable maintenance and late-write cleanup. T02's fingerprint-only
uniqueness prevents a second physical generation with the same mapping profile.
The metadata-first PDF successor path advances the document-wide revision, which
would revoke the serving pointer if used unchanged for a shadow build.

## Decision

Use `(fingerprint, generation)` uniqueness; retain the existing profile hash,
immutable index names, SQL constraints, v3 contracts and deterministic projection
IDs. Ordinary enrollment prefers SERVING. A BUILDING shadow reuses canonical text
or runs integrity/extraction before its first lexical publication. Attach that
output while the projection remains BUILDING; do not mutate a published manifest
or advance the serving revision for shadow text completion.

Store maintenance audit/cursor/lease state in `SearchMaintenanceOperation`. Actual
work still uses existing jobs/outbox/workers. Allow one RUNNING operation, bounded
keysets, fixed scan cutoffs and per-document atomic checkpoint/enrollment. Operator
CLI access requires a trusted host/secret boundary and actual PostgreSQL operator
role membership; no public administrative endpoint is added.

Externally verify exact canonical search-visible publications first. Then use a
bounded SQL-only cutover with a short catalog-write fence and document/generation
locks to revalidate identity, lifecycle, revision and manifest before atomically
switching generation and ready pointers. Normal reads continue. Initial cutover
supports at most 1,000 eligible documents and a 30-second SQL transaction. Refuse
larger or stale states rather than claim an unbounded/zero-downtime guarantee.
Elasticsearch and SQL do not commit atomically. Retire old generations with retained
rollback information; rollback is a verified forward rebuild, not reactivation of
an immutable retired generation. Exact cleanup waits 24 hours for retirement and
rechecks removed manifests for late writes. Unknown/extra identities are report-only.

## Consequences

Stable public API/provider contracts and current-owner SQL authorization remain
unchanged. Same-schema rebuilds no longer require invented mapping versions or
changed configuration hashes. A coordinated generated-client/runtime rollout is
required; there is no automatic downgrade to fingerprint-only uniqueness once
multiple physical generations exist. Busy corpora can require additional shadow
passes or an operator mutation window. Terminal failed shadows require a fresh
generation; no serving pointer is sacrificed merely to retry an immutable shadow.

[Implementation, commands, tests and limitations](../phase-5-search-operations.md)
record local SQL/parser and simulated transport verification separately from
pending live Elasticsearch/broker/deployment acceptance. No release is authorized
by this decision.
