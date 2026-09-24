# ADR-001: Create-only local file publication

Status: Accepted
Date: 2026-09-24

## Context

This is a retrospective record made during the v1.0.0 documentation audit; the date
is the recording date, not a claim about the original decision date.
The [14 September storage report](../storage-implementation.md#contract-and-decisions)
and [storage contract](../../packages/storage/README.md#local-adapter) explicitly
record why portable rename was replaced. Immutable originals require a concurrent
write to an existing key to fail, rather than overwrite the previous object.

## Decision

Stream to an exclusive private temporary file beside the destination, then publish
with a hard link and unlink the temporary name. Save is create-only. The
[local adapter](../../packages/storage/src/local-storage.ts) returns ALREADY_EXISTS
when the destination exists, with no check-then-replace sequence. Generated keys
and a private root remain required. API use cases depend on the shared Storage
contract rather than filesystem operations.

## Alternatives Considered

Portable rename was explicitly considered in the existing implementation report:
it can overwrite the destination and therefore does not satisfy this contract.
No other historically considered alternatives are claimed.

## Consequences

### Positive

- Concurrent creates have one winner and preserve the existing immutable original.
- Objects become visible after streaming finishes, without whole-file buffering.
- The provider-neutral interface preserves create-only semantics for a future adapter.

### Negative

- The filesystem must support hard links; unsupported filesystems fail safely.
- Crashes may leave private pending files; there is no automatic scavenger.
- Atomic visibility is not power-loss durability or an atomic SQL/storage transaction.
  Upload orchestration needs compensation and uncertain-commit handling.
- Trusted local writers and private root/parent permissions remain necessary.

See [architecture](../architecture.md#file-storage-and-consistency) for the current
upload boundary and [release limitations](../releases/v1.0.0.md#known-limitations-and-deferred-functionality).
