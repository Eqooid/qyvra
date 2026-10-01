# ADR-002: Durable processing jobs, transactional outbox, and separate worker

Status: Accepted and implemented through T12; T13 verified the full-stack path
Date: 2026-09-27

## Context

At the time of this decision, the implemented upload workflow committed immutable document/version metadata and
an idempotency receipt in PostgreSQL after storing and inspecting the original.
It has no job table, broker, worker, or retry mechanism. A future background task
must survive an API crash or RabbitMQ outage without making an uploaded document
disappear. PostgreSQL and RabbitMQ cannot share one application transaction.
The existing `Document.status = PROCESSING` vocabulary also affects archive and
version-upload rules, so it cannot safely stand for background execution.

The [Phase 3 processing contract](../phase-3-processing.md) records the lifecycle,
topology, security rules, and release exclusions. This ADR records the single
foundational decision; current implementation status is summarized below.

## Decision

**Implemented — v1.2.0 release candidate:** PostgreSQL owns version-specific processing jobs,
attempt counts, retry due times, execution leases, terminal results, and an outbox
of publication intents. An upload transaction will commit its version, completed
receipt, job, and initial outbox intent together. A separate publisher will relay
committed intents to RabbitMQ using publisher confirmation and routing checks.
The worker will run independently of the HTTP API, resolve authoritative rows
from PostgreSQL, process through the existing storage contract, persist its
outcome, and then acknowledge the message.

Messaging and progress will have narrow infrastructure adapters; business logic
will not depend directly on RabbitMQ or Redis APIs. RabbitMQ transports compact
identifiers at least once. Redis may cache expiring execution progress but is
not a job, document, retry, or result store. Background state will not use
`Document.status` or claim that file verification completed extraction.

The first handler will stream and verify stored-file size and SHA-256 against the
immutable version record. No AI or external search provider is part of this
decision.

## Rationale

Committing a job and outbox intent with the version closes the database/broker
dual-write gap. A committed intent remains discoverable when the broker is down
or the publisher crashes. Duplicate publication remains possible after an
ambiguous confirmation, so a worker must use job identity and conditional state
transitions for idempotency. PostgreSQL leases and bounded attempts make
interrupted work recoverable without treating broker redelivery or Redis as the
source of truth. Keeping the worker separate protects HTTP latency and lets
processing be stopped or scaled independently.

## Alternatives Considered

- **Publish directly from the upload handler after SQL commit:** a crash between
  commit and publication could strand work with no durable publication intent.
- **Publish before SQL commit:** a worker could receive an event for a version
  that later rolls back.
- **Use RabbitMQ or Redis as the job database:** neither would share the version
  transaction or preserve the authoritative ownership/lifecycle relationship.
- **Run verification inside the HTTP request:** this would extend upload latency
  and provide no independent recovery path after response or process failure.
- **Set `Document.status` to `PROCESSING`:** current document lifecycle code blocks
  archive and new-version upload in that state, changing existing behavior.

## Consequences

### Positive

- Version creation and required background-work intent can succeed or fail
  together in PostgreSQL.
- Broker outages and publisher restarts do not erase committed work.
- Job state and safe failure codes can support an owned API without exposing
  queue internals.
- The same scheduling boundary can later support new handlers without adding
  RabbitMQ APIs to controllers or document-domain code.

### Negative

- An outbox relay, recovery loop, bounded leases, and dead-letter reconciliation
  add operational work and test cases.
- At-least-once publication/consumption requires idempotent handlers; exactly-once
  delivery is not provided.
- PostgreSQL, broker, worker, and optional Redis need separate health, credentials,
  shutdown, and deployment policies.
- Stored-file verification rereads uploaded bytes and needs concurrency limits.

## Future implications

Message versions and handler versions must support staged deployment. Future
extraction, search projections, and AI jobs may add types and queues when their
scope is approved; they do not change PostgreSQL's ownership of durable work.
Any later search index remains rebuildable from authoritative metadata and
private originals. The exact schema, retry limits, queue policies, and API DTO
will be finalized and tested in implementation tasks, without revising this
boundary silently.

## Implementation status

T02 adds the PostgreSQL job/outbox tables and atomic creation function. T03 adds
conditional lifecycle, retry, recovery-candidate, and outbox repository operations.
T04/T05 add RabbitMQ delivery through a separate outbox process; T06 adds the
independently runnable consumer. T07 attaches scheduling to the shared upload
transaction, so each new version, job, outbox intent and completed upload
receipt commit together. Initial and later-version uploads use the same boundary.
T03 now takes the document row lock before its processing advisory lock, matching
upload transactions and avoiding a cross-path deadlock. T08 adds production
stored-file integrity execution. T09 adds PostgreSQL-backed due-retry scheduling
and expired-lease recovery in the existing outbox process. T10 adds the owned
read-only API over PostgreSQL. T11 adds best-effort, expiring Redis progress for
the current attempt without changing the durable job/outbox decision.
The implemented foundation does not change the decision or historical context above.
