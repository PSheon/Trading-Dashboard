/**
 * How many times a money-path step is tried before it is given up.
 *
 * Every constant states its basis on the first comment line (AGENTS.md):
 * measured (a gate, a harness or the provider's docs), derived (from another
 * constant), copied (from another check, with no reason of its own) or
 * guessed (a number that looked right; it says how it will be verified).
 * test/tuning-constants.spec.ts keeps every tuning constant here, unique,
 * with its basis.
 */
import { MINUTE_MS } from './time.js';

/** basis: guessed — three orders per leader leg (the cloid suffix holds one digit); gate 9 records p50/p99 of attempts used
 * Most orders one leader leg may be planned as. Attempt 0 is the leg's
 * original order; a later attempt exists only after the previous one was
 * released as never sent (its exchange request provably never began:
 * isDefinitelyUnsent, released by releaseUnsent) and is a new order with its
 * own cloid, execution key, nonce, provenance, reservation and every gate.
 * The previous attempt's journal stays rejected (immutable); it is never
 * re-armed. After the last attempt the leg is skipped as before.
 */
export const MAX_LIVE_LEG_ATTEMPTS = 3;

/** basis: guessed — a close that keeps failing is refused after 30 attempts; gate 9 records p50/p99
 * A close has no age limit, but one that keeps failing is refused after this
 * many attempts (never an endless retry); a leader then flat closes the rest.
 */
export const CLOSE_ATTEMPT_LIMIT = 30;

/** basis: measured — testnet 2026-10-12: an unsupported mode read right after a setup was the exchange catching up; final on the third read
 * Reads of an unsupported account mode before its refusal is final.
 */
export const ABSTRACTION_ATTEMPT_LIMIT = 3;

/** basis: guessed — an outbox row is parked after 8 attempts; verify: admin outbox failures
 * Attempts before an outbox row is parked as `failed` (visible in admin).
 */
export const MAX_SIGNAL_ATTEMPTS = 8;

/** basis: guessed — a stop's automatic return is reserved again at most 5 times; verify: return outcomes on Stage
 * A stop's automatic return that provably never reached the exchange (not
 * signed, or refused before its POST) is reserved again with a new nonce, at
 * most this many attempts in all, the next one no sooner than
 * sweepRetryDelayMs(n) after attempt n ended.
 */
export const SYSTEM_SWEEP_ATTEMPTS = 5;

/** basis: guessed — 5 Telegram link requests per user per window; verify: none needed
 * Link requests per user per window; beyond it, 429.
 */
export const LINK_RATE_LIMIT = 5;

/** basis: guessed — … per 10 min; verify: none needed
 */
export const LINK_RATE_WINDOW_MS = 10 * MINUTE_MS;

/** basis: guessed — a leader's recent fills list shows 200; verify: none needed
 */
export const LEADER_FILLS_HISTORY_LIMIT = 200;

/** basis: guessed — a leader's recent alerts list shows 50; verify: none needed
 */
export const LEADER_ALERTS_HISTORY_LIMIT = 50;
