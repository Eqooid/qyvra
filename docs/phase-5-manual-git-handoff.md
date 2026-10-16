# Phase 5 T12 — Final verification and manual Git handoff

Date: **16 October 2026**. Decision: **NOT READY FOR MANUAL COMMIT AND PUSH**.
This is a release handoff decision. Required local acceptance remains incomplete;
the owner retains control of independent development and Git actions.

[T11 acceptance matrix](phase-5-verification.md) |
[v1.4.0 draft upgrade/release record](releases/v1.4.0.md) |
[Operator recovery](phase-5-search-operations.md)

## Candidate and T11 follow-up

The approved Phase 5 target is **v1.4.0**, from the roadmap/T01. Root `VERSION`
remains **1.3.1** because acceptance has not passed. Four private npm versions
remain `0.0.1`; HTTP `/api/v1`/OpenAPI `1` are separate compatibility identifiers.
This is intentional, not a mismatch to fix by prematurely bumping a version.

Branch: `v1.4.0`. HEAD: `d86395fafef3f53ebe3d182bd15936564cdb00ae`.
Remote: `origin`, `https://github.com/Eqooid/qyvra.git`. The candidate includes
uncommitted/untracked files; HEAD alone is not the candidate. No Git staging,
commit, push, tag, branch change, release, PR, deployment, production migration,
database reset, volume deletion or index deletion was performed by T12.

All **52** source/configuration hashes in the T11 checkpoint still match. No
runtime change was necessary or made. Valid T10/T11 tests/builds were reused
rather than repeating unchanged expensive suites.

| Previous finding                                                             | T12 status                                                                            | Release impact                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Real ES, broker/worker restart, Redis/Qdrant/provider and live authorization | BLOCKED: Docker engine still unavailable                                              | Mandatory local gates open                                                 |
| Live Nginx/browser source workflows                                          | BLOCKED: mocked Chromium is not full-stack proof                                      | Mandatory local gate open                                                  |
| A11 judged 30-query corpus and agreed/measured resource budget               | NOT VERIFIED: no new approved evidence                                                | Mandatory quality gate open                                                |
| Reviewed-candidate remote CI                                                 | NOT VERIFIED: no PR-triggered runs returned for base HEAD; dirty candidate not pushed | Pending owner action                                                       |
| Five moderate API dependency findings                                        | Unchanged T11 evidence; no dependency upgrade                                         | Apparent application reachability limited, not exploit-proof certification |
| Full frontend formatting failures in 47 existing files                       | Unchanged; scoped search format passed                                                | Existing low-severity debt; no unrelated mass formatting                   |
| Windows mocked-browser server teardown                                       | T11 needed exact test-server cleanup                                                  | Known low-severity limitation, not rerun                                   |

T11's NOT READY decision is retained. No Critical/High exploitable application
defect was newly established, but missing mandatory evidence is sufficient to
block release. Features retain the statuses in the T11 matrix. Canonical historical
text navigation is implemented; binary historical PDF viewing is not. Keyword is
model independent; hybrid uses existing compatible providers. No new feature work
or broad refactoring was introduced to obtain a passing handoff.

## Verification and changes during T12

| Actual check                                                                                                                                         | Outcome                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git branch --show-current`, `git status --short`, `git log -4 --oneline`, `git diff --stat`, targeted diffs and individual untracked-file inventory | Read-only review; branch/HEAD unchanged, nothing staged                                                                                                        |
| SHA-256 comparison with `.tools/phase5-t11-review-manifest.json`                                                                                     | PASS: 52/52 source/config files unchanged                                                                                                                      |
| Both workflow YAML files parsed with installed js-yaml; triggers, permissions and setup-node checked                                                 | PASS: Node 24, push/PR/manual triggers and read-only contents permission                                                                                       |
| Four manifest dependency maps compared with package-lock roots                                                                                       | PASS; versions `0.0.1`, no install/lock edits                                                                                                                  |
| Root `node --test infrastructure/test/search-compose.test.cjs`                                                                                       | PASS: 1 static private/authenticated topology test                                                                                                             |
| `docker --config .tools/docker-public info --format '{{.ServerVersion}}'`                                                                            | BLOCKED: missing `docker_engine` pipe; no image build or live test attempted                                                                                   |
| GitHub `fetch_commit_workflow_runs` for inspected HEAD                                                                                               | Empty PR-triggered list; wrapper does not enumerate all push runs; no remote pass                                                                              |
| New guide Prettier, current local Markdown file targets and `git diff --check`                                                                       | PASS; final counts below                                                                                                                                       |
| Targeted candidate scan                                                                                                                              | No credential signatures, sensitive filenames, TODO/FIXME/debugger markers or files over 1 MiB found; limited static scan, not exhaustive secret certification |

Reused, **not rerun by T12**: T11 fresh Next.js production build, frontend lint/
types and scoped format; 48 focused API unit passes/1 live Redis skip; five real
Chromium passes with mocked APIs; production audits meeting the high threshold
(five moderate API findings; zero in the other three projects). T10 retains API/
shared/worker builds, lint/types/format, 709 API unit passes/2 skips, 12 real-SQL
maintenance passes, 18 HTTP passes, fresh migrations and populated-upgrade checks.
T09 retains 237 frontend regression passes. Counts overlap and are not additive.
The full frontend format failure is not hidden by scoped checks. No source change
invalidates the preserved runtime evidence.

T12 changes only this guide, root README, documentation index, current roadmap and
current T01 introduction/status. It fixes stale wording that called implemented
workers or accepted ADRs unimplemented. No historical v1.0.0–v1.3.1 snapshot,
application source, dependency, migration, runtime configuration or VERSION changed.

**Remote CI verification is pending the repository owner's manual push.**
The workflows preserve document/RAG/processing tests, high-severity audits, private
test services and search/maintenance/browser coverage. YAML review is not a clean
Linux install, Docker image build or passing remote run.

## Working tree and exclusions

Final T12 inventory: **63 tracked status entries**, including **61 content diffs**,
**103 untracked files**, **zero staged files** and **164 candidate review paths**.
Current local documentation validation resolved **247 file targets across seven
guides** with none missing; fragment anchors were not automatically checked.
The guide's Prettier check and `git diff --check` passed.

Static Compose rendering also passed with synthetic configuration/secret-file
references using `docker --config .tools/docker-public compose -f docker-compose.yml -f docker-compose.search.yml config --quiet`.
This did not start containers, validate actual secret-file contents or close the
missing-engine/live acceptance gates.

At entry: **61 tracked files with content diffs**, **102 untracked individual
files**, **zero staged files**. Status additionally flags
`packages/database/src/ai.ts` and `ai-scheduling.ts` without content diffs; those
existing states were left intact. This guide adds one untracked file.

Changes span backend search/config/jobs, database/migrations, frontend search/auth/
sidebar integration, private deployment, CI, tests and docs. Existing AI pipeline
and test edits preserve shared extraction/search-vocabulary compatibility; their
filenames alone do not make them unrelated. The owner must inspect all diffs and
exclude any unrelated work, rather than approve whole folders.

Keep ignored `.tools/`, installed dependencies, builds, browser/test reports,
actual `.env`/`.env.local`, runtime secret files, model/storage assets, database
directories and Docker volumes out of Git. `.env.example` is an intended
configuration reference. CI disposable passwords are not production credentials.
Do not print actual secret files or automatically remove suspicious/unrelated files.

Ignored local review aids:

- `.tools/phase5-t12-inventory.json`: content/status counts and targeted scan.
- `.tools/phase5-t12-review-paths.txt`: candidate inventory, **not an approved
  staging list**; excludes status-only/no-content entries.
- `.tools/phase5-t11-review-manifest.json`: runtime evidence checkpoint.

Regenerate the inventory if files change. T12 does not approve staging any owner's
unrelated changes. Manual commands below must not be run blindly against an old list.

## Manual commands — owner only, after local blockers are closed

Recent history includes `chore(release): prepare Qyvra v1.3.1`; a compatible
candidate subject is `feat(search): add Phase 5 search and recovery candidate`.
Do not claim release completion while gates remain open. Codex has not executed
the following commands that write Git state.

From the repository root in PowerShell:

```powershell
# Review branch, destination, all content and every untracked file first.
git branch --show-current
git remote -v
git status --short
git diff --stat
git diff --check
git diff
git ls-files --others --exclude-standard

# Only after mandatory LOCAL gates pass and YOU choose to proceed:
# Manually edit the copied list; keep only explicitly reviewed Phase 5 paths.
# Read every untracked file: ordinary git diff does not show its contents.
Copy-Item -LiteralPath .tools/phase5-t12-review-paths.txt -Destination .tools/phase5-approved-paths.txt
notepad .tools/phase5-approved-paths.txt
Get-Content .tools/phase5-approved-paths.txt

# Owner-only staging; never git add .
git --literal-pathspecs add --pathspec-from-file=.tools/phase5-approved-paths.txt
git diff --cached --stat
git diff --cached --check
git diff --cached

# Stop for unrelated files, secrets, generated artifacts or unresolved failures.
git commit -m "feat(search): add Phase 5 search and recovery candidate"
git log -1 --oneline
git status --short

# Reconfirm origin and v1.4.0 are still the intended destination.
git push origin HEAD:refs/heads/v1.4.0
```

If the owner has staged work since this review, inspect it separately before
committing. An owner may independently choose an interim review-only push to
obtain CI; that remains NOT READY for release and is not release/tag approval.
No tag, GitHub release or deployment command is part of this handoff.

## Post-push checklist

1. Copy the SHA from `git log -1 --oneline`. Confirm GitHub's `v1.4.0` branch and
   all inspected workflow runs refer to that exact commit, not an earlier badge.
2. Verify **Phase 4 verification** / `contracts-and-recovery`, and **Phase 5 private
   search verification** / `private-search`, `search-browser`. Inspect migration/
   CLI/SQL, audits, builds/lint/types, existing document/RAG regressions and real
   private-runtime steps. A skipped required step is not a pass.
3. Read failing step logs; fix only the defect, rerun affected checks, and manually
   commit/push the correction. Do not disable security gates to obtain green CI.
4. Separately record live broker/worker recovery, real Redis/ES/Qdrant/provider
   behavior, Nginx browser scenarios and judged quality/resource measurements where
   CI does not cover them. Mocked-browser green is not live Nginx certification.
5. Reassess all A01–A11 gates, then separately review any VERSION/release-preparation
   commit. Only afterward consider an owner-authorized tag/GitHub release. Neither
   remote green nor this handoff alone authorizes publishing or deployment.

## Continuation checkpoint

First restore Docker. Use isolated migrated test resources and run
`node infrastructure/test/search-runtime.cjs` with disposable `TEST_DATABASE_URL`.
Complete separate broker/worker interruption/restart/race, hybrid/provider/Redis
and live Nginx browser gates. Finish the approved 30-query quality/resource
protocol. Reuse unchanged T10/T11 evidence; preserve original files, volumes and
active indexes. No automatic model download or historical reprocessing is needed
merely to inspect readiness.

The available handoff review is recorded, but mandatory local release checks remain
unresolved: **NOT READY FOR MANUAL COMMIT AND PUSH**. Staging, commits, pushes, tags,
PR/release creation and deployments remain entirely owner-controlled.

## 16 October continuation checkpoint update

Use the [live continuation ledger](phase-5-live-verification.md) before resuming.
The isolated runtime harness has now passed 45 selected tests, including real ES
checks and restart persistence. Do not repeat it. Adapter/configuration/Compose
fixes mean the earlier T11 source hash checkpoint is historical, not proof that
the current runtime is unchanged. Docker subsequently stopped; the next gate is
the isolated Nginx/browser runner using existing images. Hybrid remains blocked
by owner direction; gold labels and budgets remain unapproved. Current decision:
**NOT READY FOR MANUAL COMMIT AND PUSH**; remote CI remains pending owner's manual
push. Preserve all Git write restrictions and review new files before any staging.

## Browser continuation result

The [live continuation ledger](phase-5-live-verification.md) now records a passed
real Nginx/Chromium PDF-to-search/source/isolation/archive workflow (1 test,
15.5 seconds). Earlier Docker-blocked/unexecuted descriptions are historical
for that scenario. Hybrid and full quality/resource acceptance remain open.

## Final live continuation checkpoint

The [current ledger](phase-5-live-verification.md) records real browser, broker/
worker/Elasticsearch outage recovery, stale-index lifecycle exclusion, corrected
30-query keyword measurements and two-worker duplicate delivery. All test volumes
were preserved. The configured provider is reachable again with the existing
certified model; live hybrid remains unrun under the previous explicit instruction.
Human gold judgments, resource/load qualification, remaining interruption scenarios
and final-candidate remote CI remain open. NOT READY remains the handoff decision.
No further implementation prompt is needed to resume these named acceptance gates.
