/**
 * Clock units every other group and the rest of the api count in.
 *
 * Every constant states its basis on the first comment line (AGENTS.md):
 * measured (a gate, a harness or the provider's docs), derived (from another
 * constant), copied (from another check, with no reason of its own) or
 * guessed (a number that looked right; it says how it will be verified).
 * test/tuning-constants.spec.ts keeps every tuning constant here, unique,
 * with its basis.
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
