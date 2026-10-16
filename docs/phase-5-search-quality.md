# Phase 5 — Proposed relevance corpus and resource protocol

Prepared **16 October 2026** to close A11. Status: **PROPOSED / NOT VERIFIED**.
This is test preparation, not approval of relevance judgments or performance.

[Approved A11 protocol](phase-5-search.md#acceptance-criteria-and-testing-strategy) |
[Acceptance matrix](phase-5-verification.md)

## Fixture and approval

The [synthetic corpus](../infrastructure/test/fixtures/search-quality-proposal.json)
contains 12 owner-a documents, two owner-b security documents and 30 queries.
There is no real customer content or credential. Logical identities/category/tag
aliases must be resolved to actual test UUIDs by the isolated fixture loader;
they are not valid request-provided ownership identities or filter UUIDs.

Labels are Codex proposals on a 0–3 relevance scale, **not human-approved gold**.
The dataset explicitly retains `PROPOSED_NOT_OWNER_APPROVED`, `NOT_EXECUTED` and
null performance budgets. Owner review must confirm relevant documents/grades,
ambiguity/no-match expectations, and applicable acceptance thresholds before the
dataset is frozen and used for a release decision. No label/budget approval is
inferred from asking Codex to prepare fixtures.

Q01–Q04/Q29 cover exact references/punctuation; Q05/Q06/Q09 phrase and second-page
sources; Q07/Q08 title/body; Q10–Q12 Thai/accents; Q13–Q17 paraphrases; Q18–Q21
filters; Q22–Q25 no-match/ambiguity; Q26–Q28 cross-owner exclusion; Q30 document
collapse across multiple pages. Scanned PDFs/OCR are not required. Rendering must
preserve a verified machine-readable Unicode text layer; an ASCII-only PDF fixture
must not be substituted for the Unicode cases.

## Isolated execution and metrics

1. Review labels and agree p95 keyword/hybrid/suggestion latency, memory ceiling,
   hardware and acceptable hybrid non-regression. Record owner approval separately.
2. Record the corpus hash, dirty-tree/commit identity and actual fixture UUID map.
   Load only into a new isolated test corpus, never an existing owner's documents.
3. Verify immutable versions, lexical publication and existing compatible semantic
   ingestion. Pin index generation, provider/model digest/profile/dimensions,
   candidate/page/window limits and match/filter semantics. Do not download models
   or re-embed an existing corpus automatically.
4. Run all 30 queries as owner-a through authenticated keyword, existing semantic
   and hybrid APIs. Resolve filter aliases securely. Record returned document IDs,
   rank, actual mode, source provenance, coverage and controlled errors; never
   relabel a failed/degraded run as a complete hybrid result.
5. Compute per-query/aggregate Recall@10, reciprocal rank and nDCG@10 from approved
   labels. Report queries/denominators explicitly. Queries with no relevant labels
   have undefined relevance denominators and belong in a separate no-match/isolation
   report; do not give them artificial perfect recall. Define the nonzero relevance
   threshold and graded gain formula with the approved metric protocol.
6. Apply the existing mandatory exact-reference rank-one and designated phrase
   top-five checks. Foreign result/snippet/suggestion/count leakage must be zero.
   Semantic similarity may return unrelated documents on no-match queries; score
   these honestly against approved expectations rather than assuming keyword
   no-match behavior proves semantic precision.
7. Measure cold/warm repeated requests and actual resident/container resources,
   including dense long-PDF matches, finite-window exhaustion and suggestion load.
   The small proposed relevance corpus alone does not prove these load scenarios.
   Record repetitions, concurrency, error rates, percentiles and hardware limits.
8. Compare modes before any tuning. Publish actual values and missed targets.
   Do not change ranking weights, widen bounds or select a new embedding model
   merely to improve a benchmark during acceptance.

No live query output or performance measurement has been produced for this corpus.
The existing deterministic ranking tests prove algorithm behavior, not real engine
relevance or a measured deployment budget. A11 remains **NOT VERIFIED** until the
approved labels/budgets and real results are recorded.

## First live execution and fixture correction

A 30-query keyword pass ran against real services. Long unwrapped lines in the
PDF fixture renderer clipped some logical source text; initial scores are
exploratory and cannot establish acceptance. The correction wraps words within
the page and checks normalized extracted text against all logical source pages
before rescoring. New immutable versions are created only for affected synthetic
fixtures. Rate-limit backoff remains enabled; no search quota was weakened.
See [the live ledger](phase-5-live-verification.md) for final measured scope.
Agent-selected reference limits after delegated execution are 1500 ms keyword
and 1000 ms suggestions p95; these are not a production SLO or human gold labels.
Hybrid comparison remains unexecuted under the owner instruction.

The corrected live run verifies normalized extraction against all 14 logical
documents. The prior phrase miss was caused by clipped fixture layout, corrected
with new immutable test versions. The Thai Q10 query remains unmatched even though
the expected term is present in canonical extraction. This is an observed coverage
limitation, not evidence of a successful Unicode acceptance gate. No analyzer or
label was changed to hide it. Final metrics are recorded in the live ledger.

The [corrected measured keyword results](phase-5-keyword-quality-results.json)
record all 30 rankings, 60 requests, extraction-fidelity checks and limitations.
Warm p95 is 156.949 ms; all designated exact-reference and phrase checks passed.
The Thai miss and unexecuted hybrid comparison remain explicit; A11 is incomplete.
