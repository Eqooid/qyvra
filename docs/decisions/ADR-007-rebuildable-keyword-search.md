# ADR-007: Rebuildable keyword projections with SQL publication

Status: **Accepted for the approved Phase 5 design; T02–T10 runtime implemented, mandatory live acceptance pending.**

Current [T11 review](../phase-5-verification.md) records candidate boundaries,
verification and outstanding gates. Dated updates below preserve task context.

Implementation update: [T05 lexical publication](../phase-5-lexical-publication.md)
shares model-independent extraction and implements the approved SQL publication
protocol. T04/T05 live acceptance and later query/operational tasks remain pending.

T06 update: [authorized keyword search](../phase-5-keyword-search.md) implements
pre-query SQL scopes and a final canonical authorization snapshot. Raw shared-index
scores remain internal; responses expose ordinal ranks. T07 retains cursor/window
ownership. Live query and deployment acceptance remain pending.

Date: 2026-10-13

## Context

The [roadmap](../roadmap.md) assigns Elasticsearch keyword and hybrid search to
Phase 5. [T01](../phase-5-search.md) audits v1.3.1: canonical owned extraction and
durable processing exist, but extraction execution requires a desired AI run and
jobs require immutable file-version identity. Elasticsearch is not installed.

Document metadata, associations and lifecycle can change while index writes run.
Elasticsearch cannot establish ownership, current version or canonical content.
Keyword search should remain useful when model providers and Qdrant are disabled.

## Decision

Reuse PostgreSQL ownership/canonical extraction, the existing isolated parser,
version-bound jobs, outbox, RabbitMQ and worker. Add a search-specific extraction
entry point sharing computation/artifact publication, retaining old AI entry-point
eligibility checks. Do not create fake embedding profiles/AI runs for keyword work.

Use explicit versioned Elasticsearch metadata and canonical-page projections,
with immutable revision-specific remote identities. Add SQL desired-revision,
projection manifests and serving-generation publication; perform remote writes
outside SQL transactions, verify them, then compare-and-swap only the still-current
eligible projection under a valid lease. SQL reauthorizes every exact candidate
and source hash before public metadata/text/suggestions.

Metadata publishes before PDF text; image/scanned/empty-PDF limits are explicit.
Current active versions only; metadata-only no-version legacy records remain in
the catalog. Category/tag IDs are filters, not indexed names. Organization deletion
uses a durable bounded fanout checkpoint in the existing recovery process.

New search job vocabulary uses v3 identifiers-only envelopes with retained v1/v2
readers and coordinated API/outbox/worker rollout. Additive migration/check changes
must preserve old job/version/artifact constraints. Use an optional private
authenticated Elasticsearch deployment; no browser/proxy access, model service
or new scheduler. Backfill/rebuild/cleanup are bounded and resumable from SQL.

## Alternatives considered

- PostgreSQL full-text only: smaller operational cost, but substitutes for the
  roadmap's Elasticsearch direction and still needs highlight/prefix/ranking design.
- Couple lexical execution to AI runs: less initial worker change, but requires
  profiles/models for unrelated keyword functionality and couples outage domains.
- Reuse vector chunks as the only lexical corpus: preserves chunk IDs, but ties
  extraction availability to AI chunk enrollment and imposes model tokenizer concerns.
- Separate search worker/job stack: duplicates existing reliable transport and
  recovery responsibilities without a demonstrated scaling requirement.
- Mutable single remote document per version without a SQL revision fence: simpler
  writes, but late workers can overwrite newer metadata and restore stale visibility.

## Consequences and acceptance

Independent metadata/PDF search and shared canonical provenance preserve the
provider architecture. New SQL manifests, fanout state, search-specific parser
entry point and projection reconciliation add implementation/operational work.
Remote and SQL commits are not atomic; verified publication and repair are required.
Revision invalidation favors correctness over temporary search availability.

The [T02 implementation](../phase-5-data-foundation.md) establishes the four named
SQL entities, immutable generation/revision ownership, manifests and v3 contracts.
Real SQL migration/concurrency/recovery verification is recorded there; parser,
index-service and search execution are not implemented by T02.

Full feature acceptance requires T02–T06 and T10 migration, parser reuse, private-service,
publication/lease, lifecycle/fanout, owner isolation and rebuild tests in
[the Phase 5 plan](../phase-5-search.md). Old workers cannot consume new search
types safely; binary downgrade claims require explicit tests. No Elasticsearch
deployment or full keyword-feature acceptance is claimed by this ADR.

T04 implements the [private transport and initial mapping contract](../phase-5-elasticsearch.md).
The official client/image are pinned; literal scoped primitives, strict mappings,
standard lowercase analysis, derived reference exact values and metadata-only
prefix fields are internal foundations. Live mapping/deployment acceptance is
pending. SQL publication, search handlers and authorized APIs remain later tasks.

## T08 source-read implementation note

[Safe evidence and source reads](../phase-5-search-evidence.md) preserve current-only
search discovery while allowing retained exact historical canonical sources, as
specified by T01 and the existing chunk-source policy. Archive/deletion/access loss
still blocks reads. Generation retirement is not itself document access revocation.
Published SQL provenance remains required; knowing an artifact ID grants no access.
No schema/index mapping rewrite, public storage link or RAG behavior change is added.
