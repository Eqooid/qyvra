# 14 · Development workflow and debugging

[Guide index](README.md) · [Configuration](11-configuration.md) · [Testing](13-testing.md)

Choose full Compose for the quickest complete application, or host source watchers for editing. Both use the same API/database/storage rules.

## Prerequisites and checkout

- Git.
- Docker with Linux containers and Compose v2 for the supplied database/full stack/browser tests.
- Node.js **24+** and npm for host development and test tools. There is no active pnpm workspace.
- PostgreSQL 17 (Compose provides it).
- qpdf on PATH for host PDF inspection; the API Docker image includes it.
- Registry access for `npm ci`; existing Next Google font builds may need network access.

The inspected remote is `https://github.com/Eqooid/brainless.git`. For the exact baseline documented here:

```sh
git clone --branch v1.0.0 https://github.com/Eqooid/brainless.git
cd brainless
git rev-parse HEAD
```

Expected inspected commit: `f208e8fa188b0942c16f5c356a7b17bbedc948ba`. `v1.0.0` is a branch in this checkout, not a verified local release tag; if it has moved, review before using this guide as an exact baseline. Create a feature branch from the intended commit for changes. Do not reset an existing dirty checkout.

## Option A: full Compose

On a fresh checkout, preserve any existing `.env`:

```powershell
Copy-Item .env.example .env
```

POSIX equivalent: `cp .env.example .env`. Edit POSTGRES_PASSWORD and keep POSTGRES_USER/POSTGRES_DB/project name stable if volumes already exist.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps --all
```

Open http://localhost:8080, register, then log in. Migrations run automatically. Check http://localhost:8080/api/v1/health/ready and [Swagger](http://localhost:8080/api/v1/docs/). Stop with `docker compose down`; keep volumes. Rebuild after source changes. More commands: [Docker guide](12-docker-nginx.md).

## Option B: host source watchers

### 1. Install the independent packages

From repository root:

```sh
npm --prefix packages/storage ci
npm --prefix packages/database ci
npm --prefix packages/storage run build
npm --prefix packages/database run build
npm --prefix apps/api ci
npm --prefix apps/web ci
```

Use `npm.cmd` when PowerShell execution policy blocks `npm.ps1`. Keep all four lockfiles; API `file:` links depend on the relative shared-package layout. API pre-start/build/test/typecheck hooks compile shared dependencies.

### 2. Configure API, web and storage

On a fresh checkout only:

```powershell
Copy-Item .env.example .env
Copy-Item apps/web/.env.example apps/web/.env.local
```

Set matching POSTGRES initialization settings and host DATABASE_URL in root `.env`. URL-encode credentials. Provision a private directory outside the checkout for LOCAL_STORAGE_ROOT with permission for the API account. A safe illustrative configuration is:

```dotenv
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://user:password@localhost:5432/brainless
STORAGE_PROVIDER=local
LOCAL_STORAGE_ROOT=C:/BrainlessData
CORS_ORIGINS=http://localhost:3000
CORS_CREDENTIALS=true
COOKIE_SECURE=false
```

These database credentials are placeholders: use the values for your database. On Linux/macOS choose an appropriate absolute private directory. In `apps/web/.env.local`:

```dotenv
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1
```

Keep `localhost` spelling consistent for browser/API URLs. Next.js does not load the root `.env`; the API does. The web example's commented alternate port is only an example, not the API default. Do not leave placeholder public URLs in the file.

### 3. Start PostgreSQL and deploy migrations

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait postgres
```

Inject the matching host DATABASE_URL into the shell before running Prisma. The CLI does not load root `.env`. This PowerShell option avoids placing a URL containing credentials in command history:

```powershell
$databaseCredential = Get-Credential -Message 'Enter any label as username and the PostgreSQL URL as password'
$env:DATABASE_URL = $databaseCredential.GetNetworkCredential().Password
npm.cmd --prefix packages/database run migrate:deploy
Remove-Item Env:DATABASE_URL
```

Other shells can supply DATABASE_URL using their environment/secret tooling and run:

```sh
npm --prefix packages/database run migrate:deploy
```

Apply all ten migrations. Use deploy, not reset/schema push. Readiness checks connectivity, not migration history.

### 4. Run API and web

Separate terminals from root:

```sh
npm --prefix apps/api run start:dev
```

```sh
npm --prefix apps/web run dev
```

Open http://localhost:3000. Check http://localhost:3001/api/v1/health/live and http://localhost:3001/api/v1/health/ready. Swagger is at http://localhost:3001/api/v1/docs/. If making browser mutations from Swagger, add its exact origin to CORS_ORIGINS too.

Stop watchers with Ctrl+C; stop the database stack without deleting volumes:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

### 5. Verify a developer session

Register/login; create a category and tag; upload a small non-sensitive PDF/PNG/JPEG; view/edit metadata; download and compare bytes; append different bytes as version 2 and verify the latest download. Archive/restore and soft-delete a disposable document. Test profile/password/logout-all with disposable accounts. These manual checks complement, not replace, [automated suites](13-testing.md).

## Debugging the code

Use the existing API debug script:

```sh
npm --prefix apps/api run start:debug
```

It builds shared packages and launches Nest with inspector/watch. Attach your IDE's Node debugger to the inspector address printed by Nest (normally localhost:9229). Break at a controller, then follow the service and Prisma boundary. For focused Jest debugging:

```sh
npm --prefix apps/api run test:debug -- src/modules/documents/document-lifecycle.spec.ts
```

For browser behavior, run `next dev` and use browser DevTools. Follow component handler → `lib/api` → Network request → response trace ID. Inspect origin/path/status and cookie flags without copying token values into logs or issues. Refresh bugs may involve Web Locks, another tab, or a consumed credential, so preserve the distinction between 401 and network failure.

For upload problems, set breakpoints in `UploadService.create`, `receiveUpload`, `UploadInspector.inspect` and `UploadRepository.complete`. The transaction runs after storage/inspection; a file appearing before a document row is not necessarily an orphan. For download failure after headers, inspect the interrupted stream and `download.interrupted` event; a normal JSON error cannot be appended to binary bytes.

Compose images run compiled artifacts and do not publish inspector ports. Use logs and host debug mode; no attach/debug Compose override is provided. See [troubleshooting](15-troubleshooting.md).

## Before a change is complete

Read root and relevant nested AGENTS instructions plus the owning docs. Preserve unrelated changes, use existing service/client boundaries, add tests for behavior, and run the appropriate formatting/lint/typecheck/tests/builds from [testing](13-testing.md). Update schemas, Swagger, environment examples and human guides when contracts change. For documentation-only work, verify links, commands and claims against source rather than rerunning expensive unchanged runtime workflows.
