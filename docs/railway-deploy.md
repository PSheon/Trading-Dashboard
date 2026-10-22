# Railway deployment

2026-10-01. How Orbie runs on Railway: the services, their variables, the worker's schedules, storage, and how Stage and production stay apart. It collects what `worker-deployment.md`, `container-delivery.md`, `staging-history-release.md` and `backup-and-restore.md` established and adds the S3 archive ingest (`s3-archive-ingest.md`).

Read-only check for this document: `railway status` → workspace "Paul's Projects", project **Orbiefun** (`a04669bd-cefb-40bc-96ef-f9d984da6817`), environment **Stage** (`2ed38f77-b0ad-498f-aba1-6d57f55cf288`), linked service `web`. No Railway command that creates or changes anything was run, variables were not read, and nothing in this document has been applied to Railway.

## Services

One project, one environment per stage, four services per environment. `api` and `worker` are the same image and the same start command (`node dist/main.js`); `IS_WORKER=true` makes it the worker (2026-10-04, as in DonutMe; `APP_ROLE` and `dist/worker.js` are gone, and a process that still has `APP_ROLE` refuses to start).

| Service | Source | Start | Public | Health check |
| --- | --- | --- | --- | --- |
| `web` | Railpack; build `shared` then `web` | `pnpm --filter @trading-dashboard/web exec next start --hostname :: --port 3000` | Yes (`stage.orbie.fun`) | as configured in Railway |
| `api` | `apps/api/Dockerfile` (`apps/api/railway.json`) | `node dist/main.js`, pre-deploy `node scripts/migrate.mjs` | No: reached by `web` over the private network (`/api/hl/*` proxy) | `/health/ready` |
| `worker` | same image as `api`, `IS_WORKER=true` | `node dist/main.js` (the Dockerfile's default; no custom start command) | No (`worker.railway.internal:3000`) | `/health/live` (liveness); `/health/ready` is 503 while standby |
| `Postgres` | Railway PostgreSQL | — | No public URL | — |

Rules that already hold and must keep holding:

- One replica each. The worker takes a PostgreSQL session advisory lock before it builds its Nest context, so a replacement started during a rolling deploy waits as standby and takes over when the old one exits. There is no combined mode: an api never runs jobs, so the worker must be deployed for anything to refresh.
- The api (`AppModule.api()`) runs no cron, interval, loop or startup job and has no `ScheduleModule`; every schedule below lives in `WorkerModule`, which only `AppModule.worker()` imports (`test/api-role-isolation.spec.ts`). The worker is a Nest application context: no routes, only its health server (`/health`, `/health/live`, `/health/ready`, `/health/monitor`).
- The worker outlives a database outage: while it cannot reach Postgres (before it owns the lease, or on standby) it retries with backoff (1 s → 30 s) for 10 minutes of continuous unavailability (`WORKER_DB_RETRY_WINDOW_MS`), live but not ready, and only then exits. Once it owns the lease, losing that connection still exits at once (the lock goes with the session, and exiting is the only immediate fence for its running jobs); the restarted process waits the outage out the same way. Set the `worker` service's restart policy to **Always** in Railway (its settings, not `apps/api/railway.json`, which is the `api`'s config with the `/health/ready` check): with "On failure" and a retry cap, a long outage can still use the retries up and leave the worker stopped while the api looks healthy (2026-10-12).
- Migrations run once per release from the api's pre-deploy command, with the same image, behind an advisory lock. The worker does not migrate. Deploy order: back up → api (migrates) → worker → web.
- The release that carries migration 0021 (typed `history_fills`) also has to convert the stored fills: for that release set the api's pre-deploy command to `node scripts/migrate.mjs && node dist/traders/convert-history-fills.js all` (copy in batches, verify every row, retire the raw table; a no-op once converted, see `docs/s3-archive-ingest.md`). Until it has run, the new api and worker refuse history reads and writes; the previous worker's history writes fail from the rename until it is replaced, and are retried by the new one.

## Worker schedules

Everything is in-process (`@nestjs/schedule`); there is no Railway cron service and none is needed.

| Job | Cadence | What it does | Budget setting |
| --- | --- | --- | --- |
| Trade feed + fill sync | continuous (WebSocket), sweep every 15 min | fills and actions of watched leaders | global `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN`; sweeps at essential rank, a call waits at most 14 min |
| Position / equity snapshots | every 5 min | `position_snapshots`, `equity_snapshots`, reconcile | global; essential rank (ahead of every other job), a call waits at most 4 min |
| Leaderboard import | `discovery.leaderboardRefreshMinutes` (15) | official leaderboard → `trader_stats` | no info weight |
| Discovery pool, performance | every minute | rebuild the pool when due; `portfolio` of the most urgent rows (boards, home rows, KOLs and followed traders 4× as often) | `discovery.poolPerformanceWeightPerMinute` (budgeter cap) |
| Discovery pool, ledgers | every minute | incremental ledger refreshes of visible rows, then cold builds while no page waits | `discovery.poolWeightPerMinute` (budgeter cap) |
| Insight cohorts | every minute | member positions, tier snapshots | `discovery.cohortWeightPerMinute` (budgeter cap); essential rank |
| Durable fill history | every minute, 2 pages | REST history per address; skips ranges the archive certifies | `discovery.historyWeightPerMinute` (budgeter cap) |
| **S3 archive ingest** | every minute | new hourly objects forward, then backfill backward; filtered to the tracked set | `S3_ARCHIVE_MAX_BYTES_PER_MINUTE`, `S3_ARCHIVE_MAX_DAILY_USD` (no Hyperliquid weight) |
| Initial backfill jobs | every 5 s | `backfill_jobs` for newly watched addresses | global |
| Backward fill backfill | every minute, one window | `fill_coverage` of watched addresses | `discovery.backfillWeightPerMinute` (budgeter cap) |
| Outbox / notifications | every 5 s | Telegram delivery (dry-run unless configured) | — |
| KOL avatars | every 30 s | one avatar fetch at most | — |
| Revenue snapshot | hourly at :07 | builder/referral revenue | global |
| Copy worker | `COPY_WORKER_INTERVAL_MS` (2 s) | paper copy execution | — |

## Worker roles: worker-copy and worker-read (2026-10-14)

From the release with `WORKER_ROLE` (feat/worker-roles), the single `worker` can be split into two services built from the same image. Design and rationale: `docs/design-hl-egress-2026-10-13.md` §2, §3, §8. Every flag defaults to today's behaviour, so deploying the release changes nothing until the variables below are set.

| Service | `IS_WORKER` | `WORKER_ROLE` | Lease | Runs |
| --- | --- | --- | --- | --- |
| `worker` (becomes worker-copy) | `true` | `copy` | (73106,1) | live copy engine, setup driver and aborts, stops, closer, settler, funding monitor, setup-due listener (NOTIFY), terminal settlement loop (testnet copy), trade feed and its check, rules |
| `worker-read` (new) | `true` | `read` | (73106,2) | scheduler (snapshots, sweep, catch-up, backfill), traders, discovery, cohorts, revenue, archive, retention, outbox, Telegram, paper copy, follower snapshots and receipts |
| one `worker`, unset | `true` | unset (`all`) | both | everything (today) |

A standby process makes no Hyperliquid call until it holds its lease (`scripts/worker-smoke.mjs`).

**Variables**

| Service | Variable | Value | Notes |
| --- | --- | --- | --- |
| worker-read | everything the worker has (DB, Telegram, archive, AWS, Hyperliquid budget, `COPY_TRADING_MODE`, `HYPERLIQUID_NETWORK`, `HYPERLIQUID_EGRESS_KEY`, …) | same as `worker` | plus `WORKER_ROLE=read`. `DATABASE_URL` must be the api's exact value (monitor key) |
| worker | `WORKER_ROLE` | `copy` | `WORKER_TERMINAL_SETTLEMENT` defaults to on for `copy` and off for `all` |
| api | `WORKER_URL` | `http://worker.railway.internal:3000` | the copy worker (feed, copy health); `/health` is 503 without it |
| api | `WORKER_READ_URL` | `http://worker-read.railway.internal:3000` | optional; snapshot, sweep, discovery and archive health come from it; `snapshots_stale` alerts after 15 min |
| api | `API_SETUP_DRIVE` | `local` → `worker` | `worker`: confirm and advance mark the setup due and `NOTIFY copy_setup_due`; the copy worker drives it (and reconciles the deposit) |
| api | `API_TERMINAL_SETTLEMENT` | `on` → `off` | turn off only after the copy worker logs "Terminal settlement loop on the worker"; with it off, the api alerts `terminal_settlement_unowned` if no copy heartbeat reports the loop on for 2 min |

Until the egress split (1b), every service keeps the same `HYPERLIQUID_EGRESS_KEY`: they still share one outbound IP. With 1b (Railway static egress on worker only) worker-copy gets its own key.

**Rollout (in this order)**

1. Back up, then deploy the release (api → worker → web) with no new variable. Nothing changes (`all`).
2. Create `worker-read` from the same source and start command, with the worker's variables plus `WORKER_ROLE=read`, restart policy **Always**. It waits on standby for lease 2 (held by `all`) and makes no Hyperliquid call. Set `WORKER_READ_URL` on the api.
3. Set `WORKER_ROLE=copy` on `worker`. Its redeploy starts a copy standby; when the old `all` exits both leases free: copy takes lease 1, worker-read takes lease 2 (about 1 s, or about 30 s after an unclean exit).
4. Check `/health` and the admin system page: the copy heartbeat shows `worker.role=copy`, `leases=[1]`, `terminalSettlement=true` (testnet copy); worker-read shows `role=read`, `leases=[2]`, fresh snapshots.
5. Set `API_SETUP_DRIVE=worker` on the api.
6. After the copy worker's log shows "Terminal settlement loop on the worker", set `API_TERMINAL_SETTLEMENT=off` on the api.

**Rollback (in this order)**

1. On the api: `API_TERMINAL_SETTLEMENT=on`, `API_SETUP_DRIVE=local` (the api must own these again before the worker becomes `all`, because `all` keeps the worker's settlement loop off).
2. Scale `worker-read` to 0 (or delete it).
3. Unset `WORKER_ROLE` on `worker` (back to `all`, both leases).
4. Unset `WORKER_READ_URL` on the api.

**Egress identity (`HL_EGRESS_IDENTITY`)**

Design §8 I-15. `off` (default), `observe` (every process learns and reports its public IPv4; nothing is gated) or `enforce` (worker-copy only: it takes no lease while its IP is unknown, outside `HL_EGRESS_EXPECTED_IPS`, or shared with a peer). `enforce` needs `HL_EGRESS_PEERS` (the api's and worker-read's internal base URLs); without one the worker refuses to start. The IP comes from `HL_EGRESS_ECHO_URLS`, by default three independent echoes tried in order (api.ipify.org, checkip.amazonaws.com, ipv4.icanhazip.com); one answering is enough, and none answering fails closed (worker-copy stays on standby with `ALERT egress_identity_lease_refused`, reason "own public IP unknown").

- Runbook: if every echo is down while deploying worker-copy under `enforce` (its log shows `egress_identity_unknown` for all three and the lease is refused), set `HL_EGRESS_IDENTITY=observe` on worker-copy. That removes the lease gate at once (the redeploy takes the lease as usual); the api's `egress_identity_shared` alert still compares the sets. Set `enforce` again once the echoes answer.

## Variables

Secrets are set in Railway per service and per environment; nothing here belongs in git. "ref" means a Railway reference variable.

### api

| Variable | Stage | Production | Notes |
| --- | --- | --- | --- |
| `IS_WORKER` | unset | unset | replaces `APP_ROLE=api` (delete `APP_ROLE`) |
| `WORKER_URL` | `http://worker.railway.internal:3000` | same pattern | the api's `/health` reads the worker here (503 without it) |
| `NODE_ENV` | `staging` | `production` | both enable production-grade validation |
| `PORT` | `3000` | `3000` | |
| `DATABASE_URL` | ref → Stage Postgres | ref → production Postgres | never the other environment's |
| `DATABASE_POOL_MAX` | unset (10) | unset (10) | the api's main pool; see "Database connections" below |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY` | Stage Privy app | production Privy app | api only |
| `AUTH_ADMIN_EMAILS` | owner's email(s) | owner's email(s) | bootstrap admins |
| `AUTH_SERVICE_TOKEN`, `AUTH_SERVICE_PERMISSIONS` | unset | unset unless a service caller exists | ≥ 32 chars when set |
| `API_CORS_ORIGINS` | `https://stage.orbie.fun` | production origin | exact origins |
| `API_TRUSTED_PROXY_CIDRS` | as set on Stage (`http-security-and-logs.md`) | same rule | explicit addresses or CIDRs only |
| `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WEIGHT_BURST` | `480` / `200` | `480` / `200` | page traffic; api + worker share one IP limit of 1,200/min and one meter whose background lane holds 840: the two rates add up to 840, rates + bursts stay under 1,200 |
| `HYPERLIQUID_EGRESS_KEY` | as set on Stage | one value per outbound IP | **required** in staging and production (startup fails without it); the same value on the api and the worker: the shared Hyperliquid quota is keyed by it |
| `HYPERLIQUID_STARTUP_PACE_SECONDS` | `60` (default) | `60` | api and worker: a new process starts with empty buckets at half its rate for this long, so a redeploy that overlaps the old instance does not double the spend on the shared IP limit |
| `HYPERLIQUID_NETWORK` | `testnet` | `testnet` until mainnet signing is approved | user wallet only |
| `COPY_TRADING_MODE` | `paper` | `paper` | `testnet`/`live` are refused at startup |

### worker

| Variable | Stage | Production | Notes |
| --- | --- | --- | --- |
| `IS_WORKER` | `true` | `true` | replaces `APP_ROLE=worker` (delete `APP_ROLE`) |
| `DATABASE_POOL_MAX` | unset (copy 20, read 10; `all` 30) | unset (same) | the worker's main pool, by `WORKER_ROLE` (its lease takes one more connection); see "Database connections" |
| `NODE_ENV`, `PORT`, `DATABASE_URL` | as api | as api | `WORKER_PORT` wins over `PORT` when set (one machine). `DATABASE_URL` must be the api's exact value: `/health/monitor` (the admin system page's worker telemetry) answers only the key the api derives from it (`src/runtime/worker-calls.ts`); with another value the page shows the worker as unavailable |
| `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WEIGHT_BURST` | `360` / `100` | `360` / `100` | 480 + 360 = 840 of 1,200. On one machine with one `.env` (local), the worker reads `HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WORKER_WEIGHT_BURST` instead (as `WORKER_PORT`); not needed on Railway. With both at 840 locally the worker alone filled the background lane: 45–136 `hyperliquid_quota_exhausted` every 10 minutes on 2026-10-04 (`shared-egress-budget.spec.ts`: 167 → 0 in a simulated 10 minutes) |
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

### Tuning (environment, worker)

The per-job weight caps, the discovery refresh/size knobs and data retention
are deploy-time variables since 2026-10-05 (they were admin settings; see
[admin-settings.md](admin-settings.md#moved-to-the-environment-and-removed-paul-2026-10-05)).
They are read at startup: change one and restart. The worker is the process
that uses them; the api reads the same names only to show them. Unset = the
default, which is what Stage and local ran with.

| Variable | Default (Stage, production) | What it bounds |
| --- | --- | --- |
| `HYPERLIQUID_POOL_PERFORMANCE_WEIGHT_PER_MIN` | `240` | the pool's `portfolio` reads (12 rows a minute): board / home / card figures |
| `HYPERLIQUID_POOL_LEDGER_WEIGHT_PER_MIN` | `100` | the pool's trade-ledger builds and refreshes (coin boards, style, last trade); 0 pauses |
| `HYPERLIQUID_COHORT_WEIGHT_PER_MIN` | `150` | 洞察 member positions |
| `HYPERLIQUID_HISTORY_WEIGHT_PER_MIN` / `HYPERLIQUID_BACKFILL_WEIGHT_PER_MIN` | `120` / `120` | durable fill-history pages / backward fill backfill |
| `DISCOVERY_LEADERBOARD_REFRESH_MINUTES` | `15` | official leaderboard import interval |
| `DISCOVERY_CANDIDATE_POOL_SIZE` | `1000` | pool size (plus every KOL) |
| `DISCOVERY_COHORT_MEMBERS_PER_TIER` / `DISCOVERY_COHORT_REFRESH_MINUTES` | `500` / `40` | members per 洞察 tier (a safety cap) / member refresh and history row spacing |
| `RETENTION_ENABLED` | `true` | the daily retention job |
| `RETENTION_SNAPSHOT_DAYS` / `RETENTION_AUDIT_DAYS` / `RETENTION_ACCOUNT_DELETION_DAYS` | `90` / `365` / `365` | snapshots / admin audit / account-deletion records (the privacy policy's periods) |
| `RETENTION_QUEUE_DAYS` / `RETENTION_ALERT_DAYS` | `30` / `30` | finished outbox rows / alert delivery records |
| `RETENTION_COPY_EQUITY_FULL_DAYS` / `RETENTION_COHORT_MEMBER_LIST_DAYS` / `RETENTION_FOLLOWER_OBSERVATION_DAYS` | `31` / `30` / `7` | paper copy valuations at full resolution (older ones thinned; not below 31) / cohort history member lists / superseded follower observations (`data-retention.md`) |
| `RETENTION_HISTORY_FILL_DAYS` | `90` | traders' stored fill history (`history_fills`, min 30); the archive backfill never goes further back |

The worker reports what it runs with on `/health/monitor` (`tuning`), shown on
the admin 總覽; `/health` → `budget.consumers` shows who spent the trailing
minute, `budget.caps` what each job is held to.

**The settings are maxima.** All five are enforced by the budgeter on what is actually sent (one-minute token buckets), and together they may take at most 75 % of the process's *effective* budget; above that they shrink in proportion. So they follow `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` and a 429 backoff without anyone editing them:

| Process budget | performance | ledgers | history | backfill | cohort | Sum | Left for snapshots, sweeps, live, pages |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ≥ 973 | 240 | 100 | 120 | 120 | 150 | 730 | budget − 730 |
| 840 (default) | 207 | 86 | 104 | 104 | 129 | 630 | 210 |
| 600 (worker) | 148 | 62 | 74 | 74 | 92 | 450 | 150 |
| 480 | 118 | 49 | 59 | 59 | 74 | 360 | 120 |
| 360 | 89 | 37 | 44 | 44 | 55 | 270 | 90 |
| 72 (the 429 floor of 360) | 18 | 7 | 9 | 9 | 11 | 54 | 18 |

Snapshots and sweeps of watched leaders and the cohort's reads go before every other job (`ESSENTIAL_RANK`: after pages, before the pool, history, backfill and unranked work), so they take what they need first: with 20 watched leaders about 16 + 53 a minute, plus the cohort's cap. A worker at 360 therefore runs everything (`budget-consumers.spec.ts`: an hour with every job saturated, every snapshot run inside 30 s, every sweep inside 3 min, no cap exceeded). Held at its 429 floor of 72 the same leaders need 69 of the 72: snapshots and sweeps still complete (sweeps in 14–15 of their 15 minutes, the first after the 429 up to two minutes over) and the pool waits; a real backoff climbs back 10 % of the budget per 20 answered calls, within minutes. The floor of a 600 worker is 120. More watched leaders need proportionally more: about 3.5 a minute each.

The cohort caps' history: `HYPERLIQUID_COHORT_WEIGHT_PER_MIN` 150 (60 before
2026-10-04), `DISCOVERY_COHORT_MEMBERS_PER_TIER` 500 (150 before; CopyDog has
no cap), `DISCOVERY_COHORT_REFRESH_MINUTES` 40 (15 before; CopyDog's rows are
~36 min apart). Every eligible pool trader of a tier (~1,130 on dev) is read
each refresh.

At the default 840/min: jobs 630 (see the table), plus the home warm-up (24 portfolios every 10 min ≈ 48), leader snapshots and sweeps (≈ 60 averaged) ≈ 750 when every job is busy, leaving ≈ 90 plus the page reserve for pages; every job scales down to a quarter of its allowance while page traffic approaches half the budget (`backgroundFactor` on `/health`). The page reserve (60 % of the burst, refilled first; `HYPERLIQUID_PAGE_RESERVE_SHARE` of the rate is its floor) is never spent by jobs. Pool freshness at 240: ≈ 480 visible rows of ≈ 1,140 are read every ≈ 54 min (median age ≈ 27 min), the rest every ≈ 3.6 h (`discovery.*AgeSeconds` on `/health`). The archive ingest spends no Hyperliquid weight.

## Database connections

Each process has one main pool (`DATABASE_POOL_MAX`; defaults in `apps/api/src/config/constants/database.ts`, each with its count): api 10, copy worker 20, read worker 10, and 30 for a single worker of role `all` (copy + read). pg opens a connection only when a query needs one and closes it after 10 s idle, so the size is a ceiling, not what a process holds. Every worker also holds one lease connection (its own pool of one). Budget against Postgres's `max_connections` (100 on Railway's PostgreSQL unless changed; `SHOW max_connections`, 3 of them reserved for superusers, so 97):

| Moment (Stage: api + copy worker + read worker) | Connections at most |
| --- | --- |
| Steady | 10 + 20 + 10 + 2 leases = 42 |
| api rolling deploy (old and new api, pre-deploy migration) | 42 + 10 + 1 = 53 |
| a worker's rolling deploy (the standby builds nothing until it owns the lease) | 42 + 1 = 43 each |
| all of the above at once | 55 |

What the pools hold (2026-10-22 count, the basis lines of the constants): the api keeps three LISTEN relays (settings, actions, copy feed) and runs the terminal settlement loop (a claim and a risk-scope connection, refused below three free); the copy worker keeps two LISTEN connections (settings, setup wake-ups), and its live engine works one order, stop, close or settlement at a time with two dedicated connections (order lock and risk scope) beside the settlement loop's two, about 13 at its busiest; the read worker keeps one LISTEN connection and runs short statements only. Before 2026-10-22 the defaults were api 20 and worker 30: 82 steady with two workers and about 103 during an api deploy, over the limit.

Raise a value only after checking that sum (plus any admin `psql` sessions) still fits. To see what a process really uses: `select application_name, state, count(*) from pg_stat_activity group by 1, 2` (`td-api`, `td-worker-copy`, `td-worker-read`).

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
3. Stage worker: `S3_ARCHIVE_ENABLED=true`, backfill off, cap US$0.5. Check the admin 總覽 (系統詳情) as an admin (or `GET /admin/system/overview`; the public `/health` no longer carries it) → `archive.lagSeconds`, `archive.fillsKept`, `archive.lastError: null`.
4. Run the reconciliation against Stage's data. Archive-origin fills must equal REST tid by tid.
5. Production: same steps with its own IAM user; then backfill on, cap US$2 until `archive.addresses.pending` reaches 0.

## Deploy gates (process finding P-1, 2026-10-14)

ac8e81e1 reached Stage with CI red. The deploy script's `[[ "$c" == success ]]` printed `CI failure` and carried on, because macOS's bash 3.2 does not exit on a failed `[[ ]]` under `set -e`. Every deploy script follows these rules:

1. Every gate is written as `cond || exit 1` and never relies on `set -e`. This covers CI, the backup checkpoint, the in-flight guard and each deployment's status.
2. The CI gate passes only when the run concluded `success` and **every job** concluded `success` or `skipped`. `skipped` means the workflow's own path filter decided not to run the job, for example browser shards when no web file changed. A cancelled job (such as an api shard cancelled after another shard failed) counts as not passed, and so does any other conclusion.
3. Before deploying, the script prints the CI run URL and each job's conclusion. That output is kept in the gate record.
4. Parse, don't pattern-match (2026-10-18). A gate that reads remote output accepts only the exact shape it expects and refuses anything else, including an empty or unreadable answer. On 2026-10-18 Stage's Postgres had been stopped by the Railway usage limit; the SSH endpoint answered with Railway's own status JSON, and the in-flight guard, which only looked for one line starting with `{`, printed it as the snapshot. In practice:
   - the in-flight guard requires all seven counts as integers and refuses on any non-zero count;
   - the variable check requires the service's own variable map (`RAILWAY_SERVICE_ID` and `RAILWAY_ENVIRONMENT_ID` equal to the ones asked for) before it reads a name from it;
   - the checkpoint check requires the backup listing to be a list before searching it;
   - the CI gate requires a numeric run id and a non-empty job list.

## Rollback

`S3_ARCHIVE_ENABLED=false` stops downloads at once; stored fills stay valid and REST resumes full scans from its own checkpoints (`S3_ARCHIVE_TRUST=none` forces that even while ingest continues). Migration `0017` is additive, so the previous image runs against the migrated schema.
