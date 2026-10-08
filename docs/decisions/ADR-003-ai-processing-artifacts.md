# ADR-003: Extend durable processing with versioned AI artifacts

Status: Accepted; implemented through T02–T08, confirmed in T13 release preparation
Date: 2026-10-04

Implementation confirmation: 2026-10-08; [durable processing](../phase-4-processing.md)
and [T12 verification](../phase-4-verification.md). The original T01 decision/date
and tradeoffs below are retained; this is not a newly invented design decision.

## Context

[ADR-002](ADR-002-durable-processing-outbox-worker.md) and the
[Phase 3 guide](../phase-3-processing.md) provide jobs, leases, outbox delivery,
retry/recovery and lifecycle cancellation. AI stages need dependencies, resumable
results and configuration identities without a second processing authority.

## Decision

Use the existing PostgreSQL job/outbox system and dedicated worker for extraction,
chunk generation, embeddings, vector indexing and vector removal. Add run metadata
and immutable artifacts, not a second executor. Persist complete extracted text,
chunks and per-chunk embedding checkpoints in PostgreSQL initially. Keep uploaded
binaries behind the existing storage abstraction.

Atomically commit lease-fenced stage completion, artifact publication and the next
job/outbox intent. Serialize builds per version under the existing one-active-job
constraint. Snapshot immutable configurations; deterministic chunk UUIDs survive
identical reruns. Separate job generations, artifact fingerprints and embedding
profiles. Use dual v1/v2 consumers before enabling expanded stage envelopes.
See the [canonical lifecycle and data contract](../phase-4-ai-rag.md).

## Alternatives considered

- A new AI scheduler/queue: duplicates durable retry, cancellation and recovery rules.
- Extraction during upload: couples document availability to parser/provider latency.
- All results in Redis/Qdrant: loses the authoritative checkpoint/rebuild source.
- External embedding artifacts immediately: viable later, but adds a storage/SQL
  reconciliation boundary before measured scale requires it.

## Consequences

### Positive

Reuse tested recovery/ownership boundaries; retries resume artifacts, and completed
stages cannot lose downstream scheduling after a crash.

### Negative

Requires extending the current handler completion transaction and transport
validation. PostgreSQL text/vector storage increases backup size. Remote calls may
repeat after crashes and incur duplicate billing. AI run metadata must never evolve
into an independent job lifecycle engine.
