# Railway deployment

2026-10-01. How Orbie runs on Railway: the services, their variables, the worker's schedules, storage, and how Stage and production stay apart. It collects what `worker-deployment.md`, `container-delivery.md`, `staging-history-release.md` and `backup-and-restore.md` established and adds the S3 archive ingest (`s3-archive-ingest.md`).

Read-only check for this document: `railway status` → workspace "Paul's Projects", project **Orbiefun** (`a04669bd-cefb-40bc-96ef-f9d984da6817`), environment **Stage** (`2ed38f77-b0ad-498f-aba1-6d57f55cf288`), linked service `web`. No Railway command that creates or changes anything was run, variables were not read, and nothing in this document has been applied to Railway.

## Services

One project, one environment per stage, four services per environment. `api` and `worker` are the same image started two ways.

| Service | Source | Start | Public | Health check |
| --- | --- | --- | --- | --- |
| `web` | Railpack; build `shared` then `web` | `pnpm --filter @trading-dashboard/web exec next start --hostname :: --port 3000` | Yes (`stage.orbie.fun`) | as configured in Railway |
| `api` | `apps/api/Dockerfile` (`apps/api/railway.json`) | `node dist/main.js`, pre-deploy `node scripts/migrate.mjs` | No: reached by `web` over the private network (`/api/hl/*` proxy) | `/health/ready` |
| `worker` | same image as `api` | `node dist/worker.js` | No (`worker.railway.internal:3000`) | `/health/live` (liveness); `/health/ready` is 503 while standby |
| `Postgres` | Railway PostgreSQL | — | No public URL | — |

Rules that already hold and must keep holding:

- One replica each. The worker takes a PostgreSQL session advisory lock before it builds its Nest context, so a replacement started during a rolling deploy waits as standby and takes over when the old one exits. Never run `APP_ROLE=combined` while a worker is active.
- The api runs no cron, interval or startup job; every schedule below runs in the worker.
- Migrations run once per release from the api's pre-deploy command, with the same image, behind an advisory lock. The worker does not migrate. Deploy order: back up → api (migrates) → worker → web.

## Worker schedules

Everything is in-process (`@nestjs/schedule`); there is no Railway cron service and none is needed.

| Job | Cadence | What it does | Budget setting |
| --- | --- | --- | --- |
| Trade feed + fill sync | continuous (WebSocket), sweep hourly | fills and actions of watched leaders | global `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` |
| Position / equity snapshots | every 5 min | `position_snapshots`, `equity_snapshots`, reconcile | global |
| Leaderboard import | `discovery.leaderboardRefreshMinutes` (15) | official leaderboard → `trader_stats` | no info weight |
| Discovery pool | every minute | rebuild the pool when due; refresh rows | `discovery.poolWeightPerMinute` |
| Insight cohorts | every minute | member positions, tier snapshots | `discovery.cohortWeightPerMinute` |
| Durable fill history | every minute, 2 pages | REST history per address; skips ranges the archive certifies | global, lowest priority |
| **S3 archive ingest** | every minute | new hourly objects forward, then backfill backward; filtered to the tracked set | `S3_ARCHIVE_MAX_BYTES_PER_MINUTE`, `S3_ARCHIVE_MAX_DAILY_USD` (no Hyperliquid weight) |
| Initial backfill jobs | every 5 s | `backfill_jobs` for newly watched addresses | global |
| Outbox / notifications | every 5 s | Telegram delivery (dry-run unless configured) | — |
| KOL avatars | every 30 s | one avatar fetch at most | — |
| Revenue snapshot | hourly at :07 | builder/referral revenue | global |
| Copy worker | `COPY_WORKER_INTERVAL_MS` (2 s) | paper copy execution | — |

## Variables

Secrets are set in Railway per service and per environment; nothing here belongs in git. "ref" means a Railway reference variable.

### api

| Variable | Stage | Production | Notes |
| --- | --- | --- | --- |
| `APP_ROLE` | `api` | `api` | |
| `WORKER_URL` | `http://worker.railway.internal:3000` | same pattern | required for role `api` |
| `NODE_ENV` | `staging` | `production` | both enable production-grade validation |
| `PORT` | `3000` | `3000` | |
| `DATABASE_URL` | ref → Stage Postgres | ref → production Postgres | never the other environment's |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY` | Stage Privy app | production Privy app | api only |
| `AUTH_ADMIN_EMAILS` | owner's email(s) | owner's email(s) | bootstrap admins |
| `AUTH_SERVICE_TOKEN`, `AUTH_SERVICE_PERMISSIONS` | unset | unset unless a service caller exists | ≥ 32 chars when set |
| `API_CORS_ORIGINS` | `https://stage.orbie.fun` | production origin | exact origins |
| `API_TRUSTED_PROXY_CIDRS` | as set on Stage (`http-security-and-logs.md`) | same rule | explicit addresses or CIDRs only |
| `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WEIGHT_BURST` | `240` / `100` | `240` / `100` | page traffic; api + worker share one IP limit of 1,200/min |
| `HYPERLIQUID_NETWORK` | `testnet` | `testnet` until mainnet signing is approved | user wallet only |
| `COPY_TRADING_MODE` | `paper` | `paper` | `testnet`/`live` are refused at startup |

### worker

| Variable | Stage | Production | Notes |
| --- | --- | --- | --- |
| `APP_ROLE` | `worker` | `worker` | |
| `NODE_ENV`, `PORT`, `DATABASE_URL` | as api | as api | |
| `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WEIGHT_BURST` | `600` / `100` | `600` / `100` | 240 + 600 = 840 of 1,200 |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_SYSTEM_CHAT_ID` | Stage bot | production bot | different bots per environment (one poller per token) |
| `TELEGRAM_DRY_RUN` | `true` | `false` only when alerts go live | |
| `TELEGRAM_LINK_BASE_URL` | `https://stage.orbie.fun` | production origin | |
| `S3_ARCHIVE_ENABLED` | `false` until verified, then `true` | `true` after Stage has reconciled | see `s3-archive-ingest.md` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | IAM user for Stage | a **separate** IAM user for production | worker only; policy in `s3-archive-ingest.md` |
| `S3_ARCHIVE_MAX_DAILY_USD` | `0.5` (live hours only fit) | `2` during backfill, `0.5` after | hard cap per UTC day |
| `S3_ARCHIVE_USD_PER_GB` | `0.114` | `0.114` | Tokyo → internet |
| `S3_ARCHIVE_MAX_BYTES_PER_MINUTE` | `268435456` | `268435456` | |
| `S3_ARCHIVE_BACKFILL_ENABLED` | `false` | `true` | Stage does not need the full history twice |
| `S3_ARCHIVE_START` | `2025-05-25` | `2025-05-25` | adjust after the probe |
| `S3_ARCHIVE_TRUST` | `regular` | `regular` | `all` only after a TWAP reconciliation |
| `S3_ARCHIVE_SETTLE_MINUTES`, `S3_ARCHIVE_MAX_FILLS_PER_ADDRESS_HOUR` | defaults | defaults | |

No Privy secret on the worker (it mounts no user API). No AWS key on api or web.

### web

| Variable | Stage | Production |
| --- | --- | --- |
| `NEXT_API_URL` | `http://api.railway.internal:3000` | same pattern |
| `NEXT_PUBLIC_APP_URL` | `https://stage.orbie.fun` | production origin |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Stage Privy app id | production Privy app id |
| `NEXT_PUBLIC_API_FIXTURES` | `0` | `0` |
| `NEXT_PRIVY_AUTH_ORIGINS` | as configured in `frontend-environment.md` | same |

`NEXT_PUBLIC_*` values are compiled in: changing one needs a rebuild, not a restart.

### Budget settings (database, not environment)

`discovery.poolWeightPerMinute` and `discovery.cohortWeightPerMinute` live in `app_settings` and are edited in `/admin/settings`; the worker reports what it actually applied on `/health/monitor`.

| Setting | Code default | Dev (lowered 2026-10-01) | Suggested on Railway |
| --- | --- | --- | --- |
| `discovery.poolWeightPerMinute` | 240 | 100 | 240 while the pool is filling; lower once the archive supplies history (each row then needs a few REST pages, not a scan) |
| `discovery.cohortWeightPerMinute` | 200 | 60 | 200 |
| `discovery.candidatePoolSize` | 1,000 | — | 1,000 |

Pool + cohort + pages must fit the worker's 600/min. The archive ingest spends none of it.

## Volumes and storage

- Only Postgres has a volume. api, worker and web are stateless; the archive ingest streams objects through memory (one decoded block, at most 4 MiB, plus a batch of rows) and writes nothing to disk.
- Size the Postgres volume for `analysis_history_fills`: about 660 bytes per fill with indexes (dev: 1.08 M fills = 716 MB). A backfilled tracked set of ≈ 2,300 addresses is tens of GB. Watch the volume after enabling backfill; Railway volumes can be grown, not shrunk.
- `archive_ingest_state` and `archive_coverage` are small but are the only record of what was ingested: they are part of the normal database backup. Losing them means re-reading (and re-paying for) the archive; the fills themselves would deduplicate.
- Back up before every release that carries a migration (`backup-and-restore.md`).

## Stage and production

- Separate Railway environments with separate Postgres services, Privy apps, Telegram bots and AWS IAM users. A variable is never shared by reference across environments.
- Stage exists (`stage.orbie.fun`, api + worker + web + `Postgres-PbuT`). The production environment currently holds only a Postgres service; api, worker and web have not been created there.
- Promotion: a release is deployed to Stage, migrated, and checked (`/health/ready`, `/health`, the pages in a browser, and for data changes the reconciliation in `s3-archive-ingest.md`). The same commit is then deployed to production. Stage data is never copied to production.
- AWS cost is per environment: with both ingesting live hours the transfer is paid twice (≈ US$3–4 a month each). Keep backfill off on Stage.

## Releasing the archive ingest

1. Stage: deploy api (runs migration `0017`), worker, web. With `S3_ARCHIVE_ENABLED=false` nothing changes in behaviour.
2. Locally, with the Stage IAM user's keys: `node apps/api/scripts/s3-archive-probe.mjs --sample`; settle the unverified facts.
3. Stage worker: `S3_ARCHIVE_ENABLED=true`, backfill off, cap US$0.5. Check `https://stage.orbie.fun/api/hl/health` → `archive.lagSeconds`, `archive.fillsKept`, `archive.lastError: null`.
4. Run the reconciliation against Stage's data. Archive-origin fills must equal REST tid by tid.
5. Production: same steps with its own IAM user; then backfill on, cap US$2 until `archive.addresses.pending` reaches 0.

## Rollback

`S3_ARCHIVE_ENABLED=false` stops downloads at once; stored fills stay valid and REST resumes full scans from its own checkpoints (`S3_ARCHIVE_TRUST=none` forces that even while ingest continues). Migration `0017` is additive, so the previous image runs against the migrated schema.
