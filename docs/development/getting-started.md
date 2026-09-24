# Getting started

[Documentation index](../README.md) | [Testing](testing.md)

## Choose a development workflow

For the complete application, use [Docker Compose](../compose.md). It installs the
runtime dependencies, runs migrations and serves the app at http://localhost:8080.
Compose runs compiled servers, not source watchers; rebuild after code changes.
No host Node/qpdf installation is required just to run this stack.

For source watchers, use the host workflow below. Prerequisites: Git, Node.js 24+
with npm, Docker with Linux containers and Compose v2 (or an existing PostgreSQL 17
server), and qpdf on PATH. The API uses qpdf for PDF validation; Docker installs it
in the API image. Dependency installation requires registry access; Next.js builds
also fetch the existing Google Fonts. Use `npm.cmd` if PowerShell blocks `npm.ps1`.

Clone the configured repository remote (access may be required):

```sh
git clone https://github.com/Eqooid/brainless.git
cd brainless
```

All subsequent commands run from the repository root.

## Install the independent packages

```sh
npm --prefix packages/storage ci
npm --prefix packages/database ci
npm --prefix packages/storage run build
npm --prefix packages/database run build
npm --prefix apps/api ci
npm --prefix apps/web ci
```

There is no root install/build script. Keep the four npm lockfiles; the API uses
relative `file:` links to the shared packages. API build/typecheck/test/start-dev
hooks build those packages. Prisma generation does not require a live database.

## Configure local environment

On a fresh checkout only:

```sh
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
```

PowerShell equivalents:

```powershell
Copy-Item .env.example .env
Copy-Item apps/web/.env.example apps/web/.env.local
```

Preserve existing files. Replace required placeholders and leave unused optional
settings commented. In root `.env`, configure:

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` for the local database.
- `DATABASE_URL` with matching URL-encoded credentials, host `127.0.0.1`, database
  name and port (`POSTGRES_PORT`, default 5432). Never paste real values into docs.
- `LOCAL_STORAGE_ROOT`: a provisioned private absolute directory outside the checkout
  that does not contain the checkout; grant the API account access. Host storage is
  independent of the Compose volume.
- `PORT=3001`, `CORS_ORIGINS=http://localhost:3000`, `CORS_CREDENTIALS=true`.
- Leave `NODE_ENV=development` and `COOKIE_SECURE=false` for local HTTP.

In `apps/web/.env.local`, replace its placeholder with:

```dotenv
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1
```

Use the same hostname spelling in both browser origins. The API loads root `.env`;
Next.js loads its own `.env.local`. Prisma CLI requires a separately injected
`DATABASE_URL`. See the [environment reference](../deployment/environment-variables.md)
for every setting, Compose overrides and upload limits.

## Start the database and apply migrations

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait postgres
```

This publishes PostgreSQL on loopback for the host API. With your intended
`DATABASE_URL` injected into the shell, run:

```sh
npm --prefix packages/database run migrate:deploy
```

A PowerShell option avoids putting a credential-bearing URL in shell history:

```powershell
$databaseCredential = Get-Credential -Message 'Enter any label as username and the PostgreSQL URL as password'
$env:DATABASE_URL = $databaseCredential.GetNetworkCredential().Password
npm.cmd --prefix packages/database run migrate:deploy
Remove-Item Env:DATABASE_URL
```

Use the matching root `.env` value for API startup. Apply all migrations; readiness
checks connectivity, not migration history. Do not use reset or schema push to
start/update this application. Existing database initialization values and Compose
project names must remain stable to retain access to existing volumes.

## Start API and frontend

Run in separate terminals:

```sh
npm --prefix apps/api run start:dev
```

```sh
npm --prefix apps/web run dev
```

Open http://localhost:3000 and register, then log in. API Swagger is at
http://localhost:3001/api/v1/docs/ and readiness at http://localhost:3001/api/v1/health/ready.
If using Swagger's browser requests, include its exact origin in `CORS_ORIGINS` too.
The web client has no automatic API proxy. Restart API after environment changes;
public web settings are embedded in production builds and require a rebuild.

For compiled host execution after the [build checks](testing.md), the existing scripts
are `npm --prefix apps/api run start:prod` and `npm --prefix apps/web run start`.
The API script does not set `NODE_ENV`; production needs explicit production settings
and HTTPS. See [deployment limitations](../compose.md#environment-and-cookies).

Stop host watchers with Ctrl+C. Stop Compose without deleting data with
`docker compose -f docker-compose.yml -f docker-compose.dev.yml down`.
