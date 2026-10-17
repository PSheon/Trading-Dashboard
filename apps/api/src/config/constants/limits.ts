/**
 * How many times a money-path step is tried before it is given up.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */
import { MINUTE_MS } from './time.js';

/** basis: guessed — three orders per leader leg (the cloid suffix holds one digit); gate 9 records p50/p99 of attempts used
 * A later attempt exists only after the previous one was released as never
 * sent (isDefinitelyUnsent / releaseUnsent); it is a new order with its own
 * cloid, nonce and reservation. The rejected journal is never re-armed.
 */
export const MAX_LIVE_LEG_ATTEMPTS = 3;

/** basis: guessed — a close that keeps failing is refused after 30 attempts; gate 9 records p50/p99
 * A close has no age limit; after this a leader flat closes the rest.
 */
export const CLOSE_ATTEMPT_LIMIT = 30;

/** basis: measured — testnet 2026-10-12: an unsupported mode read right after a setup was the exchange catching up; final on the third read
 */
export const ABSTRACTION_ATTEMPT_LIMIT = 3;

/** basis: guessed — an outbox row is parked after 8 attempts; verify: admin outbox failures
 * Parked as `failed` (visible in admin).
 */
export const MAX_SIGNAL_ATTEMPTS = 8;

/** basis: measured — gate 12 (2026-10-17 04:26–04:32Z): a paper pass of one leader's 200 outbox rows held an owner's
 * copy user lock (7404) 12.0–12.9 s, back-to-back statements (idle ≤ 57 ms), ~60 ms a fill on Stage's 8 ms round trip;
 * a live order of that owner waits LIVE_RISK_LOCK_WAIT_MS (1 s) for the same lock and then fails live_risk_busy.
 * Eight fills with batched leg statements is ≤ ~30 statements a transaction (≈ 250 ms on Stage); the spec records the
 * statements under the lock. The paper signal drain copies at most this many of one leader's fills for one strategy
 * in one locked transaction, commits, and waits LIVE_RISK_LOCK_POLL_MS before locking that owner again.
 */
export const PAPER_SIGNAL_FILLS_PER_LOCK_LIMIT = 8;

/** basis: guessed — a stop's automatic return is reserved again at most 5 times; verify: return outcomes on Stage
 * Only a return that provably never reached the exchange is reserved again
 * (new nonce), no sooner than sweepRetryDelayMs(n) after attempt n ended.
 */
export const SYSTEM_SWEEP_ATTEMPTS = 5;

/** basis: guessed — 5 Telegram link requests per user per window; verify: none needed
 * Beyond it, 429.
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
