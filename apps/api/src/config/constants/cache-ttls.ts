/**
 * How long a read is kept before it is read again, each with its reason.
 *
 * Every constant states its basis on the first comment line (AGENTS.md):
 * measured (a gate, a harness or the provider's docs), derived (from another
 * constant), copied (from another check, with no reason of its own) or
 * guessed (a number that looked right; it says how it will be verified).
 * test/tuning-constants.spec.ts keeps every tuning constant here, unique,
 * with its basis.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';

/** basis: guessed — mid prices are shared for 3 s (allMids weighs 2); verify: order price deviation refusals vs mids age
 * Mid prices are shared by every caller for this long (allMids, weight 2).
 */
export const MIDS_TTL_MS = 3_000;

/** basis: guessed — a failed mids read may fall back to one under a minute old; verify: none needed
 * A mids read that fails may fall back to one this recent.
 */
export const MIDS_STALE_OK_MS = 60_000;

/** basis: guessed — the universe and funding (metaAndAssetCtxs, 20) are re-read hourly; verify: none needed
 * Universe and funding (metaAndAssetCtxs, weight 20): hourly.
 */
export const ASSETS_TTL_MS = HOUR_MS;

/** basis: guessed — a leader's account value for ratio sizing is kept a minute; verify: ratio sizing error vs equity age (gate 9)
 * Leader account value for ratio sizing (see `leaderEquity` for the reads).
 */
export const LEADER_EQUITY_TTL_MS = 60_000;

/** basis: guessed — a trader's account mode for the profile is kept 10 min; verify: none needed
 * Parts of a leader's account value that change slowly or are shared, kept
 * as long as the trader profile keeps them: the account mode and staked
 * HYPE (20 weight each), the spot price book (22) and the dex list.
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
 * The catalog is re-read this often (listings change a few times a week).
 */
export const MARKET_CATALOG_TTL_MS = HOUR_MS;

/** basis: guessed — paper copy performance is sampled every minute; verify: none needed
 */
export const COPY_SNAPSHOT_INTERVAL_MS = 60_000;

/** basis: derived — two sampling intervals: one missed sample is not a gap
 */
export const FRESH_MS = 2 * COPY_SNAPSHOT_INTERVAL_MS;

/** basis: derived — six sampling intervals: the follower collector observes an account at most every two minutes (five while testnet orders are busy)
 * An actual copy is valued at each stored observation of its account, which
 * the follower collector takes at most every two minutes per account (five
 * while testnet orders are busy), not every minute: a gap up to this is not a
 * hole in its history.
 */
export const ACTUAL_FRESH_MS = 6 * COPY_SNAPSHOT_INTERVAL_MS;

/** basis: guessed — the paper worker checks funding every minute; verify: none needed
 */
export const FUNDING_CHECK_MS = 60_000;

/** basis: guessed — the public leaders list is computed at most every 30 s; verify: none needed
 * The public list is the same for everyone: computed at most this often,
 * and by one computation at a time however many requests wait.
 */
export const LEADERS_CACHE_TTL_MS = 30_000;

/** basis: guessed — a verified identity is reused for 30 s (role and disabled state are re-read every request); verify: none needed
 * Signature/identity verification may be reused briefly. Persisted role and
 * disabled state are re-read for every request, including cache hits.
 */
export const AUTH_CACHE_TTL_MS = 30_000;

/** basis: guessed — a user with no email on file is looked up at Privy again at most every 10 min; verify: none needed
 * A returning user with no email on file is looked up at Privy again at
 * most this often (they may have linked one since).
 */
export const AUTH_PROFILE_RETRY_MS = 10 * MINUTE_MS;

/** basis: guessed — a missing embedded wallet is looked up every 15 s (the browser creates it right after sign-in); verify: none needed
 * A missing embedded wallet is looked up far more often: the browser
 * creates it right after the first sign-in, seconds after the api first
 * saw the Privy record without one.
 */
export const EMBEDDED_WALLET_RETRY_MS = 15_000;

/** basis: guessed — boards read the pool table at most every 30 s; verify: none needed
 * Boards read the pool table at most this often (it changes a row at a
 * time, a few times a minute).
 */
export const BOARDS_TTL_MS = 30_000;

/** basis: guessed — header search answers stay 30 s; verify: none needed
 * Header search answers stay this long per query (names change rarely).
 */
export const SEARCH_TTL_MS = 30_000;

/** basis: guessed — cohort detail is rebuilt at most every 30 s per tier; verify: none needed
 * Detail responses are rebuilt at most this often per tier.
 */
export const COHORT_DETAIL_TTL_MS = 30_000;

/** basis: guessed — BTC candles are fetched at most every 10 min per window; verify: none needed
 * BTC candles are fetched at most this often per window.
 */
export const COHORT_CANDLES_TTL_MS = 10 * MINUTE_MS;

/** basis: guessed — the crowd view is kept a minute; verify: none needed
 */
export const CROWD_TTL_MS = 60_000;

/** basis: derived — three 5 min snapshot periods: a set older than that is ignored
 * A snapshot set older than this is ignored, so an address the scheduler
 * stopped snapshotting doesn't keep showing positions it may have closed.
 * Snapshots run every 5 minutes.
 */
export const INSIGHTS_SNAPSHOT_MAX_AGE_MS = 15 * MINUTE_MS;

/** basis: guessed — settings are re-read every 30 s; verify: none needed
 */
export const SETTINGS_CACHE_TTL_MS = 30_000;

/** basis: guessed — a Telegram link token is valid 10 min; verify: none needed
 */
export const LINK_TOKEN_TTL_MS = 10 * MINUTE_MS;

/** basis: derived — expired tokens back the rate limit for a day, then go
 * Token rows are kept this long after expiring (they back the rate
 * limit), then deleted on the user's next link request.
 */
export const LINK_TOKEN_RETENTION_MS = DAY_MS;

/** basis: guessed — a leader's activity (20–120 weight a read) is shared by the trader page and a start for 5 min; verify: none needed
 * A leader's activity changes slowly next to what one read costs (20–120
 * weight), so the trader page and a start share one read per address.
 */
export const COPY_ACTIVITY_TTL_MS = 5 * MINUTE_MS;

/** basis: guessed — one spot price book for the app, refreshed at most every 30 s; verify: none needed
 * One price book for the whole app, refreshed at most every 30 s.
 */
export const SPOT_PRICE_TTL_MS = 30_000;

/** basis: guessed — analytics are served from the store for 10 min, refreshed in the background after; verify: none needed
 * Served from the store for this long; older answers are still served
 * while a refresh runs in the background.
 */
export const ANALYTICS_STALE_MS = 10 * MINUTE_MS;

/** basis: derived — three worker periods (ANALYTICS_STALE_MS): older than that the page refreshes itself
 * A watched address's figures are the worker's to refresh (every minute,
 * once older than `ANALYTICS_STALE_MS`). Older than this, the worker is not doing it
 * (down, not deployed beside this api, or starved), and a page read
 * refreshes them itself, as for any other address. Three worker periods.
 */
export const TRACKED_FALLBACK_MS = 3 * ANALYTICS_STALE_MS;

/** basis: guessed — positions and account value are kept a minute; verify: none needed
 * Positions and account value: live data.
 */
export const PROFILE_TTL_MS = 60_000;

/** basis: guessed — the portfolio view is kept a minute; verify: none needed
 */
export const PORTFOLIO_TTL_MS = 60_000;

/** basis: guessed — an untracked trader's fills (up to 120 weight a read) are kept 5 min; verify: none needed
 * Hyperliquid's latest fill and TWAP slice lists, for addresses we don't
 * store fills for (a tracked address's fills tab reads our table). They
 * cost up to 120 weight each, 3–6× a whole profile, so they are kept
 * longer: the fills tab and activity of an untracked trader are up to 5 min
 * old.
 */
export const FILLS_TTL_MS = 5 * MINUTE_MS;

/** basis: guessed — sparklines are kept 10 min; verify: none needed
 */
export const SPARKLINE_TTL_MS = 10 * MINUTE_MS;

/** basis: guessed — the orders tab is kept 30 s; verify: none needed
 * 訂單 / TWAP / 轉帳 tabs: loaded when opened, kept this long.
 */
export const ORDERS_TTL_MS = 30_000;

/** basis: guessed — the TWAP tab is kept a minute; verify: none needed
 */
export const TWAP_TTL_MS = 60_000;

/** basis: guessed — the transfers tab is kept 5 min; verify: none needed
 */
export const TRANSFERS_TTL_MS = 5 * MINUTE_MS;

/** basis: guessed — the transfers tab reads the last 90 days; verify: none needed
 * The 轉帳 tab reads the last 90 days …
 */
export const TRANSFERS_WINDOW_MS = 90 * DAY_MS;

/** basis: guessed — a discovery-pool sparkline older than a day is fetched instead; verify: none needed
 * A discovery-pool sparkline older than this is fetched instead.
 */
export const POOL_SPARKLINE_MAX_AGE_MS = DAY_MS;

/** basis: derived — 30 days
 */
export const TRADER_THIRTY_DAYS_MS = 30 * DAY_MS;

/** basis: derived — short enough that a Bridge2 deposit (under a minute) shows within a poll or two, long enough that a page's reads share one (weight 4)
 * Balances: short enough that a deposit shows up within a poll or two
 * (Bridge2 credits in under a minute), long enough that a page's header
 * pill, portfolio and modal share one read. Weight 4 per refresh.
 */
export const WALLET_TTL_MS = 15_000;

/** basis: guessed — the wallet ledger (20 weight + 1 per 20 rows) is kept a minute; verify: none needed
 * Ledger: 20 weight + 1 per 20 rows; a withdrawal takes minutes anyway.
 */
export const WALLET_HISTORY_TTL_MS = 60_000;

/** basis: guessed — a user without a stored embedded wallet is looked up at Privy at most every 15 s; verify: none needed
 * A user without a stored embedded wallet is looked up at Privy at most
 * this often: the browser creates the wallet right after login, so the
 * first reads may come before Privy has it.
 */
export const WALLET_ADDRESS_RETRY_MS = 15_000;
