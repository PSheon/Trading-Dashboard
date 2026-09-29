# Orbie

**orbit the best traders** · <https://app.orbie.fun>

Orbie is a copy-trading platform for Hyperliquid in the style of
[CopyDog](https://copydog.xyz): discover any trader on Hyperliquid, study their
positions and history, follow them, and get Telegram alerts within seconds of
their moves. Order execution comes in a later stage; today the copy panel is
UI only.

Where Orbie differs from CopyDog (see the
[competitor analysis](./docs/%E7%AB%B6%E5%93%81%E5%88%86%E6%9E%90%20%E2%80%94%20CopyDog%20%E9%A1%9E%E7%94%A2%E5%93%81%E7%9A%84%E7%B5%90%E6%A7%8B%E6%80%A7%E5%BC%B1%E9%BB%9E%E8%88%87%E6%94%B9%E9%80%B2%E6%96%B9%E5%90%91.md)):
it keeps its own history of fills and equity (Hyperliquid doesn't), shows
drawdown and sample size next to every return, tags vaults, aggregates fills
into actions before alerting, and shows what the tracked traders hold as a
crowd, not just one address at a time.

The repo directory is still named `Trading-Dashboard`, and the workspace
packages are still `@trading-dashboard/*`.

## Specs

- [`docs/PRD — Hyperliquid 大戶監控與警報 Dashboard.md`](./docs/PRD%20%E2%80%94%20Hyperliquid%20%E5%A4%A7%E6%88%B6%E7%9B%A3%E6%8E%A7%E8%88%87%E8%AD%A6%E5%A0%B1%20Dashboard.md): Stage 1, whale monitoring and alerts
- [`docs/Stage 2 — 跟單平台前置（探索、Privy、UI 重做）.md`](./docs/Stage%202%20%E2%80%94%20%E8%B7%9F%E5%96%AE%E5%B9%B3%E5%8F%B0%E5%89%8D%E7%BD%AE%EF%BC%88%E6%8E%A2%E7%B4%A2%E3%80%81Privy%E3%80%81UI%20%E9%87%8D%E5%81%9A%EF%BC%89.md): Stage 2, discovery, Privy login, CopyDog-style UI, admin and revenue
- [`docs/Orbie Logo.html`](./docs/Orbie%20Logo.html): logo, mark variants and small sizes

## Status

**Stage 1 (core monitoring delivered; not every PRD item):** leader lists (import, backfill), the watcher, rules
R1–R3 with Telegram notifications, and the first dashboard.

**Stage 2 (in progress):**

- Discovery of every Hyperliquid trader (official leaderboard, about 46k accounts).
- Privy login with per-user favorites, alert rules and Telegram channels.
- An alert fast path straight from the WebSocket trade feed, targeting under 5 s.
- A CopyDog-style redesign in zh-TW and English.
- An admin area for site settings, users, and revenue from Hyperliquid builder fees and referral rebates.

How the watcher works: it subscribes to perp-market `trades` WebSocket
channels. The fast path combines those trades with a position book to persist
actions and evaluate notifications without waiting for the fill index.
Background `userFillsByTime` calls store raw fills keyed by (chain, address, tid)
and correct provisional actions without repeating alerts. Startup, reconnect
and hourly sweeps repair missed data; five-minute snapshots reconcile positions.
See Stage 2 §5 for the current design and PRD §11.1 for its historical rationale.

The PRD is a historical specification, not a completion checklist. Stage 2 §11
supersedes the earlier Telegram UI and §12 adds activity filtering. See
[the audit follow-up](docs/audit-follow-up.md) for remaining reliability work.

## Repo layout

```text
apps/
  web/      Next.js (App Router) + Tailwind + shadcn/ui: app.orbie.fun, on Vercel
  api/      Nest.js: watcher, scheduler, rules, notify, import, API, on Railway
packages/
  shared/   Drizzle schema (Postgres) + zod contracts shared by both apps
docs/       PRD, Stage 2 spec, competitor analysis, logo
```

- **ORM**: Drizzle. Every table is defined in `packages/shared/src/schema/db.ts`,
  and migrations live in `packages/shared/drizzle/`. API request and response
  shapes are zod schemas in `packages/shared/src/schema/zod.ts`.
- **Auth**: Stage 1 used a single bearer token (`AUTH_SERVICE_TOKEN`) and one
  shared web password. Stage 2 replaces the password with Privy accounts
  (roles `user` and `admin`). The service token stays server-to-server only
  and never reaches the browser.

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

Run `pnpm db:generate` only after database schema changes, and review the SQL.
Tests require an explicitly exported, separate `TEST_DATABASE_URL`; run `pnpm test`.
Never point tests at a development or production database.

See `apps/web/README.md` for the web app's env vars. Never give apps/web a
`NEXT_PUBLIC_*` copy of the api token: `NEXT_PUBLIC_` vars are inlined into
the browser bundle.

## Deployment

**apps/web → Vercel** at `app.orbie.fun`. **apps/api + Postgres → Railway**
(Singapore region), as a single Railway service with sleep disabled.

- `apps/api/Dockerfile` + `apps/api/railway.json`: set the Railway service's
  root directory to the repo root (not `apps/api`), since the Dockerfile needs
  the whole pnpm workspace as build context.
- `apps/web/vercel.json`: set the Vercel project's Root Directory to
  `apps/web` and add `app.orbie.fun` under Domains. The build and install
  commands in that file `cd` back to the repo root to run `pnpm`/`turbo`
  against the whole workspace.
