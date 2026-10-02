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
- The release that carries migration 0021 (typed `history_fills`) also has to convert the stored fills: for that release set the api's pre-deploy command to `node scripts/migrate.mjs && node dist/traders/convert-history-fills.js all` (copy in batches, verify every row, retire the raw table; a no-op once converted, see `docs/s3-archive-ingest.md`). Until it has run, the new api and worker refuse history reads and writes; the previous worker's history writes fail from the rename until it is replaced, and are retried by the new one.

## Worker schedules

Everything is in-process (`@nestjs/schedule`); there is no Railway cron service and none is needed.

| Job | Cadence | What it does | Budget setting |
| --- | --- | --- | --- |
| Trade feed + fill sync | continuous (WebSocket), sweep hourly | fills and actions of watched leaders | global `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` |
| Position / equity snapshots | every 5 min | `position_snapshots`, `equity_snapshots`, reconcile | global |
| Leaderboard import | `discovery.leaderboardRefreshMinutes` (15) | official leaderboard → `trader_stats` | no info weight |
| Discovery pool, performance | every minute | rebuild the pool when due; `portfolio` of the most urgent rows (boards, home rows, KOLs and followed traders 4× as often) | `discovery.poolPerformanceWeightPerMinute` |
| Discovery pool, ledgers | every minute | incremental ledger refreshes of visible rows, then cold builds while no page waits | `discovery.poolWeightPerMinute` |
| Insight cohorts | every minute | member positions, tier snapshots | `discovery.cohortWeightPerMinute` |
| Durable fill history | every minute, 2 pages | REST history per address; skips ranges the archive certifies | `discovery.historyWeightPerMinute` (budgeter cap) |
| **S3 archive ingest** | every minute | new hourly objects forward, then backfill backward; filtered to the tracked set | `S3_ARCHIVE_MAX_BYTES_PER_MINUTE`, `S3_ARCHIVE_MAX_DAILY_USD` (no Hyperliquid weight) |
| Initial backfill jobs | every 5 s | `backfill_jobs` for newly watched addresses | global |
| Backward fill backfill | every minute, one window | `fill_coverage` of watched addresses | `discovery.backfillWeightPerMinute` (budgeter cap) |
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
| `HYPERLIQUID_STARTUP_PACE_SECONDS` | `60` (default) | `60` | api and worker: a new process starts with empty buckets at half its rate for this long, so a redeploy that overlaps the old instance does not double the spend on the shared IP limit |
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
| `S3_ARCHIVE_BACKFILL_DAYS` / `S3_ARCHIVE_PASS_INTERVAL_HOURS` | `90` / `168` | `90` / `168` | 90 days = 80 GB = US$9.14 a pass; at most one pass a week |
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

The per-job weight caps live in `app_settings` (`discovery`) and are edited in `/admin/settings` (or `PATCH /admin/settings`); the worker reports what it actually applied on `/health/monitor`, and `/health` → `budget.consumers` shows who spent the trailing minute.

| Setting | Code default (2026-10-02) | Dev | What it bounds |
| --- | --- | --- | --- |
| `discovery.poolPerformanceWeightPerMinute` | 240 | 240 | the pool's `portfolio` reads (12 rows a minute): board / home / card figures |
| `discovery.poolWeightPerMinute` | 100 | 100 | the pool's trade-ledger builds and refreshes (coin boards, style, last trade) |
| `discovery.cohortWeightPerMinute` | 60 | 60 | 洞察 member positions |
| `discovery.historyWeightPerMinute` | 120 | 120 | durable fill-history pages (cap enforced by the budgeter) |
| `discovery.backfillWeightPerMinute` | 120 | 120 | backward fill backfill windows (cap enforced by the budgeter) |
| `discovery.candidatePoolSize` | 1,000 | — | — |

At the default 840/min: jobs 240 + 100 + 60 + 120 + 120 = 640, plus the home warm-up (24 portfolios every 10 min ≈ 48), leader snapshots and sweeps (≈ 60 averaged) ≈ 750 when every job is busy, leaving ≈ 90 plus the page reserve for pages; every job scales down to a quarter of its allowance while page traffic approaches half the budget (`backgroundFactor` on `/health`). The page reserve (60 % of the burst, refilled first; `HYPERLIQUID_PAGE_RESERVE_SHARE` of the rate is its floor) is never spent by jobs. Pool freshness at 240: ≈ 480 visible rows of ≈ 1,140 are read every ≈ 54 min (median age ≈ 27 min), the rest every ≈ 3.6 h (`discovery.*AgeSeconds` on `/health`). The archive ingest spends no Hyperliquid weight.

## Volumes and storage

- Only Postgres has a volume. api, worker and web are stateless; the archive ingest streams objects through memory (one decoded block, at most 4 MiB, plus a batch of rows) and writes nothing to disk.
- Size the Postgres volume for `history_fills`: about 209 bytes per fill with indexes after migration 0021 (dev: 5.89 M fills = 1.23 GB; ≈ 218 for archive rows). See `docs/s3-archive-ingest.md` for the 90-day figure. Watch the volume after enabling backfill; Railway volumes can be grown, not shrunk.
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
3. Stage worker: `S3_ARCHIVE_ENABLED=true`, backfill off, cap US$0.5. Check `/admin/system` as an admin (or `GET /admin/system/heartbeat`; the public `/health` no longer carries it) → `archive.lagSeconds`, `archive.fillsKept`, `archive.lastError: null`.
4. Run the reconciliation against Stage's data. Archive-origin fills must equal REST tid by tid.
5. Production: same steps with its own IAM user; then backfill on, cap US$2 until `archive.addresses.pending` reaches 0.

## Rollback

`S3_ARCHIVE_ENABLED=false` stops downloads at once; stored fills stay valid and REST resumes full scans from its own checkpoints (`S3_ARCHIVE_TRUST=none` forces that even while ingest continues). Migration `0017` is additive, so the previous image runs against the migrated schema.
