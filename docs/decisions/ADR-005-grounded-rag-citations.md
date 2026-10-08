# ADR-005: Qyvra-owned retrieval and citation provenance

Status: Accepted; retrieval/RAG/source navigation implemented in T09–T11
Date: 2026-10-04

Implementation confirmation: 2026-10-08, [T13 preparation](../phase-4-release-preparation.md)
using [T12 evidence](../phase-4-verification.md). The original decision and its
prompt-injection/semantic-truth limitations below remain unchanged.

## Context

RAG must answer from owned evidence without allowing uploaded text or a model to
choose authorization. Citations must identify actual retrieved sources, not merely
look plausible. Future assistants need stable interfaces before any agent runtime.

## Decision

Use independently configurable Qyvra embedding and generation interfaces with direct
native SDK/HTTP adapters. No LangChain/LangGraph or agent framework. The API resolves
authorization, retrieves through profile-compatible filters, validates candidates
against PostgreSQL, constructs bounded untrusted evidence blocks and makes one
bounded generation request. Recheck eligibility before dispatch and publication.

Require structured claims with supplied source tokens. Qyvra validates the token
allow-list and constructs citations from retrieved document/version/chunk records
and exact excerpt offsets/hash. Return a typed insufficient-evidence outcome for
missing evidence or model abstention; dependency failures remain safe errors.
Invalid/unreferenced model citations are rejected. Resolve citations through an
owned source route. Do not persist conversation history in Phase 4.
See the [canonical RAG and security contract](../phase-4-ai-rag.md).

## Alternatives considered

- Model-selected authorization/tools: cannot guarantee private-source isolation.
- Free-form model citations: cannot establish source provenance.
- Vendor/framework-owned retrieval: makes Qyvra's security/profile contract implicit.
- Agent workflows now: expand scope before retrieval quality and safety are verified.

## Consequences

### Positive

Provider-independent boundaries and traceable sources support incremental delivery
and later assistants without granting external actions or document mutation.

### Negative

Structured citation validation proves provenance rather than semantic truth.
Prompt separation cannot eliminate injection; adversarial grounding evaluation
remains required. Content already sent to a provider cannot be revoked by a later
archive/delete operation, and provider privacy/cost policies remain operational risks.
