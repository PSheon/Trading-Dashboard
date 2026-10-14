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

import { HOUR_MS, MINUTE_MS } from './time.js';

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
