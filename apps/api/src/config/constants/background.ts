/**
 * The cadence, windows and back-offs of the background jobs: the watcher, the sweeps, the discovery pool, the ingest, the workers.
 *
 * Every constant states its basis on the first comment line (AGENTS.md):
 * measured (a gate, a harness or the provider's docs), derived (from another
 * constant), copied (from another check, with no reason of its own) or
 * guessed (a number that looked right; it says how it will be verified).
 * test/tuning-constants.spec.ts keeps every tuning constant here, unique,
 * with its basis.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';

/** basis: guessed — the discovery pool is rebuilt every 10 min (KOL edits) and after every leaderboard import; verify: none needed
 * Rebuild the pool at least this often (KOL edits), and after every
 * leaderboard import.
 */
export const POOL_REBUILD_MS = 10 * MINUTE_MS;

/** basis: guessed — a pool row that failed waits 15 min; verify: none needed
 * A row attempted this recently (a failure) waits before its next try.
 */
export const POOL_RETRY_BACKOFF_MS = 15 * MINUTE_MS;

/** basis: derived — under the minute cron, so ticks never overlap (discovery pool and cohorts)
 * A tick spends at most this long, so ticks never overlap.
 */
export const TICK_WORK_MS = 50_000;

/** basis: guessed — a visible row is refreshed four times as often as the rest; verify: board freshness vs budget on Stage
 * A visible row (boards, home rows, KOLs, followed traders) is refreshed
 * this many times as often as the rest of the pool.
 */
export const POOL_VISIBLE_WEIGHT = 4;

/** basis: guessed — the visible set is recomputed at most every minute; verify: none needed
 * The visible set is recomputed at most this often.
 */
export const POOL_VISIBLE_TTL_MS = 60_000;

/** basis: guessed — a row's trade ledger is refreshed once an hour old; verify: none needed
 * A row's trade ledger is refreshed incrementally once this old (coin
 * boards and the stocks top 100 show ledger figures).
 */
export const LEDGER_REFRESH_MS = HOUR_MS;

/** basis: guessed — half of the ledger loop's allowance for incremental refreshes while cold builds wait; verify: cold-build backlog on Stage
 * Share of the ledger loop's allowance kept for incremental refreshes
 * while cold builds are pending; the rest (and what refreshes don't use)
 * builds ledgers for rows that have none.
 */
export const POOL_LEDGER_REFRESH_SHARE = 0.5;

/** basis: guessed — a 429's pause is clamped to at least 5 min … (verify: none needed)
 * Clamp of a 429's pause: at least 5 min, at most a day.
 */
export const AVATAR_MIN_PAUSE_MS = 5 * MINUTE_MS;

/** basis: guessed — … and at most a day; verify: none needed
 */
export const AVATAR_MAX_PAUSE_MS = DAY_MS;

/** basis: guessed — a missing picture is looked for again a day later; verify: none needed
 * A missing picture is looked for again a day later …
 */
export const AVATAR_NOT_FOUND_RETRY_MS = DAY_MS;

/** basis: guessed — a failure retries after 15 min, doubling to a day; verify: none needed
 * … a failure after 15 min, doubling, at most a day.
 */
export const AVATAR_ERROR_RETRY_MS = 15 * MINUTE_MS;

/** basis: guessed — a cached avatar is fetched again after a week; verify: none needed
 * A cached avatar is fetched again after a week.
 */
export const AVATAR_REFRESH_MS = 7 * DAY_MS;

/** basis: derived — under the minute cron: a tick stops starting objects after 45 s
 * A tick stops starting objects after this long (the cron fires each minute).
 */
export const ARCHIVE_TICK_BUDGET_MS = 45_000;

/** basis: measured — hourly archive files rotate on the node's clock; a fill near the boundary may sit in the neighbouring file
 * Hourly archive files rotate on the node's clock, not on block time, so a
 * fill near an hour boundary may sit in the neighbouring file. A span is
 * therefore certified only this far inside the hours actually ingested;
 * REST re-reads the margins (duplicates collapse on the tid key).
 */
export const ARCHIVE_BOUNDARY_MARGIN_MS = 5 * MINUTE_MS;

/** basis: guessed — every dex of a cohort member is swept daily; verify: none needed
 * Every dex of a member is swept this often; in between only the main
 * dex and the dexes it holds or has traded are queried.
 */
export const COHORT_SWEEP_MS = DAY_MS;

/** basis: guessed — a cohort member whose read failed retries after 5 min; verify: none needed
 * Provider/account failures retry slowly; capacity pauses the whole job
 * until its validated release hint, or the conservative accounting window.
 */
export const COHORT_FAILURE_RETRY_MS = 5 * MINUTE_MS;

/** basis: derived — one retention run a day: not repeated within 20 h
 * A finished run is not repeated before this (one run a day).
 */
export const RETENTION_MIN_INTERVAL_MS = 20 * HOUR_MS;

/** basis: guessed — a closed socket lease is kept a day after closed_at (nothing reads it); verify: none needed
 * A closed Hyperliquid socket lease (and its cleanup evidence) is kept
 * this long after `closed_at`. Nothing reads a closed lease: the meter
 * counts nonclosed ones only, and a request naming a closed or missing
 * lease is refused the same way (hyperliquid_quota_lease_lost).
 */
export const CLOSED_WS_LEASE_RETENTION_MS = DAY_MS;

/** basis: guessed — an egress address not seen for a day leaves the set (a pool address may move to another tenant); verify: observe week publicIps
 * An address not seen again for this long leaves the set (a default
 * egress pool's address may move to another tenant).
 */
export const EGRESS_IP_TTL_MS = DAY_MS;

/** basis: measured — 2026-10-12: a DB outage made the worker exit within 3 s of every start and use up Railway's restarts; 10 min outlasts it
 * How long the worker keeps retrying while it cannot use Postgres (no
 * connection, or the standby connection dropped) before it exits. A DB
 * outage (2026-10-12: the usage limit stopped Postgres) used to make the
 * worker exit within 3 s of every start and use up Railway's restart
 * retries, leaving it dead once the database was back.
 */
export const WORKER_DB_RETRY_WINDOW_MS = 10 * MINUTE_MS;

/** basis: guessed — the worker's DB retry starts at 1 s … (verify: none needed)
 */
export const WORKER_LEASE_BACKOFF_MIN_MS = 1_000;

/** basis: guessed — … doubling to 30 s; verify: none needed
 */
export const WORKER_LEASE_BACKOFF_MAX_MS = 30_000;

/** basis: guessed — a standby asks for the lease every second; verify: none needed
 * Standby: how often a worker whose database is up asks for the lease again.
 */
export const WORKER_LEASE_POLL_MS = 1_000;

/** basis: guessed — a reconcile re-reads a minute of overlap; verify: none needed
 */
export const SNAPSHOT_RECONCILE_OVERLAP_MS = 60_000;

/** basis: derived — under the 5 min snapshot period: a call that waited 4 min for the budget fails instead of holding the next run
 * A snapshot or sweep call that has waited this long for the Hyperliquid
 * budget fails, so the run ends (and is reported as failed) before its
 * next period instead of holding every later run behind it.
 */
export const SNAPSHOT_QUEUE_MS = 4 * MINUTE_MS;

/** basis: derived — under the 15 min sweep period
 */
export const SWEEP_QUEUE_MS = 14 * MINUTE_MS;

/** basis: guessed — the settings relay reconnects after a second; verify: none needed
 */
export const SETTINGS_RELAY_RETRY_MS = 1000;

/** basis: guessed — jobs nobody asks for are looked for hourly; verify: none needed
 * Jobs nobody asks for any more are looked for this often.
 */
export const ANALYSIS_JOB_EXPIRE_EVERY_MS = HOUR_MS;

/** basis: guessed — an analysis job is deleted two weeks after it was last asked for; verify: none needed
 * Such a job is deleted, with its fills, this long after it was last asked for.
 */
export const REQUESTED_JOB_TTL_MS = 14 * DAY_MS;

/** basis: guessed — a watched address whose refresh failed is left out from 2 min, doubling … (verify: none needed)
 * A watched address whose refresh failed is left out of the worker's turns
 * for this long, doubling with each failure in a row up to
 * `TRACKED_BACKOFF_MAX_MS`; a success clears it.
 */
export const TRACKED_BACKOFF_BASE_MS = 2 * MINUTE_MS;

/** basis: guessed — … up to an hour; verify: none needed
 */
export const TRACKED_BACKOFF_MAX_MS = HOUR_MS;

/** basis: guessed — a watched address's funding is read at most hourly; verify: none needed
 * A worker refresh reads a watched address's funding at most this often.
 */
export const TRACKED_FUNDING_EVERY_MS = HOUR_MS;

/** basis: guessed — analytics read a year of fills; verify: none needed
 */
export const ANALYTICS_LOOKBACK_MS = 365 * DAY_MS;

/** basis: derived — ANALYTICS_LOOKBACK_MS
 * Funding is read from the start of coverage (at most the lookback), 40
 * pages per step; a long history completes over the next refreshes.
 */
export const FUNDING_LOOKBACK_MS = ANALYTICS_LOOKBACK_MS;

/** basis: derived — a year, as analytics read; REST retention starts there
 * Backward backfill stops at this age (analytics read a year), where
 * REST's retention starts, or once the span holds this many fills. The
 * cap bounds a market maker's storage, not the sample: at 50,000 it
 * stopped a 10,000-fills-a-day address after a week while REST still held
 * three more (audit A2); the span is read in pages (`storedFillPages`), so
 * its size is not bounded by memory. The calls are paced by the backfill's
 * budget cap (`HYPERLIQUID_BACKFILL_WEIGHT_PER_MIN`).
 */
export const BACKFILL_LOOKBACK_MS = 365 * DAY_MS;

/** basis: guessed — an address that used a TWAP in the last 48 h gets its slices read by the sweep; verify: none needed
 * An address that used a TWAP this recently gets its slices read by the
 * hourly sweep too.
 */
export const TWAP_ACTIVE_MS = 48 * HOUR_MS;

/** basis: measured — what the start-up sweep used to re-read for everyone (75 min)
 * An address with no verified span yet starts this far back (what the
 * start-up sweep used to re-read for everyone).
 */
export const INITIAL_LOOKBACK_MS = 75 * MINUTE_MS;

/** basis: measured — the fill index trails the exchange by seconds (p90 1.5 s); a minute of margin
 * A completed read certifies fills only up to this long before it was
 * sent: the fill index trails the exchange by seconds (p90 1.5 s).
 */
export const INDEX_LAG_MS = 60_000;

/** basis: guessed — a backfill page spans at least a minute … (verify: none needed)
 */
export const FILL_SYNC_MIN_SPAN_MS = 60_000;

/** basis: guessed — … and at most 30 days; verify: none needed
 */
export const FILL_SYNC_MAX_SPAN_MS = 30 * DAY_MS;

/** basis: guessed — a live sync reuses account state under 10 s old; verify: none needed
 * A live sync reuses account state younger than this (equity for R1/R3),
 * unless the action opened a position the cached state doesn't have yet.
 */
export const FILL_SYNC_ACCOUNT_REUSE_MS = 10_000;

/** basis: derived — a state is fetched fresh within the 20 s request timeout; two minutes of feed trades cover a late install
 * How long an address's feed trades are kept for replaying onto a newly
 * installed state. States are fetched fresh (a request times out after
 * 20 s), so a state is never older than this.
 */
export const BOOK_BUFFER_MS = 2 * MINUTE_MS;

/** basis: guessed — a ping every 30 s keeps the feed socket alive; verify: none needed
 */
export const FEED_PING_INTERVAL_MS = 30_000;

/** basis: derived — three missed pings (FEED_PING_INTERVAL_MS) mean a dead socket
 * No message at all (not even a pong) for this long → assume dead.
 */
export const FEED_STALE_AFTER_MS = 90_000;

/** basis: guessed — a replayed trade older than a minute is left to the sweeps; verify: none needed
 * Subscribing replays each market's recent trades, which in a quiet market
 * can be hours old. Only fresh trades mean "just traded"; anything older is
 * left to the sweeps, so a (re)connect never raises alerts on old trades.
 */
export const MAX_TRADE_AGE_MS = 60_000;

/** basis: guessed — fills of one coin and side within a second form one action; verify: none needed
 * Fills → `actions` (PRD §4.2 W3).
 * Every Hyperliquid fill carries `startPosition`, the signed position size
 * right before it. That alone decides the action kind exactly — no need to
 * compare polled position snapshots, which went wrong after every restart
 * (empty memory made every add look like an open) and when a round trip
 * fitted between two polls.
 * Grouping: fills of the same coin, same side (B/A) and same liquidation
 * status, each within `GROUP_GAP_MS` of the previous one, form one action.
 * One market order that crosses eight resting orders is eight fills and one
 * action. The group's kind comes from the position before its first fill
 * and after its last fill:
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
 * The fill index usually has a feed trade within 1.5 s (measured live
 * 2026-09-29: p50 0.6 s, p90 1.5 s); the first confirm waits this long.
 */
export const CONFIRM_DELAY_MS = 2_000;

/** basis: guessed — confirms of one address start at least 15 s apart (one userFillsByTime per 15 s, not per trade); verify: none needed
 * Confirms of one address start at least this far apart: an address that
 * trades every second costs one `userFillsByTime` per 15 s, not per trade.
 */
export const CONFIRM_MIN_INTERVAL_MS = 15_000;

/** basis: guessed — a fill not returned yet is looked for after 5 s, 15 s and 60 s; verify: fillsUnavailable rate on Stage
 * A trade whose fill Hyperliquid hasn't returned yet is looked for again
 * after these delays, then the address is listed as `fillsUnavailable`.
 */
export const CONFIRM_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

/** basis: guessed — a confirm starts reading 10 s before the first trade; verify: none needed
 * How far before the first trade a confirm starts reading. Trade and fill
 * times share the exchange clock, so this only needs to catch fills of the
 * same order that landed just before.
 */
export const CONFIRM_LOOKBACK_MS = 10_000;

/** basis: guessed — the watched set is refreshed every 15 s; verify: none needed
 */
export const WATCHED_REFRESH_MS = 15_000;

/** basis: guessed — a copied leader's verified span is caught up every 2 min; verify: none needed
 * A copied leader's verified span is caught up this often (besides the
 * quarter-hourly sweeps), and its copy stream audited after each.
 */
export const COPIED_CATCH_UP_MS = 2 * MINUTE_MS;

/** basis: guessed — a feed that failed to start is retried after 30 s; verify: none needed
 */
export const FEED_START_RETRY_MS = 30_000;

/** basis: guessed — a delivery retries after 1 s, 2 s and 4 s (four attempts in all); verify: none needed
 * Backoff between attempts for alerts and system messages: 3 retries
 * after the first attempt = 4 attempts in all.
 */
export const NOTIFY_RETRY_DELAYS_MS = [1000, 2000, 4000];

/** basis: guessed — one drain call stops reading new batches after 30 s; verify: none needed
 * One drain call stops reading new batches after this long (the next call goes on).
 */
export const DELIVERY_DRAIN_BUDGET_MS = 30_000;

/** basis: guessed — a favorite alert fires at most once per (user, trader, coin) in 10 s; verify: none needed
 * A favorite alert fires at most once per (user, trader, coin) in this
 * window. Actions are already 1 s aggregates; this only stops a trader who
 * fires several orders in a row from sending a burst.
 */
export const FAVORITE_BURST_GUARD_MS = 10_000;

/** basis: guessed — a backfill job is given up after 3 attempts; verify: none needed
 */
export const BACKFILL_MAX_ATTEMPTS = 3;
