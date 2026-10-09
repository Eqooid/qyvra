# Phase 4 T13 — v1.3.0 release preparation

Prepared **8 October 2026**. **READY WITH KNOWN NON-BLOCKING LIMITATIONS** under
[T12 acceptance](phase-4-verification.md). T13 finalizes the reviewable candidate;
it does not publish or tag it. [Release notes/snapshot](releases/v1.3.0.md) and
[changelog](../CHANGELOG.md) distinguish implemented scope from future work.

**Correction, 9 October 2026:** the initial T13 completion claim was premature:
the versioned v1.3.0 developer guide was missing and its index still identified
v1.2.0 as current. The initial inspection/evidence below records 8 October state;
the [correction report](#t13-correction--9-october-2026) supersedes its completion
claim and records the current repository and focused verification.

## Repository and completion assessment

Inspected branch: **v1.3.0**, at baseline `039dc5e` plus the existing T01–T12 working
tree and T13 documentation. Local branches include main/v1.0.0/v1.1.0/v1.2.0/v1.3.0;
the only local release tag is **v1.1.0**. The Phase 1 designation and Phase 3 candidate
remain historical records; no v1.2.0 or v1.3.0 tag/publication is inferred. There are
many pre-existing modified/untracked Phase 4 files and user changes; no staged changes
at inspection and no Git mutation by T13. There is no immutable release commit yet.

| Capability                                             | Task   | Classification                                  | Evidence and qualification                                                       |
| ------------------------------------------------------ | ------ | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Architecture/ADRs                                      | T01    | Implemented and verified documentation          | Contracts and implementation guides; no T01 runtime claim                        |
| Persistent data                                        | T02    | Implemented and verified                        | Migrations, owned artifact constraints and SQL upgrade                           |
| Durable stages                                         | T03    | Implemented and verified                        | Existing jobs/outbox, dependencies, retry/lease recovery                         |
| PDF extraction                                         | T04    | Implemented and verified                        | Bounded isolated parser, canonical text, real fixtures                           |
| Chunks/provenance                                      | T05    | Implemented and verified                        | Determinism, complete sets, stable IDs, Unicode/page lineage                     |
| Embeddings                                             | T06    | Implemented and verified within tested adapters | Exact profiles/checkpoints and native HTTP fixtures; live models unverified      |
| Qdrant indexing                                        | T07    | Implemented and verified                        | Real upserts, verified activation, replacement, cleanup/rebuild                  |
| Ingestion/reprocess/restore/backfill                   | T08    | Implemented and verified                        | Atomic enrollment, bounded/idempotent artifact reuse                             |
| Semantic retrieval                                     | T09    | Implemented and verified within tested adapters | SQL authorization and compatible native query embeddings                         |
| RAG/citations                                          | T10    | Implemented and verified within tested adapters | Abstention, bounded context, server validation; model quality not fully verified |
| Frontend/source navigation                             | T11    | Implemented and verified                        | Owned exact sources, safe rendering, browser keyboard/themes/layout              |
| Security/recovery acceptance                           | T12    | Implemented and verified local scope            | READY WITH KNOWN NON-BLOCKING LIMITATIONS; remote CI not executed                |
| Release preparation                                    | T13    | Implemented and verified documentation          | Final validation ledger below; no publishing                                     |
| OCR/new formats/chat/agents/hybrid/local orchestration | Future | Planned or excluded                             | No implementation or Phase 5 commitment                                          |

No partially implemented or blocked capability is concealed as delivered. Separate
tenants are not implemented; ownership is the internal authenticated user ID.

## Version and Git policy

The existing [policy](development/conventions.md#versioning) uses product Git tags,
not synchronized npm package versions. Preserve `0.0.1` in the four private manifests
and lock roots, OpenAPI `1`, `/api/v1`, dependency versions, schema/message/profile
identities and local Compose image naming. This is intentional consistency, not a
missed version bump. No root package manifest or release image/publishing script exists.
Version-oriented branches already exist; use the current branch without creating
another. No image is pushed, no remote CI invocation or registry publication performed.

The candidate needs a reviewed commit containing the complete Phase 4 implementation,
tests, fixtures and T13 docs, not a docs-only tag on baseline `039dc5e`. Review unrelated
storage/user changes separately before staging. Suggested commands below are **not
executed**, and publishing commands require the user's approval:

```sh
git switch v1.3.0
git status --short
git diff --check
git ls-files --others --exclude-standard
git add -p
git add -- docs/releases/v1.3.0.md docs/phase-4-release-preparation.md
# Stage other reviewed new Phase 4 files explicitly; do not blindly git add .
git diff --cached --check
git diff --cached --stat
git commit -m "Finalize Qyvra v1.3.0 AI/RAG foundation"
# Only with approval: push the reviewed branch, then wait for its CI result.
git push origin HEAD:refs/heads/v1.3.0
# After passing CI and approval, on the exact reviewed clean commit:
git tag -a v1.3.0 -m "Qyvra v1.3.0 AI/RAG foundation"
git push origin refs/tags/v1.3.0
```

Confirm the intended remote and commit before these commands. GitHub Release
publication, image distribution and production deployment are separate decisions;
none is implied by this preparation. Move the candidate changelog heading to an
actual publication date only when published; retain recorded verification limits.

## Evidence reused and targeted validation

T12's ledger supplies all runtime counts/results. It records real infrastructure,
deterministic provider fixtures, failed attempts subsequently resolved and remaining
unverified checks. T13 does not repeat expensive recovery/browser/migration tests or
claim new runtime validation. No executable code, package/lock dependency, schema,
container image metadata or API version changed, so runtime build/type reruns are
not required for documentation-only finalization.

| T13 check                                                | Result                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Markdown formatting, local links/anchors, fenced blocks  | Passed targeted formatting; local links/anchors and fenced blocks validated                                       |
| Four manifest/lock identities and preserved hashes       | Passed: four pairs remain private 0.0.1; package/lock bytes unchanged                                             |
| Current product/package/API/image version references     | Passed: candidate 1.3.0, independent API 1 /api/v1; local image naming retained                                   |
| Source-backed API route/request and data model review    | Completed inspection; summarized in canonical guides                                                              |
| Environment example/config-key consistency               | Passed: 47 unique active keys referenced in existing source/configuration; only comments edited                   |
| Documented Compose quiet validation                      | Passed: docker compose --env-file .env.example config --quiet, exit 0                                             |
| Historical files and unrelated working-tree preservation | Passed: 548 of 565 checkpoint files byte-identical; remaining 17 are intended docs/comments; two new release docs |
| T12 remote CI/live-model/load/old-volume upgrade         | Not executed; limitations retained                                                                                |
| T12 full web formatting                                  | Failed: 25 unchanged baseline files; not silently fixed or claimed passed                                         |

Known non-blocking issues are retained verbatim in the T12 record and summarized
in the release snapshot: moderate API and development tooling advisories, baseline
style warnings, provider/model privacy/calibration/quotas and unexecuted optional
quality/production checks. No unresolved release-critical leak, citation, processing,
migration or startup blocker is recorded. Remote CI must run on the final reviewed
commit before tagging; T13 cannot attest to a remote job that has not run.

## T13 completion report

1. Repository: existing v1.3.0 branch, dirty T01–T12 checkpoint preserved; no staged or Git changes made by T13.
2. T12 readiness: READY WITH KNOWN NON-BLOCKING LIMITATIONS; local evidence, no live-model/remote-CI claim.
3. Created: `docs/releases/v1.3.0.md`, `docs/phase-4-release-preparation.md`.
4. Modified: README, changelog, documentation index, architecture/API/database/roadmap, AI contract, processing, deployment/environment guides, versioning conventions and environment-example comments; exact final inventory below.
5. Documentation: current Phase 4 scope/classification, candidate notes and preserved verification evidence finalized.
6. Architecture: existing runtime diagram retained; worker/API, authorization and provider/index authority accurately described.
7. AI/RAG: implemented scope links separated from original T01 planned contracts and future provider/agent features.
8. API: five implemented processing/reprocess/search/RAG/source entry points mapped to source controllers and canonical detailed contracts.
9. Database: actual artifact/checkpoint/manifest/ready-pointer relationships and migration count; no schema change.
10. Processing: existing jobs/outbox/leases, checkpoint resumption, activation and cleanup linked to tested recovery procedures.
11. Deployment: retained-volume start/migration/health/backfill/recovery commands and private Qdrant/provider boundaries.
12. README: concise current candidate/features/limitations with existing quick-start/development entry points preserved.
13. Roadmap: Phase 4 implementation/verification/preparation complete; release publication remains separate; Phase 5 not started.
14. Index: ordered Phase 4 guides and candidate/release links; duplicate progress navigation removed.
15. Version metadata: product v1.3.0 in current docs; private package 0.0.1, API 1 and /api/v1 preserved by policy.
16. Packages/locks: no changes by T13; consistency/preservation checks below.
17. Docker: no release registry tags or OCI version labels exist; local naming unchanged, no images built or pushed by T13.
18. Changelog: v1.3.0 candidate Added/Changed/Fixed/Security/Reliability/Limitations; prior Phase 3 candidate and released entries preserved.
19. Release notes: `docs/releases/v1.3.0.md`, explicitly prepared/unpublished.
20. Limitations: PDF-only/no OCR, standalone Q&A, no agents/tools/chat/hybrid, model errors still possible and provider-specific compatibility.
21. Historical preservation: v1.0.0/v1.1.0 snapshots, Phase 3 acceptance/verification and v1.2.0 developer record unchanged.
22. Documentation validation: final execution results below; no fabricated passes.
23. Version consistency: policy-aware checks distinguish product/package/API/schema/dependency versions.
24. Build/type: not rerun; no executable metadata/code changed, T12 results reused.
25. Reused T12: 419 API unit, 237 integration, 281 HTTP, 214 web and 11 browser cases; aggregate saved evidence, not T13 reruns.
26. Release blockers: none recorded within supported tested scope; no production-readiness guarantee beyond T12.
27. Non-blocking issues: T12 audits/style/quality/capacity/remote-CI qualifications remain explicit.
28. Working tree: existing modified/untracked implementation plus two new release docs; review and commit still required.
29. Git steps: commands above recommended only; no branch/commit/tag/push/merge performed.
30. Final readiness: READY WITH KNOWN NON-BLOCKING LIMITATIONS; targeted documentation checks pass.
31. Original T13 completion claim was premature: the missing versioned developer guide is addressed in the correction below, with no publication.
32. Release approval: candidate prepared for user review; exact commit, remote CI, tag/publication and deployment remain user-approved steps.

## Final T13 file inventory

Created:

- `docs/releases/v1.3.0.md`
- `docs/phase-4-release-preparation.md`

Modified:

- `README.md`, `CHANGELOG.md`, `.env.example` (comments only).
- `docs/README.md`, `docs/architecture.md`, `docs/api.md`, `docs/database.md`, `docs/roadmap.md`.
- `docs/phase-4-ai-rag.md`, `docs/phase-4-processing.md`, `docs/compose.md`.
- `docs/deployment/environment-variables.md`, `docs/development/conventions.md`.
- `docs/decisions/README.md`, `docs/decisions/ADR-003-ai-processing-artifacts.md`,
  `docs/decisions/ADR-004-profile-isolated-vector-index.md`,
  `docs/decisions/ADR-005-grounded-rag-citations.md`.

ADR status confirmations record delivered implementation without changing original
decision dates or tradeoffs. No new ADR, migration, dependency, runtime code,
package/lock version or image metadata is introduced by T13.

## Final validation and disposition

Targeted validation on 8 October 2026:

- Installed API Prettier: `node apps/api/node_modules/prettier/bin/prettier.cjs --write`
  and `--check` on the 18 changed/new Markdown documents, passed. This does not
  claim that the previously failing full web formatting check passed.
- Checkpoint/local documentation review: 370 local paths and 54 Markdown anchors
  checked in the final documents. No missing target, broken anchor or unclosed fence. Four manifest/lock
  identities, 47 configuration names and existing OpenAPI/HTTP versions pass.
- SHA-256 checkpoint review: 548 existing files unchanged; 17 intentional documentation/
  environment-comment edits and two new release documents. Historical snapshots,
  T12 evidence, runtime source, migrations, manifests/locks and unrelated user changes
  are preserved. No staged changes, branch switch, new commit or release tag.
- `docker compose --env-file .env.example config --quiet`: exit 0. Configuration
  validation only; no startup, image rebuild, service restart or deployment performed.
- `git diff --check`: exit 0. Git's LF-to-CRLF notices are informational; no whitespace
  error. Existing T01–T12 modified/untracked files remain for review.

Runtime builds, tests, native/container extraction, migrations, browser and recovery
simulations were **not rerun**: T13 changes only documentation/comments, so T12's
saved evidence is reused. No live provider call, remote CI run or production load test
is claimed. No release-critical blocker is recorded in the supported verified scope;
the explicitly documented T12 limitations remain.

**Initial T13 completion claim was incomplete and is superseded by the correction
below.** T12's classification remains READY WITH KNOWN NON-BLOCKING LIMITATIONS.
The v1.3.0 candidate is prepared for user review and approval of the
reviewed release commit and publication process. Run remote CI on that exact commit
before tagging/publishing. The candidate is not yet an immutable, tagged or published
release. Phase 5 has not begun.

## T13 correction — 9 October 2026

The previous run omitted `docs/developer/versions/v1.3.0.md` and failed to update
the developer index's current-version introduction. Root README already said
v1.3.0, but its developer-reading description named only older versions. Declaring
all T13 deliverables complete was incorrect. This correction follows the existing
`docs/developer/versions/v1.1.0.md` and `v1.2.0.md` delta-guide convention, preserving
the 16 historical baseline chapters and previous version guides.

Current inspection: clean `main` at `4e6bc02` (`Initial V3`) before the correction;
the maintainer has committed the previously inspected Phase 4 tree. Only local
tag `v1.1.0` exists. The original branch/dirty-tree record above is historical,
not current Git state. No Git mutation or publication is performed by this task;
use the maintainer's intended current branch for review rather than treating the
original `git switch v1.3.0` suggestion as an action already performed or required.

### Correction completion report

1. **Cause:** versioned development guide missing; stale developer index and README reading-map description; original completion claim corrected explicitly.
2. **Structure:** preserved v1.0.0 baseline chapters plus versioned delta guides in `docs/developer/versions/`.
3. **Created:** `docs/developer/versions/v1.3.0.md`, substantive source-linked architecture/data/processing/API/frontend/security/operations/verification walkthrough.
4. **Updated:** root README, `docs/README.md`, `docs/developer/README.md`, `docs/roadmap.md`, `docs/specification.md`, `docs/deployment/environment-variables.md`, `CHANGELOG.md`, `docs/releases/v1.3.0.md` and this preparation record.
5. **README:** explicit `QYVRA v1.3.0` heading, current developer guide in development and documentation navigation; existing setup/features retained.
6. **Version metadata:** current product/developer designation v1.3.0; four private packages remain independently `0.0.1`, HTTP `/api/v1`, OpenAPI `1`. No root/worker manifest, app release constant, registry release tag or release script exists to bump.
7. **Lockfiles:** unchanged; four manifest/root-lock identities checked together. No dependency or package version changed.
8. **Roadmap:** explicit T01–T13 implementation/documentation and verification table; ready candidate distinguished from released; no Phase 5 begun.
9. **Index:** direct v1.3.0 development links and preserved access to v1.0.0/v1.1.0/v1.2.0 history.
10. **Changelog/release notes:** existing accurate v1.3.0 candidate retained, with developer guide/correction links; preparation date remains 8 October, not a publication date.
11. **History:** older release snapshots, developer version deltas/baseline chapters and Phase 3/T12 evidence unchanged. Developer-index historical baseline body preserved.
12. **Links:** targeted final validation recorded below; paths, anchors, code fences and source entry points checked.
13. **Version references:** stale current developer-index v1.2.0 label corrected. Remaining product v1.2.0 mentions identify historical Phase 3 sections, comparison records, old guides or links. Numeric package-lock/dependency versions are independent and are not globally replaced.
14. **Checks:** targeted formatting, links/anchors, manifest/lock identity, source-backed settings/routes, Git whitespace and scope/history preservation; no application test/build required for documentation-only changes.
15. **T12:** READY WITH KNOWN NON-BLOCKING LIMITATIONS; saved 419 API unit / 237 integration / 281 HTTP / 214 web / 11 browser evidence reused, not rerun.
16. **Blockers:** no unresolved release-critical blocker recorded in T12's supported tested scope. Remote CI, live-model quality, production capacity, moderate/development advisories and baseline formatting limitations remain explicit.
17. **Missing deliverables:** all now exist and pass focused validation below; no capability or evidence is fabricated.
18. **Final T13 status:** complete after this correction; tagging/publishing/deployment require maintainer approval and CI on the reviewed commit.

### Focused validation results

- Local path/anchor/fence review: **294 local links, 42 anchors, no findings** across
  the nine modified Markdown files and new developer guide. Linked source files
  exist; APIs, configuration names, model lineage and scripts were inspected against
  the implementation. The guide has substantive walkthroughs in every requested area.
- Formatting: installed API Prettier `--write` and final `--check` on nine current/new
  documents passed. The updated developer-index introduction was formatted separately.
  Its historical baseline body remains unchanged; a full-index formatting check still
  has the pre-existing baseline style issue, confirmed on HEAD before the correction.
  The initial all-ten check failed and is not reported as a pass.
- Manifest/lock verification: four private `0.0.1` pairs agree; OpenAPI `1` and HTTP
  `/api/v1` preserved. No manifest, lock, dependency, executable constant or Docker
  configuration changed. No release-versioned image or release script was found.
- Version search: `rg -n 'v1\.2\.0' README.md docs -g '*.md'` and a repository-wide
  search excluding ignored build/dependency output were reviewed. The stale current
  developer-index label and specification wording were corrected. Remaining product
  references are historical Phase 3 documentation/comparisons/navigation; numeric
  dependency occurrences in lockfiles are independent, not application release labels.
- Scope and history: `git diff --name-only`, untracked-file review and baseline-body
  comparison show nine intended Markdown edits and one new guide only. Older release
  snapshots, v1.1.0/v1.2.0 developer deltas, the 16 baseline chapters, T12 results and
  all application/configuration/lock files remain unchanged. Credential-pattern
  review found no secret in the documentation additions. No staged change, commit,
  branch switch, tag, push, publication or deployment occurred.
- `git diff --check`: passed. Runtime builds/type checks, Compose startup and T12
  suites were not rerun because only documentation changed. No provider call,
  reprocessing, vector rebuild or destructive recovery test was performed.

**The previously missing T13 deliverables now exist. T13 is complete after the
9 October correction.** Final classification remains **READY WITH KNOWN
NON-BLOCKING LIMITATIONS** under T12's recorded evidence, with no claim of remote
CI, live-model quality or production validation. The candidate is ready for review;
CI on the approved commit, tagging and publication remain separate authorized steps.
