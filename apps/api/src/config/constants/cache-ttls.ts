/**
 * How long a read is kept before it is read again, each with its reason.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';

/** basis: guessed — mid prices are shared for 3 s (allMids weighs 2); verify: order price deviation refusals vs mids age
 */
export const MIDS_TTL_MS = 3_000;

/** basis: guessed — a failed mids read may fall back to one under a minute old; verify: none needed
 */
export const MIDS_STALE_OK_MS = 60_000;

/** basis: guessed — the universe and funding (metaAndAssetCtxs, 20) are re-read hourly; verify: none needed
 */
export const ASSETS_TTL_MS = HOUR_MS;

/** basis: guessed — a leader's account value for ratio sizing is kept a minute; verify: ratio sizing error vs equity age (gate 9)
 * See `leaderEquity` for the reads.
 */
export const LEADER_EQUITY_TTL_MS = 60_000;

/** basis: guessed — a trader's account mode for the profile is kept 10 min; verify: none needed
 * This and the next three: slow or shared parts of a leader's account value,
 * kept as long as the trader profile keeps them.
 */
export const ACCOUNT_MODE_TTL_MS = 10 * MINUTE_MS;

/** basis: guessed — staked HYPE for the profile is kept 10 min; verify: none needed
 */
export const STAKING_TTL_MS = 10 * MINUTE_MS;

/** basis: guessed — the spot price book is kept 30 s; verify: none needed
 */
export const SPOT_BOOK_TTL_MS = 30_000;

/** basis: guessed — the dex list is kept an hour (listings change a few times a week); verify: none needed
 */
export const DEX_LIST_TTL_MS = HOUR_MS;

/** basis: guessed — the market catalog is re-read hourly (listings change a few times a week); verify: none needed
 */
export const MARKET_CATALOG_TTL_MS = HOUR_MS;

/** basis: guessed — paper copy performance is sampled every minute; verify: none needed
 */
export const COPY_SNAPSHOT_INTERVAL_MS = 60_000;

/** basis: derived — two sampling intervals: one missed sample is not a gap
 */
export const FRESH_MS = 2 * COPY_SNAPSHOT_INTERVAL_MS;

/** basis: derived — six sampling intervals: the follower collector observes an account at most every two minutes (five while testnet orders are busy)
 * An actual copy is valued at each stored account observation; a gap up to
 * this is not a hole in its history.
 */
export const ACTUAL_FRESH_MS = 6 * COPY_SNAPSHOT_INTERVAL_MS;

/** basis: guessed — the paper worker checks funding every minute; verify: none needed
 */
export const FUNDING_CHECK_MS = 60_000;

/** basis: guessed — the public leaders list is computed at most every 30 s; verify: none needed
 * One computation at a time however many requests wait.
 */
export const LEADERS_CACHE_TTL_MS = 30_000;

/** basis: guessed — a verified identity is reused for 30 s (role and disabled state are re-read every request); verify: none needed
 */
export const AUTH_CACHE_TTL_MS = 30_000;

/** basis: guessed — a user with no email on file is looked up at Privy again at most every 10 min; verify: none needed
 */
export const AUTH_PROFILE_RETRY_MS = 10 * MINUTE_MS;

/** basis: guessed — a missing embedded wallet is looked up every 15 s (the browser creates it right after sign-in); verify: none needed
 */
export const EMBEDDED_WALLET_RETRY_MS = 15_000;

/** basis: guessed — boards read the pool table at most every 30 s; verify: none needed
 */
export const BOARDS_TTL_MS = 30_000;

/** basis: guessed — header search answers stay 30 s; verify: none needed
 * Per query.
 */
export const SEARCH_TTL_MS = 30_000;

/** basis: guessed — cohort detail is rebuilt at most every 30 s per tier; verify: none needed
 */
export const COHORT_DETAIL_TTL_MS = 30_000;

/** basis: guessed — BTC candles are fetched at most every 10 min per window; verify: none needed
 */
export const COHORT_CANDLES_TTL_MS = 10 * MINUTE_MS;

/** basis: guessed — the crowd view is kept a minute; verify: none needed
 */
export const CROWD_TTL_MS = 60_000;

/** basis: derived — three 5 min snapshot periods: a set older than that is ignored
 * So an address the scheduler stopped snapshotting doesn't keep showing
 * positions it may have closed.
 */
export const INSIGHTS_SNAPSHOT_MAX_AGE_MS = 15 * MINUTE_MS;

/** basis: guessed — settings are re-read every 30 s; verify: none needed
 */
export const SETTINGS_CACHE_TTL_MS = 30_000;

/** basis: guessed — a Telegram link token is valid 10 min; verify: none needed
 */
export const LINK_TOKEN_TTL_MS = 10 * MINUTE_MS;

/** basis: derived — expired tokens back the rate limit for a day, then go
 * Deleted on the user's next link request.
 */
export const LINK_TOKEN_RETENTION_MS = DAY_MS;

/** basis: guessed — a leader's activity (20–120 weight a read) is shared by the trader page and a start for 5 min; verify: none needed
 */
export const COPY_ACTIVITY_TTL_MS = 5 * MINUTE_MS;

/** basis: guessed — one spot price book for the app, refreshed at most every 30 s; verify: none needed
 */
export const SPOT_PRICE_TTL_MS = 30_000;

/** basis: guessed — analytics are served from the store for 10 min, refreshed in the background after; verify: none needed
 */
export const ANALYTICS_STALE_MS = 10 * MINUTE_MS;

/** basis: derived — three worker periods (ANALYTICS_STALE_MS): older than that the page refreshes itself
 * A watched address's figures are the worker's to refresh; older than this
 * the worker is not doing it (down or starved) and a page read refreshes them.
 */
export const TRACKED_FALLBACK_MS = 3 * ANALYTICS_STALE_MS;

/** basis: guessed — positions and account value are kept a minute; verify: none needed
 */
export const PROFILE_TTL_MS = 60_000;

/** basis: guessed — the portfolio view is kept a minute; verify: none needed
 */
export const PORTFOLIO_TTL_MS = 60_000;

/** basis: guessed — an untracked trader's fills (up to 120 weight a read) are kept 5 min; verify: none needed
 * Fill and TWAP slice lists of addresses we don't store fills for (a
 * tracked address's fills tab reads our table).
 */
export const FILLS_TTL_MS = 5 * MINUTE_MS;

/** basis: guessed — sparklines are kept 10 min; verify: none needed
 */
export const SPARKLINE_TTL_MS = 10 * MINUTE_MS;

/** basis: guessed — the orders tab is kept 30 s; verify: none needed
 */
export const ORDERS_TTL_MS = 30_000;

/** basis: guessed — the TWAP tab is kept a minute; verify: none needed
 */
export const TWAP_TTL_MS = 60_000;

/** basis: guessed — the transfers tab is kept 5 min; verify: none needed
 */
export const TRANSFERS_TTL_MS = 5 * MINUTE_MS;

/** basis: guessed — the transfers tab reads the last 90 days; verify: none needed
 */
export const TRANSFERS_WINDOW_MS = 90 * DAY_MS;

/** basis: guessed — a discovery-pool sparkline older than a day is fetched instead; verify: none needed
 */
export const POOL_SPARKLINE_MAX_AGE_MS = DAY_MS;

/** basis: derived — 30 days
 */
export const TRADER_THIRTY_DAYS_MS = 30 * DAY_MS;

/** basis: derived — short enough that a Bridge2 deposit (under a minute) shows within a poll or two, long enough that a page's reads share one (weight 4)
 * Balances: shared by a page's header pill, portfolio and modal.
 */
export const WALLET_TTL_MS = 15_000;

/** basis: guessed — the wallet ledger (20 weight + 1 per 20 rows) is kept a minute; verify: none needed
 * A withdrawal takes minutes anyway.
 */
export const WALLET_HISTORY_TTL_MS = 60_000;

/** basis: guessed — a user without a stored embedded wallet is looked up at Privy at most every 15 s; verify: none needed
 * The browser creates the wallet right after login, so the first reads may
 * come before Privy has it.
 */
export const WALLET_ADDRESS_RETRY_MS = 15_000;
