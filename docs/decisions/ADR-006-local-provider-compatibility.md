# ADR-006: Native local-provider adapters behind existing AI interfaces

Status: **Accepted** — embedding and generation portions implemented in v1.3.1 T02/T03;
installed-model certification remains unverified.
Date: 2026-10-11

## Context

The [v1.3.1 audit](../developer/versions/v1.3.1.md) records the actual v1.3.0 HTTP
adapters, independently configured generation/embedding boundaries, OpenAI tokenizer
assumptions and current server-side citation/checkpoint invariants. Ollama compatible
URLs alone do not establish correct local input budgeting or model preprocessing.
Live model compatibility is NOT VERIFIED.

[T02 runtime and verification](../local-embeddings.md) implements the embedding
decision with a pinned lightweight tokenizer, complete-batch gates and catalog
digest checks. [T03 native generation](../local-generation.md) adds independently
selected schema-constrained chat, pinned two-message framing and runtime token/digest
checks. Neither task certifies installed models. T03 supports restricted
operator-certified framing rather than arbitrary executable Go/Jinja templates.

## Proposed decision

Retain the current openai-compatible adapters. Add small native Ollama embed/chat
HTTP adapters behind the same Qyvra-owned interfaces, with shared result validation.
Embedding dispatch uses the authoritative profile's provider; generation uses its
independent provider setting. Do not introduce a combined provider selector,
new processing system, SDK framework or second authorization model.

Native embedding requests must explicitly reject truncation, respect pinned local
input preprocessing/tokenizer identity and validate complete batches/dimensions
before checkpointing. Hash exactly the bytes embedded. Native generation requests
must be non-streaming, use the existing schema, bound context/output and thinking,
and normalize only complete valid content. Preserve server-owned citations.

Local tokenizer assets/templates must be pinned and installed by trusted operators,
not fetched on requests. Select a lightweight implementation in T02/T03 after parity
tests; unknown combinations fail closed. New provider/model/revision/preprocessing
identity requires a new profile and compatible index, not vector reinterpretation.

## Alternatives considered

1. Compatible HTTP only: simplest transport reuse, but lacks explicit native
   controls and still requires local budgeting/template changes and certification.
2. Replace compatible adapters: loses supported cloud deployments; rejected.
3. Both behind existing interfaces: modest protocol/factory tests, clearer controls
   and preservation of existing architecture; recommended.

## Consequences and acceptance

Two small adapters and provider factories add maintenance, but preserve jobs,
checkpoint recovery, derived indexes, SQL ownership and frontend/API contracts.
No database migration is expected solely to represent a provider string. Do not
rewrite historical migrations or weaken validation to accommodate a model.

Acceptance requires deterministic HTTP and local-tokenizer tests, all four
cloud/local combinations, no partial successful checkpoint/index, malformed/unknown
citations rejected, correct model-profile cutover and rebuild without re-embedding.
Optional installed-Ollama smoke tests record exact server/model/digest and resource
evidence; CI must not download models or require paid calls.

Deployment remains trusted server-to-server HTTP with operator-selected endpoints,
private networking and remote TLS/authentication where appropriate. Hardware/GPU
management is external to Qyvra. This proposal does not certify a model, expose an
Ollama route to the browser or declare v1.3.1 released.
