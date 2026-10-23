# Railway deployment

2026-10-01, revised 2026-10-23 to the decisions in `decisions-2026-10-23.md` (D1–D4, D12, D13). How Orbie runs on Railway: the services, their variables, the worker's schedules, storage, and how Stage and production stay apart. It collects what `worker-deployment.md`, `container-delivery.md` and `backup-and-restore.md` established and adds the S3 archive ingest (`s3-archive-ingest.md`).

Read-only check for this document: `railway status` → workspace "Paul's Projects", project **Orbiefun** (`a04669bd-cefb-40bc-96ef-f9d984da6817`), environment **Stage** (`2ed38f77-b0ad-498f-aba1-6d57f55cf288`), linked service `web`. No Railway command that creates or changes anything was run, variables were not read, and nothing in this document has been applied to Railway.

## Services

One project, one environment per stage, five services per environment once the read worker is deployed (D12, being deployed): three Node processes from one image (`api`, `worker` = worker-copy, `worker-read`), `web` and `Postgres`. `api` and the workers are the same image and the same start command (`node dist/main.js`); `IS_WORKER=true` makes a process a worker and `WORKER_ROLE` picks what it runs (2026-10-04, as in DonutMe; `APP_ROLE` and `dist/worker.js` are gone, and a process that still has `APP_ROLE` refuses to start).

| Service | Source | Start | Public | Health check |
| --- | --- | --- | --- | --- |
| `web` | Railpack; build `shared` then `web` | `pnpm --filter @trading-dashboard/web exec next start --hostname :: --port 3000` | Yes (`stage.orbie.fun`) | as configured in Railway |
| `api` | `apps/api/Dockerfile` (`apps/api/railway.json`) | `node dist/main.js`, pre-deploy `node scripts/migrate.mjs` | No: reached by `web` over the private network (`/api/hl/*` proxy) | `/health/ready` |
| `worker` (worker-copy) | same image as `api`, `IS_WORKER=true`, `WORKER_ROLE=copy` | `node dist/main.js` (the Dockerfile's default; no custom start command) | No (`worker.railway.internal:3000`) | `/health/live` (liveness); `/health/ready` is 503 while standby |
| `worker-read` | same image, `IS_WORKER=true`, `WORKER_ROLE=read`; its own outbound IP (D12) | `node dist/main.js` | No (`worker-read.railway.internal:3000`) | as `worker` |
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
| `worker` (becomes worker-copy) | `true` | `copy` | (73106,1) | live copy engine (it settles every terminal order itself, on both networks: D13), setup driver and aborts, stops, closer, funding monitor, setup-due listener (NOTIFY), trade feed and its check, rules |
| `worker-read` (new) | `true` | `read` | (73106,2) | scheduler (snapshots, sweep, catch-up, backfill), traders, discovery, cohorts, revenue, archive, retention, outbox, Telegram, paper copy, follower snapshots and receipts |
| one `worker`, unset | `true` | unset (`all`) | both | everything (today) |

A standby process makes no Hyperliquid call until it holds its lease (`scripts/worker-smoke.mjs`).

**Variables**

| Service | Variable | Value | Notes |
| --- | --- | --- | --- |
| worker-read | everything the worker has (DB, Telegram, archive, AWS, Hyperliquid budget, `COPY_TRADING_MODE`, `HYPERLIQUID_NETWORK`, `HYPERLIQUID_EGRESS_KEY`, …) **except the Privy variables** (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AGENT_AUTHORIZATION_KEY`, `PRIVY_AGENT_WORKER_QUORUM_ID`, `PRIVY_VERIFICATION_KEY`: it never signs or verifies, and ignores a set one with one startup warning) | same as `worker` | plus `WORKER_ROLE=read`. `DATABASE_URL` must be the api's exact value (monitor key) |
| worker | `WORKER_ROLE` | `copy` | |
| api | `WORKER_URL` | `http://worker.railway.internal:3000` | the copy worker (feed, copy health); `/health` is 503 without it |
| api | `WORKER_READ_URL` | `http://worker-read.railway.internal:3000` | optional; snapshot, sweep, discovery and archive health come from it; `snapshots_stale` alerts after 15 min |
| api | `API_SETUP_DRIVE` | `local` → `worker` | `worker`: confirm and advance mark the setup due and `NOTIFY copy_setup_due`; the copy worker drives it (and reconciles the deposit) |
| api | (no settlement switch) | | the api never settles (D13, 2026-10-23); on a live copy deployment it alerts `terminal_settlement_unowned` if no copy worker heartbeat reports its live engine running (`worker.terminalSettlement`) for 2 min |

Every service keeps the same `HYPERLIQUID_EGRESS_KEY`. The copy side (api and worker-copy) charges it as one shared meter; worker-read derives its own meter key from it (`<key>:read`, next section). With 1b (Railway static egress on worker-copy only) worker-copy may get its own key.

**Read worker meter (decision D12, 2026-10-23)**

Hyperliquid limits REST weight per public IP (1,200 a minute) and each Railway service has its own IP, so one meter for all three processes starved the read worker (its discovery, cohort and history refreshes were refused `hyperliquid_quota_exhausted` more than 1,700 times a log window beside the copy side's priorities). From this release worker-read charges its **own** meter row, `<HYPERLIQUID_EGRESS_KEY>:read` (testnet host `<key>:read:testnet`), 1,200 a minute, with background capped at 900 (`READ_WORKER_BACKGROUND_REST_CAP`) and 300 kept above it (`READ_WORKER_PAGE_RESERVE`). The copy side keeps the shared meter and its lanes unchanged. The key is derived, never a second variable, and a process can only charge its own meter: `PostgresHyperliquidQuota` refuses the other meter's key (`hyperliquid_quota_meter_foreign`) before any round trip.

What "page reads" means here: `page:` tickets (`isPageWork`: a background-priority read ranked ≤ `PAGE_RANK.fills`, made to answer someone's HTTP request, sent through `fetchPageInfo`). The api makes the web's page reads itself, on the shared meter, as before (nothing is forwarded to worker-read). On the read meter the 300 therefore serve worker-read's own on-demand reads: its page-ranked reads (the cohort's BTC candles at `PAGE_RANK.portfolio`, a leader's recent activity at `PAGE_RANK.fills`) and its owned live-lane reads (follower snapshots and receipts), never its discovery, history or analytics loops.

| Service | Variable | Value | Notes |
| --- | --- | --- | --- |
| worker-read | `HYPERLIQUID_READ_METER` | unset (`own`) | `own`: its own meter `<key>:read`, cap 900 / reserve 300. `shared`: back on the shared meter with the copy side's priorities, as before D12 (the rollback). Refused on any other service |
| worker-read | `HYPERLIQUID_BACKGROUND_REST_CAP` | **delete** | the read meter's cap is the constant (900); a value copied from the copy side (a canary's 400) is refused at startup under `own` |
| worker-read | `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WEIGHT_BURST` | **delete** (defaults to 900 / 900 under `own`) | its local bucket may spend what the meter's background cap allows; a set value may lower it, never raise it above 900. Under `shared` the worker defaults apply again (360 / 100 as set) |
| api | `WORKER_READ_URL` | as above | the api reads the read worker's heartbeat (`meter`, `egressIdentity`) for the alert and the overview |

Observability: the worker heartbeat's `meter` (`{meter, egressKey, backgroundCap, reserved}`) and its lanes are that worker's meter; the admin overview's `api.meters` shows both rows (the copy side's with the api's cap, `<key>:read` with 900) with what each class of charge holds. `egress_identity_shared` now alerts on **any** pair of the api, worker-copy and worker-read sharing a public IP (`pairs`: `copy-api`, `copy-read`, `read-api`): then the two meters are one limit at Hyperliquid and the split is unsafe.

24 h verification (D12, D19): after the deploy run `scripts/ops/hl-meter-usage.mjs` (read only: one `READ ONLY` transaction per sample, rolled back; it prints the keys as `<key>` / `<key>:read`, never the connection string) from a shell that reaches the database and the workers' private network, e.g. `DATABASE_URL=… WORKER_URL=http://worker.railway.internal:3000 WORKER_READ_URL=http://worker-read.railway.internal:3000 node scripts/ops/hl-meter-usage.mjs --samples 1440 --interval 60 > meter-24h.jsonl`. Each line has both meters' lane usage and each worker's `rateLimited` (every 429 since start) and `foreignSuspected` (429s while our own meter held under 80 %). Expected: the read meter's background sits near 900 with its page and live lanes never refused, and neither IP's 429 count grows while our own meter is under the window; trader cards fresh and the coin-icon route 200 (D19). If 429s appear on either IP while its own meter is well under 1,200, Hyperliquid counts the two IPs together: roll back.

Rollback (one switch): set `HYPERLIQUID_READ_METER=shared` on worker-read (and restore its `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WEIGHT_BURST` to the worker's 360 / 100 so the shared background lane stays at 840). Its redeploy charges the shared meter again; the `<key>:read` row simply expires (65 s) and may stay in the table.

**Rollout (in this order)**

1. Back up, then deploy the release (api → worker → web) with no new variable. Nothing changes (`all`).
2. Create `worker-read` from the same source and start command, with the worker's variables plus `WORKER_ROLE=read`, restart policy **Always**. It waits on standby for lease 2 (held by `all`) and makes no Hyperliquid call. Set `WORKER_READ_URL` on the api.
3. Set `WORKER_ROLE=copy` on `worker`. Its redeploy starts a copy standby; when the old `all` exits both leases free: copy takes lease 1, worker-read takes lease 2 (about 1 s, or about 30 s after an unclean exit).
4. Check `/health` and the admin system page: the copy heartbeat shows `worker.role=copy`, `leases=[1]`, `terminalSettlement=true` (its live engine runs); worker-read shows `role=read`, `leases=[2]`, fresh snapshots.
5. Set `API_SETUP_DRIVE=worker` on the api.

**Rollback (in this order)**

1. On the api: `API_SETUP_DRIVE=local` (the api must own setups again before the worker becomes `all`).
2. Scale `worker-read` to 0 (or delete it).
3. Unset `WORKER_ROLE` on `worker` (back to `all`, both leases).
4. Unset `WORKER_READ_URL` on the api.

**Egress identity (`HL_EGRESS_IDENTITY`)**

Design §8 I-15. `off` (default), `observe` (every process learns and reports its public IPv4; nothing is gated) or `enforce` (worker-copy only: it takes no lease while its IP is unknown, outside `HL_EGRESS_EXPECTED_IPS`, or shared with a peer). `enforce` needs `HL_EGRESS_PEERS` (the api's and worker-read's internal base URLs); without one the worker refuses to start. The IP comes from `HL_EGRESS_ECHO_URLS`, by default three independent echoes tried in order (api.ipify.org, checkip.amazonaws.com, ipv4.icanhazip.com); one answering is enough, and none answering fails closed (worker-copy stays on standby with `ALERT egress_identity_lease_refused`, reason "own public IP unknown").

- Runbook: if every echo is down while deploying worker-copy under `enforce` (its log shows `egress_identity_unknown` for all three and the lease is refused), set `HL_EGRESS_IDENTITY=observe` on worker-copy. That removes the lease gate at once (the redeploy takes the lease as usual); the api's `egress_identity_shared` alert still compares the sets. Set `enforce` again once the echoes answer.

## Live leg events (worker-copy log)

Beside its prose lines, worker-copy logs one JSON line per dispatch-row transition (`apps/api/src/copy/live/live-leg-event.ts`), exactly once per write that changed a leg's state or reason:

`{"ev":"copy_leg","legId","strategyId","accountId","leader","coin","leg":"open|close","from":"pending|submitted","to":"pending|submitted|settled|refused|waiting","reason","attempt","ms","corr"}`

- `legId` = `copy_live_dispatches.id`; `corr` = the leader fill id (`copy_live_dispatches.source_fill_id` = `copy_live_source_fills.id`), shared by every leg and copy of that fill: what `scripts/ops/copy-acceptance.mjs` joins on.
- `to: waiting` is the same state with a new reason (`live_risk_source_not_ready`, a retry, a pending settlement); `reason` and `attempt` are the row's after the write; `ms` is elapsed since the leader's fill.
- No wallet ids, account addresses or execution keys.

## Variables

Secrets are set in Railway per service and per environment; nothing here belongs in git. "ref" means a Railway reference variable.

**Which variable belongs on which service is `config/services.json`** (names and rules only, never a value): for `api`, `worker-copy` (the Railway service `worker`), `worker-read` and `web`, every variable with `required` or `optional`, the services where it is **forbidden** (refused at startup, a secret the service never uses, retired) and `sameAs` (the services whose value must be identical). `scripts/ops/services-manifest.test.mjs` (CI `checks`) keeps it true to `apps/api/src/config/runtime-config.ts` and the web's `process.env` reads: a name no code reads, or a read the manifest lacks, fails CI. Before and after changing a service's variables, run the read-only checker on the services' variable **names** (it never calls Railway and never sees a value; its header shows the `railway variables --json | node -e '…Object.keys…'` pipeline):

```
node scripts/ops/services-manifest.mjs --names-from names.tsv   # one `service<TAB>NAME` per line
```

It prints, per service, missing required names, present forbidden names (with the reason) and names the manifest does not know.

Each variable's purpose, bounds and default are in the manifest and in `.env.example`. What the manifest cannot express:

- **Stage vs production.** `NODE_ENV` is `staging` on Stage and `production` in production (both enable the production-grade checks); every identity is per environment (D2): its own Privy app (`PRIVY_*`, the web's `NEXT_PUBLIC_PRIVY_APP_ID`), database, Telegram bot and AWS IAM user, and `DATABASE_URL` is a ref to that environment's Postgres, never the other's. Both are `HYPERLIQUID_NETWORK=mainnet`, `COPY_TRADING_MODE=live` (D1, D6).
- **Budgets.** The api and worker-copy share one outbound IP's 1,200/min and one meter whose background lane is `HYPERLIQUID_BACKGROUND_REST_CAP` (840): their two rates must add up to it (Stage: api 480, worker-copy 360), rates plus bursts stay under 1,200. **A worker on the mainnet wallet network reads `HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WORKER_WEIGHT_BURST`** (defaults `MAINNET_WORKER_WEIGHT`, 360 / 840) **and ignores `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN` / `HYPERLIQUID_WEIGHT_BURST`**; worker-read on its own meter (D12, above) defaults to 900 / 900 and a set value may only lower them. `COPY_LIVE_WEIGHT_PER_MIN` is at most 485 on the api and the workers alike.
- **Telegram.** One bot per environment; exactly one process polls it (worker-read): `TELEGRAM_BOT_POLLING=false` on every other process that carries the token. The api needs the token and username for the `/me/telegram` link flow; every process sends alerts through it. `TELEGRAM_DRY_RUN` is `true` until alerts go live.
- **Live copy on every process.** The code requires `HYPERLIQUID_EGRESS_KEY` and `COPY_LIVE_ALLOWED_PRIVY_USER_IDS` on any process whose `COPY_TRADING_MODE` is `live`, and `PRIVY_AGENT_AUTHORIZATION_KEY` + `PRIVY_AGENT_WORKER_QUORUM_ID`, `PRIVY_APP_ID` + `PRIVY_APP_SECRET` on the processes that sign: the api (setups under `API_SETUP_DRIVE=local`, user flows) and worker-copy. worker-read never signs: it starts under `live` without any `PRIVY_*` variable, and a set one is ignored with one startup warning naming it (remove it from the service).
- **Archive.** `S3_ARCHIVE_*` and `AWS_*` live on worker-read only (the api and worker-copy never download). Stage: `S3_ARCHIVE_MAX_DAILY_USD=0.5`, `S3_ARCHIVE_BACKFILL_ENABLED=false` (live hours only); production: `2` during backfill then `0.5`, backfill on. `S3_ARCHIVE_TRUST=all` only after a TWAP reconciliation. Rollout: "Releasing the archive ingest" below.
- **Leftovers to delete.** `APP_ROLE` (replaced by `IS_WORKER`), `COPY_LIVE_TEST_MIN_FLOOR_MAX_USD` (retired, D6; ignored), `COPY_LIVE_FIXED_PER_TRADE_MIN_USD` / `_MAX_USD` (ignored under `live`), and on worker-read `HYPERLIQUID_BACKGROUND_REST_CAP` (refused under `HYPERLIQUID_READ_METER=own`).
- **web.** `NEXT_PUBLIC_*` values are compiled in: changing one needs a rebuild, not a restart. `NEXT_PUBLIC_API_FIXTURES` must never be `1` on a deployed web; `NEXT_TEST_MODE` and `NEXT_DEV_LAB` are never set there.

### Tuning (environment, worker-read)

The per-job weight caps (`HYPERLIQUID_*_WEIGHT_PER_MIN`), the discovery knobs (`DISCOVERY_*`) and data retention (`RETENTION_*`) are deploy-time variables since 2026-10-05 (they were admin settings; see [admin-settings.md](admin-settings.md#moved-to-the-environment-and-removed-paul-2026-10-05)). They are read at startup: change one and restart. worker-read runs the jobs; the api reads the same names only to show them. Unset = the default (manifest and `.env.example`), which is what Stage and local ran with. The retention periods are what the privacy policy (§6) states; `RETENTION_HISTORY_FILL_DAYS` is at least 30 (the trader figures' 30-day window) and the archive backfill never goes further back.

The worker reports what it runs with on `/health/monitor` (`tuning`), shown on
the admin 總覽; `/health` → `budget.consumers` shows who spent the trailing
minute, `budget.caps` what each job is held to.

**The settings are maxima.** All five are enforced by the budgeter on what is actually sent (one-minute token buckets), and together they may take at most 75 % of the process's *effective* budget; above that they shrink in proportion. So they follow the process's weight rate and a 429 backoff without anyone editing them:

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

What the pools hold (2026-10-22 count, the basis lines of the constants; settlement moved to the worker alone on 2026-10-23, D13): the api keeps three LISTEN relays (settings, actions, copy feed) and otherwise runs request handlers' short queries only (no settlement loop, so no connection is reserved for a claim: 3 + 7 for requests); the copy worker keeps two LISTEN connections (settings, setup wake-ups), and its live engine works one order, stop, close or settlement at a time with two dedicated connections (order lock and risk scope), about 10 at its busiest; the read worker keeps one LISTEN connection and runs short statements only. Before 2026-10-22 the defaults were api 20 and worker 30: 82 steady with two workers and about 103 during an api deploy, over the limit.

Raise a value only after checking that sum (plus any admin `psql` sessions) still fits. To see what a process really uses: `select application_name, state, count(*) from pg_stat_activity group by 1, 2` (`td-api`, `td-worker-copy`, `td-worker-read`).

## Volumes and storage

- Only Postgres has a volume. api, worker and web are stateless; the archive ingest streams objects through memory (one decoded block, at most 4 MiB, plus a batch of rows) and writes nothing to disk.
- Size the Postgres volume for `history_fills`: about 209 bytes per fill with indexes after migration 0021 (dev: 5.89 M fills = 1.23 GB; ≈ 218 for archive rows). See `docs/s3-archive-ingest.md` for the 90-day figure. Watch the volume after enabling backfill; Railway volumes can be grown, not shrunk.
- `archive_ingest_state` and `archive_coverage` are small but are the only record of what was ingested: they are part of the normal database backup. Losing them means re-reading (and re-paying for) the archive; the fills themselves would deduplicate.
- Back up before every release that carries a migration (`backup-and-restore.md`).

## Stage and production

Decisions D1–D5 (`decisions-2026-10-23.md`):

- Stage (`stage.orbie.fun`, D3) is Paul's real-money pre-release test environment, mainnet and live copies, opened to Paul alone by the sign-up whitelist (D1). It exists today: api + worker + web + `Postgres-PbuT`, worker-read being added (D12).
- Production (`orbie.fun`, D3) is deferred until Stage has run every test. When it is built it is the identical stack from the same code, only the environment variables differ; the only path to a Production release is the same commit having passed the Stage gates and Paul's real-money test. Until then only the Stage set exists.
- Identities and keys are entirely separate per environment (D2): its own Privy app (users, wallets, signing quorum), database, Telegram bot and AWS IAM user. A variable is never shared by reference across environments; Stage data is never copied to Production.
- Railway usage limit (D4): $80 until Production exists, then $120 for both, adjusted after measuring real usage.
- Stage keeps the same data retention as Production (D5): 90 days of fill history, not cut shorter to save money.
- Promotion: a release is deployed to Stage, migrated, and checked (`/health/ready`, `/health`, the pages in a browser, and for data changes the reconciliation in `s3-archive-ingest.md`). The same commit is then deployed to Production.
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
