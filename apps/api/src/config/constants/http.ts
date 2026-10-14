/**
 * Request deadlines, timeouts and page limits of the api and its outbound HTTP.
 *
 * Every constant states its basis on the first comment line (AGENTS.md):
 * measured (a gate, a harness or the provider's docs), derived (from another
 * constant), copied (from another check, with no reason of its own) or
 * guessed (a number that looked right; it says how it will be verified).
 * test/tuning-constants.spec.ts keeps every tuning constant here, unique,
 * with its basis.
 */

/** basis: guessed — every api request answers within 20 s (the web forwarder's own timeout); verify: none needed
 */
export const REQUEST_DEADLINE_MS = 20_000;

/** basis: derived — inside REQUEST_DEADLINE_MS (20 s) with room for the busy answer
 * A trader-page request answers within this long, well inside the web
 * forwarder's 20 s timeout: past it, 503 busy.
 */
export const PAGE_DEADLINE_MS = 12_000;

/** basis: guessed — a busy answer's Retry-After: the work goes on and is usually cached 5 s later; verify: 503 retry success rate on Stage
 * Retry-After of a busy answer. The work it was waiting on continues, so
 * a retry this much later usually finds it cached.
 */
export const BUSY_RETRY_AFTER_MS = 5_000;

/** basis: guessed — a sparkline batch answers with what is ready after 8 s; verify: none needed
 * A sparkline batch answers with what is ready by then (see `sparklines`).
 */
export const SPARKLINE_DEADLINE_MS = 8_000;

/** basis: guessed — one Privy call from the verifier is bounded at 8 s; verify: Privy latency p99 (gate 9 identity spans)
 * Per Privy API call from the verifier (see the constructor).
 */
export const PRIVY_TIMEOUT_MS = 8_000;

/** basis: guessed — a dead Arbitrum RPC must not hold the wallet read: 6 s; verify: none needed
 * A dead RPC must not hold the wallet read; the balance is then unknown.
 */
export const RPC_TIMEOUT_MS = 6_000;

/** basis: measured — the leaderboard payloads are ≈38 MB and ≈14 MB; two minutes allows a slow link
 * The payloads are ≈38 MB and ≈14 MB; allow a slow link, never hang.
 */
export const LEADERBOARD_FETCH_TIMEOUT_MS = 120_000;

/** basis: guessed — in-flight work gets 30 s on SIGTERM before the process exits; verify: Railway deploy overlap logs
 */
export const SHUTDOWN_TIMEOUT_MS = 30_000;

/** basis: guessed — a health answer is reused for a second; verify: none needed
 * How long a health or readiness answer is reused.
 */
export const HEALTH_CACHE_MS = 1_000;

/** basis: copied — the source's own 5 s bound on one snapshot read
 * The source's own bound on one snapshot read.
 */
export const ACCOUNT_READ_TIMEOUT_MS = 5_000;

/** basis: guessed — a read waits 4 s for its turn on the socket; verify: trader page account-read wait histogram
 * Longest a read waits for its turn on the socket.
 */
export const ACCOUNT_READ_WAIT_MS = 4_000;

/** basis: derived — ACCOUNT_READ_WAIT_MS + ACCOUNT_READ_TIMEOUT_MS: what a caller racing the read must allow
 * Longest `read` takes in all, its turn included: what a caller racing it
 * must allow (a shorter race gave up on reads that were about to answer).
 */
export const ACCOUNT_READ_DEADLINE_MS = ACCOUNT_READ_WAIT_MS + ACCOUNT_READ_TIMEOUT_MS;

/** basis: guessed — the long poll plus 15 s before a Telegram request is given up; verify: none needed
 * The HTTP request may take the long poll plus this before we give up.
 */
export const TELEGRAM_REQUEST_SLACK_MS = 15_000;

/** basis: guessed — a 409 from getUpdates (another poller) backs off from 5 s to a minute; verify: none needed
 * 409 from getUpdates: another process polls this token (or a webhook is
 * set). Back off, doubling, up to a minute; it may be a deploy overlap.
 */
export const TELEGRAM_CONFLICT_BACKOFF_MS = { first: 5_000, max: 60_000 };

/** basis: guessed — a network error, 429 or 5xx backs off from 1 s to 30 s; verify: none needed
 * Network errors, 429, 5xx.
 */
export const TELEGRAM_ERROR_BACKOFF_MS = { first: 1_000, max: 30_000 };

/** basis: measured — Telegram allows about one message a second per chat
 * Between two messages to one chat (Telegram allows about one a second).
 */
export const TELEGRAM_CHAT_INTERVAL_MS = 1_000;

/** basis: measured — Hyperliquid's userFills returns at most 2,000 of the latest fills
 * `userFills` returns at most this many of the latest fills.
 */
export const USER_FILLS_CAP = 2_000;

/** basis: derived — USER_FILLS_CAP: the fills tab reads one userFills page
 * CopyDog's 成交 tab reads up to 2,000 fills (one `userFills` page).
 */
export const MAX_FILLS_LIMIT = USER_FILLS_CAP;

/** basis: guessed — a fills page shows 50 by default; verify: none needed
 */
export const DEFAULT_FILLS_LIMIT = 50;
