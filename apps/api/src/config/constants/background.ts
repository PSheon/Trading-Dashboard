/**
 * The cadence, windows and back-offs of the background jobs: the watcher, the sweeps, the discovery pool, the ingest, the workers.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';

/** basis: guessed — the discovery pool is rebuilt every 10 min (KOL edits) and after every leaderboard import; verify: none needed
 */
export const POOL_REBUILD_MS = 10 * MINUTE_MS;

/** basis: guessed — a pool row that failed waits 15 min; verify: none needed
 */
export const POOL_RETRY_BACKOFF_MS = 15 * MINUTE_MS;

/** basis: derived — under the minute cron, so ticks never overlap (discovery pool and cohorts)
 */
export const TICK_WORK_MS = 50_000;

/** basis: guessed — a visible row is refreshed four times as often as the rest; verify: board freshness vs budget on Stage
 * Visible: boards, home rows, KOLs, followed traders.
 */
export const POOL_VISIBLE_WEIGHT = 4;

/** basis: guessed — the visible set is recomputed at most every minute; verify: none needed
 */
export const POOL_VISIBLE_TTL_MS = 60_000;

/** basis: guessed — a row's trade ledger is refreshed once an hour old; verify: none needed
 * Incrementally (coin boards and the stocks top 100 show ledger figures).
 */
export const LEDGER_REFRESH_MS = HOUR_MS;

/** basis: guessed — half of the ledger loop's allowance for incremental refreshes while cold builds wait; verify: cold-build backlog on Stage
 * The rest (and what refreshes don't use) builds ledgers for rows that have none.
 */
export const POOL_LEDGER_REFRESH_SHARE = 0.5;

/** basis: guessed — a 429's pause is clamped to at least 5 min … (verify: none needed)
 */
export const AVATAR_MIN_PAUSE_MS = 5 * MINUTE_MS;

/** basis: guessed — … and at most a day; verify: none needed
 */
export const AVATAR_MAX_PAUSE_MS = DAY_MS;

/** basis: guessed — a missing picture is looked for again a day later; verify: none needed
 */
export const AVATAR_NOT_FOUND_RETRY_MS = DAY_MS;

/** basis: guessed — a failure retries after 15 min, doubling to a day; verify: none needed
 */
export const AVATAR_ERROR_RETRY_MS = 15 * MINUTE_MS;

/** basis: guessed — a cached avatar is fetched again after a week; verify: none needed
 */
export const AVATAR_REFRESH_MS = 7 * DAY_MS;

/** basis: derived — under the minute cron: a tick stops starting objects after 45 s
 */
export const ARCHIVE_TICK_BUDGET_MS = 45_000;

/** basis: measured — hourly archive files rotate on the node's clock; a fill near the boundary may sit in the neighbouring file
 * A span is certified only this far inside the hours actually ingested;
 * REST re-reads the margins (duplicates collapse on the tid key).
 */
export const ARCHIVE_BOUNDARY_MARGIN_MS = 5 * MINUTE_MS;

/** basis: guessed — an address out of the tracked set for a week is no longer ingested; verify: count of coverage rows dropped vs re-queued per week on Stage
 * The pool (15 min) and cohorts (40 min) are rebuilt all day, so an address
 * at their edge leaves and returns; within this grace it keeps its span (and
 * is still ingested). After it, its archive_coverage row is deleted.
 */
export const ARCHIVE_UNTRACKED_GRACE_MS = 7 * DAY_MS;

/** basis: guessed — every dex of a cohort member is swept daily; verify: none needed
 * In between, only the main dex and the dexes it holds or has traded.
 */
export const COHORT_SWEEP_MS = DAY_MS;

/** basis: guessed — a cohort member whose read failed retries after 5 min; verify: none needed
 * Capacity refusals instead pause the whole job until the release hint.
 */
export const COHORT_FAILURE_RETRY_MS = 5 * MINUTE_MS;

/** basis: derived — one retention run a day: not repeated within 20 h
 */
export const RETENTION_MIN_INTERVAL_MS = 20 * HOUR_MS;

/** basis: guessed — a closed socket lease is kept a day after closed_at (nothing reads it); verify: none needed
 * The meter counts nonclosed leases only, and a request naming a closed or
 * missing lease is refused the same way (hyperliquid_quota_lease_lost).
 */
export const CLOSED_WS_LEASE_RETENTION_MS = DAY_MS;

/** basis: guessed — 5,000 history_fills rows per DELETE, picked through (account_id, time); verify: the first Stage runs' retention.run audit (rows, ms) against statement_timeout 15 s
 * One statement deletes the oldest rows below the cut of one or more accounts
 * (ascending account id); the retention job pauses at least as long as each
 * statement took, so it holds the database at most half of its time.
 */
export const HISTORY_RETENTION_BATCH_LIMIT = 5_000;

/** basis: derived — HISTORY_RETENTION_BATCH_LIMIT × 20 statements per hourly expiry pass
 * The fills of expired history jobs deleted right away; what is left (a
 * heavy account) is unreachable and the retention job's next sweep ends it.
 */
export const EXPIRED_FILLS_PURGE_LIMIT = 20 * HISTORY_RETENTION_BATCH_LIMIT;

/** basis: guessed — an egress address not seen for a day leaves the set (a pool address may move to another tenant); verify: observe week publicIps
 */
export const EGRESS_IP_TTL_MS = DAY_MS;

/** basis: measured — 2026-10-12: a DB outage made the worker exit within 3 s of every start and use up Railway's restarts; 10 min outlasts it
 * How long the worker keeps retrying while it cannot use Postgres before it
 * exits, so an outage does not use up Railway's restart retries.
 */
export const WORKER_DB_RETRY_WINDOW_MS = 10 * MINUTE_MS;

/** basis: guessed — the worker's DB retry starts at 1 s … (verify: none needed)
 */
export const WORKER_LEASE_BACKOFF_MIN_MS = 1_000;

/** basis: guessed — … doubling to 30 s; verify: none needed
 */
export const WORKER_LEASE_BACKOFF_MAX_MS = 30_000;

/** basis: guessed — a standby asks for the lease every second; verify: none needed
 */
export const WORKER_LEASE_POLL_MS = 1_000;

/** basis: guessed — a reconcile re-reads a minute of overlap; verify: none needed
 */
export const SNAPSHOT_RECONCILE_OVERLAP_MS = 60_000;

/** basis: derived — under the 5 min snapshot period: a call that waited 4 min for the budget fails instead of holding the next run
 */
export const SNAPSHOT_QUEUE_MS = 4 * MINUTE_MS;

/** basis: derived — under the 15 min sweep period
 */
export const SWEEP_QUEUE_MS = 14 * MINUTE_MS;

/** basis: guessed — the settings relay reconnects after a second; verify: none needed
 */
export const SETTINGS_RELAY_RETRY_MS = 1000;

/** basis: guessed — jobs nobody asks for are looked for hourly; verify: none needed
 */
export const ANALYSIS_JOB_EXPIRE_EVERY_MS = HOUR_MS;

/** basis: guessed — an analysis job is deleted two weeks after it was last asked for; verify: none needed
 * With its fills.
 */
export const REQUESTED_JOB_TTL_MS = 14 * DAY_MS;

/** basis: guessed — a watched address whose refresh failed is left out from 2 min, doubling … (verify: none needed)
 * Doubles per consecutive failure; a success clears it.
 */
export const TRACKED_BACKOFF_BASE_MS = 2 * MINUTE_MS;

/** basis: guessed — … up to an hour; verify: none needed
 */
export const TRACKED_BACKOFF_MAX_MS = HOUR_MS;

/** basis: guessed — a watched address's funding is read at most hourly; verify: none needed
 */
export const TRACKED_FUNDING_EVERY_MS = HOUR_MS;

/** basis: guessed — analytics read a year of fills; verify: none needed
 */
export const ANALYTICS_LOOKBACK_MS = 365 * DAY_MS;

/** basis: derived — ANALYTICS_LOOKBACK_MS
 * Read 40 pages per step; a long history completes over the next refreshes.
 */
export const FUNDING_LOOKBACK_MS = ANALYTICS_LOOKBACK_MS;

/** basis: derived — a year, as analytics read; REST retention starts there
 * Backward backfill stops at this age. Paced by
 * `HYPERLIQUID_BACKFILL_WEIGHT_PER_MIN`; the span is read in pages
 * (`storedFillPages`), so its size is not bounded by memory (audit A2).
 */
export const BACKFILL_LOOKBACK_MS = 365 * DAY_MS;

/** basis: guessed — an address that used a TWAP in the last 48 h gets its slices read by the sweep; verify: none needed
 */
export const TWAP_ACTIVE_MS = 48 * HOUR_MS;

/** basis: measured — what the start-up sweep used to re-read for everyone (75 min)
 * Where an address with no verified span yet starts.
 */
export const INITIAL_LOOKBACK_MS = 75 * MINUTE_MS;

/** basis: guessed — 60 s, a settlement safety bound (fills are stamped early and published late); lower-bound sample: mainnet 2026-10-14, one address, 10 min, p99 3.75 s, max miss 6.3 s; lower only with >= 24 h of samples from >= 3 addresses (one high-frequency), new value >= 4x the largest observed miss, basis then measured with the samples attached; verify: gate 11 fill index lag p99
 * A completed read certifies fills only up to this long before it was sent.
 */
export const INDEX_LAG_MS = 60_000;

/** basis: guessed — a backfill page spans at least a minute … (verify: none needed)
 */
export const FILL_SYNC_MIN_SPAN_MS = 60_000;

/** basis: guessed — … and at most 30 days; verify: none needed
 */
export const FILL_SYNC_MAX_SPAN_MS = 30 * DAY_MS;

/** basis: guessed — a live sync reuses account state under 10 s old; verify: none needed
 * Equity for R1/R3; not when the action opened a position the cached state
 * doesn't have yet.
 */
export const FILL_SYNC_ACCOUNT_REUSE_MS = 10_000;

/** basis: derived — a state is fetched fresh within the 20 s request timeout; two minutes of feed trades cover a late install
 * How long an address's feed trades are kept for replaying onto a newly
 * installed state.
 */
export const BOOK_BUFFER_MS = 2 * MINUTE_MS;

/** basis: guessed — a ping every 30 s keeps the feed socket alive; verify: none needed
 */
export const FEED_PING_INTERVAL_MS = 30_000;

/** basis: derived — three missed pings (FEED_PING_INTERVAL_MS) mean a dead socket
 */
export const FEED_STALE_AFTER_MS = 90_000;

/** basis: guessed — a replayed trade older than a minute is left to the sweeps; verify: none needed
 * Subscribing replays recent trades, which can be hours old: a (re)connect
 * must never raise alerts on them.
 */
export const MAX_TRADE_AGE_MS = 60_000;

/** basis: guessed — fills of one coin and side within a second form one action; verify: none needed
 * Fills → `actions` (PRD §4.2 W3): fills of the same coin, side and
 * liquidation status, each within this of the previous, form one action.
 * Its kind comes from `startPosition` before the first fill and after the last:
 * before = 0, after ≠ 0            → open
 * before ≠ 0, after = 0            → close
 * signs differ, both ≠ 0           → flip
 * same sign, |after| > |before|    → add
 * same sign, |after| < |before|    → reduce
 * any fill liquidates this address → liquidation
 * Side is the position's side: after the action for open/add/flip, before
 * it for reduce/close/liquidation.
 */
export const GROUP_GAP_MS = 1000;

/** basis: measured — live 2026-09-29: the fill index has a feed trade within p50 0.6 s, p90 1.5 s
 * The first confirm waits this long.
 */
export const CONFIRM_DELAY_MS = 2_000;

/** basis: guessed — confirms of one address start at least 15 s apart (one userFillsByTime per 15 s, not per trade); verify: none needed
 */
export const CONFIRM_MIN_INTERVAL_MS = 15_000;

/** basis: guessed — a fill not returned yet is looked for after 5 s, 15 s and 60 s; verify: fillsUnavailable rate on Stage
 * Then the address is listed as `fillsUnavailable`.
 */
export const CONFIRM_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

/** basis: guessed — a confirm starts reading 10 s before the first trade; verify: none needed
 * Trade and fill times share the exchange clock: this only catches fills of
 * the same order that landed just before.
 */
export const CONFIRM_LOOKBACK_MS = 10_000;

/** basis: guessed — the watched set is refreshed every 15 s; verify: none needed
 */
export const WATCHED_REFRESH_MS = 15_000;

/** basis: guessed — a copied leader's verified span is caught up every 2 min; verify: none needed
 * Besides the quarter-hourly sweeps; its copy stream is audited after each.
 */
export const COPIED_CATCH_UP_MS = 2 * MINUTE_MS;

/** basis: guessed — a feed that failed to start is retried after 30 s; verify: none needed
 */
export const FEED_START_RETRY_MS = 30_000;

/** basis: guessed — a delivery retries after 1 s, 2 s and 4 s (four attempts in all); verify: none needed
 */
export const NOTIFY_RETRY_DELAYS_MS = [1000, 2000, 4000];

/** basis: guessed — one drain call stops reading new batches after 30 s; verify: none needed
 */
export const DELIVERY_DRAIN_BUDGET_MS = 30_000;

/** basis: guessed — a favorite alert fires at most once per (user, trader, coin) in 10 s; verify: none needed
 * Stops a trader who fires several orders in a row from sending a burst.
 */
export const FAVORITE_BURST_GUARD_MS = 10_000;

/** basis: guessed — a backfill job is given up after 3 attempts; verify: none needed
 */
export const BACKFILL_MAX_ATTEMPTS = 3;
