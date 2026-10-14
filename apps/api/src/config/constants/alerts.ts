/**
 * When an ALERT is raised and how often it repeats.
 *
 * Every constant states its basis on the first comment line (AGENTS.md):
 * measured (a gate, a harness or the provider's docs), derived (from another
 * constant), copied (from another check, with no reason of its own) or
 * guessed (a number that looked right; it says how it will be verified).
 * test/tuning-constants.spec.ts keeps every tuning constant here, unique,
 * with its basis.
 */

import { MINUTE_MS } from './time.js';

/** basis: guessed — every rate-limited ALERT repeats at most every 10 min (one throttle for all of them, 2026-10-15); verify: none needed
 */
export const ALERT_EVERY_MS = 10 * MINUTE_MS;

/** basis: guessed — an approval the exchange lists but we haven't recorded alerts after 5 min; verify: none needed
 * The exchange lists an agent whose grant still isn't recorded: an ALERT
 * past this long, and again every ALERT_EVERY_MS.
 */
export const AGENT_APPROVED_UNRECORDED_ALERT_MS = 5 * MINUTE_MS;

/** basis: guessed — a deposit awaiting its credit alerts after 10 min; verify: funding confirmation p99 on Stage
 * A setup awaiting its credit longer than this (since its confirm sent the
 * deposit) logs `ALERT funding awaiting_credit`…
 */
export const AWAITING_CREDIT_ALERT_AFTER_MS = 10 * MINUTE_MS;

/** basis: guessed — a page call that waited 2 s for its turn is logged; verify: none needed
 */
export const SLOW_PAGE_WAIT_MS = 2_000;

/** basis: guessed — … at most once every 10 s; verify: none needed
 */
export const SLOW_PAGE_LOG_EVERY_MS = 10_000;

/** basis: derived — the notify retry schedule (five attempts a minute apart) plus a restart: 10 min (review 51)
 * An alert is evaluated and sent only while its trade is this recent
 * (review 51). An action is queued for alerts only when it is at most
 * `maxActionAgeSeconds` old (120 s; `insertActions`), but the queue is
 * durable: a row left by a worker that was down, by a restored backup or by
 * Telegram refusing for a long time used to be evaluated and sent whenever
 * it was next read, as if the trade had just happened. Ten minutes covers
 * the retry schedule (five attempts a minute apart) and a restart; past it
 * the evaluation is closed and the delivery dropped, both marked `expired`.
 */
export const ALERT_MAX_AGE_MS = 10 * MINUTE_MS;

/** basis: guessed — the feed down 10 min raises the Telegram self-alert (§8); verify: none needed
 * §8: feed down this long → Telegram self-alert.
 */
export const FEED_DOWN_ALERT_MS = 10 * MINUTE_MS;

/** basis: derived — three missed 5 min snapshot runs
 * Snapshots run every 5 minutes (SchedulerService.snapshotAll): three
 * missed runs make them stale.
 */
export const SNAPSHOT_STALE_MS = 15 * MINUTE_MS;

/** basis: guessed — the api waits 2 min for a copy worker to report the settlement loop on; verify: none needed
 * How long the api waits for a copy worker heartbeat that reports the
 * terminal settlement loop on, while its own loop is off.
 */
export const SETTLEMENT_OWNER_WINDOW_MS = 2 * MINUTE_MS;

/** basis: guessed — the api reads the workers for its guards every 30 s; verify: none needed
 * How often the api reads the workers on its own for its guards.
 */
export const WORKER_GUARD_CHECK_MS = 30_000;
