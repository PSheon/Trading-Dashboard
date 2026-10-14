/**
 * Clock units every other group and the rest of the api count in.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */

/** basis: derived — 60 s
 */
export const MINUTE_MS = 60_000;

/** basis: derived — 60 minutes
 */
export const HOUR_MS = 60 * MINUTE_MS;

/** basis: derived — 24 hours
 */
export const DAY_MS = 24 * HOUR_MS;
