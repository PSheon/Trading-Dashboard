# Trading-Dashboard

> Product name pending — "Hyperliquid Watch" is used as a placeholder in the
> UI and page titles until Paul decides on a real name (see PRD §10 未決問題).
> The repo itself stays **Trading-Dashboard** per Paul's decision.

A self-hosted dashboard that watches ~100 Hyperliquid "whale" addresses
(sourced from CopyDog exports), continuously records their fills, positions
and equity — history Hyperliquid itself doesn't retain — and pushes Telegram
alerts within seconds of meaningful account activity (new positions,
flips, large moves, and group-level signals like consensus entries or
collective exits). Trade-following/execution is explicitly out of scope for
this version; see the full PRD for goals, non-goals and the locked design
decisions.

**Full spec:** [`docs/PRD — Hyperliquid 大戶監控與警報 Dashboard.md`](./docs/PRD%20%E2%80%94%20Hyperliquid%20%E5%A4%A7%E6%88%B6%E7%9B%A3%E6%8E%A7%E8%88%87%E8%AD%A6%E5%A0%B1%20Dashboard.md)

## Status

This is the **M1 scaffold**: repo structure, data model, and empty-but-wired
modules only. No Watcher polling/WS logic, rule evaluation, or Telegram
sending is implemented yet — every service method that isn't a simple
read/wire-up throws `not implemented`. Per the PRD's ordering principle
("Engine 先於 UI"), the dashboard currently only has an import page and a
system-status page; every other page (Live Feed, Leaders, Leader detail,
Heatmap, Alerts, Lists) is a "coming soon" placeholder so the nav is
complete for later milestones to fill in.

## Repo layout

```
apps/
  web/      Next.js (App Router) + Tailwind + shadcn/ui — dashboard, Vercel
  api/      Nest.js — Watcher/Scheduler/Rules/Notify/Import/API, Railway
packages/
  shared/   Drizzle schema (Postgres) + zod schemas/types shared by both apps
docs/
  PRD — Hyperliquid 大戶監控與警報 Dashboard.md
```

- **ORM**: Drizzle, schema lives in `packages/shared/src/schema/db.ts` (one
  source of truth for every table in PRD §6), migrations in
  `packages/shared/drizzle/`.
- **Auth**: no account system. apps/api checks a single bearer token
  (`API_AUTH_TOKEN`) with a global Nest guard, everywhere except `/health`.
  That token lives only on servers: the browser calls apps/web's own
  `/api/hl/*` route, which forwards to apps/api with the token attached.
  apps/web itself is behind a single shared password (`WEB_PASSWORD`) —
  see `apps/web/README.md`.
- shadcn/ui only for now (no ReUI — see the comment in
  `apps/web/src/components/app-shell.tsx`; ReUI is paid/registry and can be
  layered in later without blocking this scaffold).

## Running locally

Requires Node ≥22 (repo pinned to `v22.19.0`) and pnpm.

```bash
pnpm install

# copy env and fill in real values (DATABASE_URL at minimum to run the api)
cp .env.example .env

# generate/inspect the SQL migration (works offline, no DB needed)
pnpm db:generate

# apply migrations to a real Postgres (DATABASE_URL must point at one)
pnpm db:migrate

# start both apps in dev mode
pnpm dev

# typecheck / lint / build everything
pnpm typecheck
pnpm lint
pnpm build
```

apps/web reads four **server-only** env vars — `API_URL`, `API_AUTH_TOKEN`,
`WEB_PASSWORD`, `WEB_SESSION_SECRET` — see `apps/web/README.md`. Never give
apps/web a `NEXT_PUBLIC_*` copy of the api token: `NEXT_PUBLIC_` vars are
inlined into the browser bundle.

## Deployment

Per PRD §7: **apps/web → Vercel**, **apps/api + Postgres → Railway**
(Singapore region), single Railway service, sleep disabled.

- `apps/api/Dockerfile` + `apps/api/railway.json` — set the Railway
  service's root directory to the repo root (not `apps/api`), since the
  Dockerfile needs the whole pnpm workspace as build context.
- `apps/web/vercel.json` — set the Vercel project's Root Directory to
  `apps/web` in the dashboard; the build/install commands in that file `cd`
  back to the repo root to run `pnpm`/`turbo` against the whole workspace.
