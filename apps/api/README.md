# Orbie API

NestJS service for public trader discovery, authenticated user data, admin APIs,
Hyperliquid monitoring and Telegram notifications. Deployed as one Railway
replica with PostgreSQL; the web app forwards the browser's Privy bearer token.

## Local development

From the repository root, use Node 22+ and pnpm 10.17.1:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Set DATABASE_URL and any optional integrations in .env.
pnpm db:migrate
pnpm dev
```

Provide your own development PostgreSQL or create a disposable instance:

```sh
docker run --name orbie-postgres-dev --rm -d \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=trading_dashboard \
  -p 127.0.0.1:5432:5432 postgres:16-alpine
```

For that container, set `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/trading_dashboard`.
The API listens on `PORT` (default 3000); web dev uses 3001. Root `pnpm dev`
builds shared contracts before starting both apps and the shared compiler watch.
The API and migration config load the repo-root `.env`; exported values win.
Build/typecheck do not require a live database. Use `pnpm db:generate` only after
changing the database schema; review generated SQL before applying it.

## Automated tests: a separate database

Tests truncate tables. They **never use DATABASE_URL**. `TEST_DATABASE_URL` is
required, must point to `localhost`, `127.0.0.1` or `::1`, have a database name
ending in `_test`, and contain no query options. Tests do not load `.env`.
Use a disposable instance and avoid sharing it with other agents or test runs.

```sh
docker run --name orbie-postgres-test --rm -d \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=trading_dashboard_test \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
# Wait until: docker exec orbie-postgres-test pg_isready -U postgres
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/trading_dashboard_test
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
pnpm test
# Stop only this disposable container when finished:
docker stop orbie-postgres-test
```

For a subset, pass filters directly to Vitest (no extra `--`):

```sh
pnpm --filter @trading-dashboard/api exec vitest run test/routes-auth.spec.ts
pnpm --filter @trading-dashboard/api test:cov
```

`vitest.config.ts` runs test files sequentially because they share a database.
Hyperliquid and Telegram are replaced in automated tests; local HTTP/WS servers
require loopback socket permission. `test:e2e` is a separate manual mainnet
read-only test and requires explicit opt-in described in its source; it is not
part of the normal suite.

## Service boundaries

- `common/auth`: global default-deny guard, Privy verification, role checks and
  a hashed-token cache. Public routes explicitly opt in. `AUTH_SERVICE_TOKEN`
  is a server-only admin identity, never added by the browser proxy.
- `traders`, `insights`: public discovery, cached Hyperliquid views, crowd data.
- `users`, `admin`, `settings`: owner-scoped data and administrative controls.
- `watcher`: WS `trades` → position book → actions; background fills confirm
  and correct actions. Fill primary keys and per-address transaction locks
  deduplicate overlapping processing. Replaying a returned fill window repairs
  actions missing after an interrupted sync; this is not a durable replay queue.
- `scheduler`: complete equity/position snapshots in one transaction, periodic
  reconciliation/sweeps and feed outage checks.
- `rules`, `notify`: evaluate persisted actions and deliver notifications.
  Telegram feature changes are specified in Stage 2 §11; see current controllers
  and the audit follow-up for implementation limits.
- `packages/shared`: PostgreSQL schema/migrations and Zod request contracts.

Invalid legacy actions/alerts/leaders/lists/import request shapes now return 400.
Public leader positions use the latest equity snapshot timestamp, including a
flat snapshot with no position rows. Alert history remains owner-scoped (admins
can view all).

## Deployment and operations

Use the repo root as Docker build context, `apps/api/Dockerfile`, and
`apps/api/railway.json`. The Docker ignore file excludes environment files,
local dependencies, Git metadata and build output. Set secrets in Railway.
Run migrations against the intended deployment database before releasing code
that requires them; the runtime image does not run migrations automatically.

`/health` is a public operational heartbeat, not a database readiness guarantee.
Keep one replica: caches, watcher state and notification coordination currently
assume one process. Do not scale replicas without distributed ownership.

`AUTH_ADMIN_EMAILS` promotes matching verified emails on subsequent authenticated
requests as well as first registration. Remove an email from this setting before
demoting its account, or it can be promoted again. `TELEGRAM_DRY_RUN=true` is the
default; review it deliberately before enabling real delivery.

Backups, retention jobs, readiness checks and durable notification recovery are
not guaranteed by this repository's deployment config. Confirm platform settings
and rehearse recovery before treating this as production-ready. Remaining work:
[Audit follow-up](../../docs/audit-follow-up.md).
