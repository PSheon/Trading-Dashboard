# Orbie

**orbit the best traders** · Stage: <https://stage.orbie.fun>

Orbie is a copy-trading platform for Hyperliquid in the style of
[CopyDog](https://copydog.xyz): discover any trader on Hyperliquid, study their
positions and history, follow them, and get Telegram alerts within seconds of
their moves, and copy them live on Hyperliquid from a dedicated copy wallet
(mainnet ratio-only, with per-mandate caps; see
[decisions](docs/decisions-2026-10-23.md)).

Current research features include retained fills and equity snapshots for tracked
addresses, drawdown and sample indicators, vault labels, action-level alerts,
and a crowd view of tracked positions. Hyperliquid also provides bounded
historical data; local retention does not establish complete pre-tracking history.
These features are not all unique to CopyDog; the comparison history and the
decisions taken from it live in [decisions](docs/decisions-2026-10-23.md).

The repo directory is still named `Trading-Dashboard`, and the workspace
packages are still `@trading-dashboard/*`.

## Specs

- [`docs/decisions-2026-10-23.md`](docs/decisions-2026-10-23.md): the decision log; the
  earlier PRD and Stage specs were retired into it (2026-10-23)
- [`docs/Orbie Logo.html`](./docs/Orbie%20Logo.html): logo, mark variants and small sizes

## Status

Delivered: leader lists (import, backfill), the watcher, rules R1–R3 with
Telegram notifications; discovery of every Hyperliquid trader (official
leaderboard, about 46k accounts); Privy login with favorites, per-trader alert
preferences and official Telegram bot linking; an alert fast path straight from
the WebSocket trade feed; the Orbie UI in zh-TW and English; an admin area for
site settings, users, and revenue from Hyperliquid builder fees and referral
rebates; live copy trading (copy wallet, mandates, settlement, withdrawals) on
testnet and mainnet.

How the watcher works: it subscribes to perp-market `trades` WebSocket
channels. The fast path combines those trades with a position book to persist
actions and evaluate notifications without waiting for the fill index.
Background `userFillsByTime` calls store raw fills keyed by (chain, address, tid)
and correct provisional actions without repeating alerts. Startup, reconnect
and hourly sweeps repair missed data; five-minute snapshots reconcile positions.
Open follow-ups and the reasoning behind each design choice are in
[decisions](docs/decisions-2026-10-23.md).

## Repo layout

```text
apps/
  web/      Next.js (App Router) + Tailwind + shadcn/ui, on Railway (stage.orbie.fun)
  api/      Nest.js: the HTTP api, and the same image as worker-copy / worker-read
            (watcher, scheduler, live copy, rules, notify, import), on Railway
packages/
  shared/   Drizzle schema (Postgres) + zod contracts shared by both apps
docs/       runbooks, designs, the decision log, logo
```

- **ORM**: Drizzle. Every table is defined in `packages/shared/src/schema/db.ts`,
  and migrations live in `packages/shared/drizzle/`. API request and response
  shapes are zod schemas in `packages/shared/src/schema/zod.ts`.
- **Auth**: Privy accounts (roles `user` and `admin`); the bearer token
  (`AUTH_SERVICE_TOKEN`) is the service identity and stays server-to-server only
  and never reaches the browser. It requires explicit `AUTH_SERVICE_PERMISSIONS`;
  it no longer inherits admin access. See [auth/config policy](docs/auth-and-config.md).

## Running locally

Requires Node ≥22, pnpm 10.17.1 and PostgreSQL. For disposable Docker
instances and isolated test setup, see [apps/api/README.md](apps/api/README.md).

```bash
pnpm install --frozen-lockfile

# copy env and fill in real values (DATABASE_URL at minimum to run the api)
cp .env.example .env

# apply migrations to a real Postgres (DATABASE_URL must point at one)
pnpm db:migrate

# build/watch shared contracts, start API :3000 and web :3001
pnpm dev

# typecheck / lint / build everything
pnpm typecheck
pnpm lint
pnpm build
```

Install the pre-push hook once per clone (contract docs, typecheck, lint; see
[docs/ci-and-testing.md](docs/ci-and-testing.md)):
`ln -s ../../scripts/pre-push.sh .git/hooks/pre-push`.

Run `pnpm db:generate` only after database schema changes, and review the SQL.
Root `pnpm test` creates and removes a fresh migrated API test database. Export
`TEST_DATABASE_ADMIN_URL` pointing to a disposable loopback PostgreSQL parent
(`postgres` or an `_test` database) with CREATE DATABASE permission.
Never point tests at a development or production database.

See `apps/web/README.md` for the web app's env vars. Never give apps/web a
`NEXT_PUBLIC_*` copy of the api token: `NEXT_PUBLIC_` vars are inlined into
the browser bundle.

## Deployment

Everything runs on Railway (Singapore region), one environment per stage:
`web` (Railpack, public at `stage.orbie.fun`), `api`, `worker-copy` and
`worker-read` (the api image with `IS_WORKER=true` and `WORKER_ROLE`), and
Postgres. One replica each. See [docs/railway-deploy.md](docs/railway-deploy.md)
and [docs/worker-deployment.md](docs/worker-deployment.md).

- `apps/api/Dockerfile` + `apps/api/railway.json`: set the Railway service's
  root directory to the repo root (not `apps/api`), since the Dockerfile needs
  the whole pnpm workspace as build context.

## Current engineering status

See [decisions](docs/decisions-2026-10-23.md) for what was decided and what is
still open. Key runbooks:
[CI/tests](docs/ci-and-testing.md), [runtime image/migrations](docs/container-delivery.md),
[backup/restore](docs/backup-and-restore.md), [dependencies](docs/dependency-maintenance.md),
[HTTP contracts](docs/http-contract.md), [accessibility](docs/accessibility.md),
[review tracker](docs/review-tracker-2026-10-07.md).
Current code, the generated route catalog and these runbooks take precedence
over any dated review.
