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
