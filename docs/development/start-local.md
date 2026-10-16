# Start the local stack with PowerShell

On Windows, **double-click `Start QYVRA.cmd` in the project root**. It runs
`-All -OpenBrowser`, starts the configured core/AI/search stack and opens QYVRA after
startup succeeds. A failure leaves its window open with the error message. Docker
Desktop and Ollama must be installed, and the root `.env`, pinned local model assets
and embedding profile must be prepared using [local AI setup](local-ai.md). This
is a launcher for a configured checkout, not an installer for Docker, drivers or
tokenizer assets. For the standard Windows-host endpoint, it starts Ollama when
needed and downloads missing models for the configured certified Nomic/Qwen pair.
It does not update installed models, change listener/firewall settings or manage
remote inference servers. Model downloads need internet access and disk space;
runtime still verifies the pinned digests and tokenizer compatibility.

The local `-All` flow starts Docker Desktop if it is stopped, generates missing
search passwords outside the repository when no search data volume exists, and
records their paths in `.env`. It reuses existing credentials. It migrates the
database, creates or resumes a compatible search generation, derives its fingerprint,
enrolls existing documents and starts workers. Keyword/Hybrid serving remains off
until the existing operator service verifies publication and performs SQL cutover.
It then writes the selected fingerprints and serving flags to `.env` and restarts
the affected services. An original `.env` backup is retained in ignored
`.tools/start-local/env-before-all.backup`; it contains secrets and must remain private.

Automatic search setup is restricted to `NODE_ENV=development` and trusted local
database credentials. The documented local PostgreSQL superuser may create the
`qyvra_search_operator` NOLOGIN marker role. The launcher never grants that role to
the application login. A nonsuperuser must already have DBA-provisioned operator
authorization. A serving generation with different configuration requires an explicit
operator upgrade. Indexing/cutover limits remain those of the existing maintenance
service, including its 1,000-document verification bound. No data volumes are deleted.

Run from the repository root (the script also resolves the root when invoked elsewhere):

```powershell
.\scripts\start-local.ps1 -All -OpenBrowser # One-command local startup + search setup
.\scripts\start-local.ps1                 # Core stack
.\scripts\start-local.ps1 -AI             # Core + local tokenizer mounts
.\scripts\start-local.ps1 -AI -Search     # Core + tokenizer mounts + Elasticsearch
.\scripts\start-local.ps1 -AI -Search -ValidateOnly
.\scripts\start-local.ps1 -AI -NoBuild    # Reuse existing application images
```

Requires PowerShell 5.1+ or PowerShell 7, Docker with Linux containers, and
Compose v2 supporting `up --wait --wait-timeout`. Create the root `.env` from
`.env.example` and replace placeholder database credentials first. Existing `.env`
and volume mappings are preserved. If your local execution policy blocks scripts,
use your organization's approved PowerShell execution policy; this script does not
change it. If permitted on your machine, a process-only invocation is:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -AI
```

This applies only to that PowerShell process. Native Linux Docker users running PowerShell can add `-AI -OllamaHost`
for the host-gateway mapping; Docker Desktop does not need that switch.

`-AI` selects `docker-compose.local-ai.yml`. Set `LOCAL_AI_ASSETS_DIR` to an
existing asset-only directory and configure mounted tokenizer paths in `.env`.
The script checks the directory and configured bundle files; QYVRA validates bundle
contents at runtime. Ollama installation/listener access, model downloads, database
embedding/serving profiles, calibrated thresholds, feature flags and old-document
backfill follow [local AI setup](local-ai.md). The switch alone does not enable AI.

For explicit `-Search` without `-All`, prepare two different private
16–128-character alphanumeric password files outside the repository, as described
in [Elasticsearch setup](../phase-5-elasticsearch.md#optional-local-deployment).
Set their absolute paths in `SEARCH_BOOTSTRAP_PASSWORD_FILE` and
`SEARCH_RUNTIME_PASSWORD_FILE`. The script validates their format without printing
their contents, starts Elasticsearch, waits for health, then runs the repeatable
`search-setup` credential provisioning service before starting the application.
It does not create secret files or change passwords. A mismatch with credentials
already stored in Elasticsearch must be resolved through the existing operator
procedure, not by deleting its volume.

For explicit `-Search`, Keyword/Hybrid search still requires the database generation, indexes, enrollment,
backfill, verified cutover and serving flags in [search operations](../phase-5-search-operations.md).
This mode does not provision generations or change feature flags. The `-All` flow
handles local generation provisioning and serving activation automatically, using
the same service. Elasticsearch startup alone does not mean queries are ready.

By default application images are built, and startup waits up to 360 seconds for
services. Use `-WaitTimeoutSeconds 600` for a slower machine. A failed command stops
the script with a nonzero exit code and leaves existing data and started services
available for troubleshooting. No cleanup or volume deletion runs on failure.
`-ValidateOnly` resolves Compose settings and checks local files without starting
containers or requiring a running Docker Engine. It does not check database state,
provider connectivity, model compatibility or search quality. Resolved credentials
are kept in process memory and are not printed by the script.

Use the same switches on subsequent starts so the optional mounts/services remain
selected. For manual logs or shutdown, use the matching Compose files. For example:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml -f docker-compose.search.yml logs --tail 100 api worker
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml -f docker-compose.search.yml down
```

Do not add `--volumes` to shutdown commands for an installation whose data you need.
The app uses your configured public address, defaulting to <http://localhost:8080>.

The wrapper's orchestration tests run without Docker or real credentials:

```powershell
node --test infrastructure/docker/start-local.test.cjs
```
