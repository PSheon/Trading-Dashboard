/**
 * When an ALERT is raised and how often it repeats.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */

import { MINUTE_MS } from './time.js';

/** basis: guessed — every rate-limited ALERT repeats at most every 10 min (one throttle for all of them, 2026-10-15); verify: none needed
 */
export const ALERT_EVERY_MS = 10 * MINUTE_MS;

/** basis: guessed — an approval the exchange lists but we haven't recorded alerts after 5 min; verify: none needed
 * Repeats every ALERT_EVERY_MS.
 */
export const AGENT_APPROVED_UNRECORDED_ALERT_MS = 5 * MINUTE_MS;

/** basis: guessed — a deposit awaiting its credit alerts after 10 min; verify: funding confirmation p99 on Stage
 * Measured from the confirm that sent the deposit; logs `ALERT funding awaiting_credit`.
 */
export const AWAITING_CREDIT_ALERT_AFTER_MS = 10 * MINUTE_MS;

/** basis: guessed — a page call that waited 2 s for its turn is logged; verify: none needed
 */
export const SLOW_PAGE_WAIT_MS = 2_000;

/** basis: guessed — … at most once every 10 s; verify: none needed
 */
export const SLOW_PAGE_LOG_EVERY_MS = 10_000;

/** basis: derived — the notify retry schedule (five attempts a minute apart) plus a restart: 10 min (review 51)
 * The alert queue is durable, so a row left by a downed worker, a restored
 * backup or a long Telegram refusal would otherwise be sent as if the trade
 * just happened. Past this, evaluation and delivery are marked `expired`.
 */
export const ALERT_MAX_AGE_MS = 10 * MINUTE_MS;

/** basis: guessed — the feed down 10 min raises the Telegram self-alert (§8); verify: none needed
 */
export const FEED_DOWN_ALERT_MS = 10 * MINUTE_MS;

/** basis: derived — three missed 5 min snapshot runs
 * Snapshots run every 5 minutes (SchedulerService.snapshotAll).
 */
export const SNAPSHOT_STALE_MS = 15 * MINUTE_MS;

/** basis: guessed — the api waits 2 min for a copy worker heartbeat to report its live engine running (worker.terminalSettlement); verify: none needed
 * Applies on the api of a live copy deployment with WORKER_URL set (the api never settles: D13).
 */
export const SETTLEMENT_OWNER_WINDOW_MS = 2 * MINUTE_MS;

/** basis: guessed — the api reads the workers for its guards every 30 s; verify: none needed
 */
export const WORKER_GUARD_CHECK_MS = 30_000;
