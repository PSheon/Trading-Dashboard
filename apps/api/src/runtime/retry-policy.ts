/** The `n`-th exponential wait (n = 0 is `baseMs`), capped at `maxMs`.
 * Each caller keeps its own `n` (attempt - 1, a capped exponent, …). */
export const expBackoff = (baseMs: number, maxMs: number, n: number): number => Math.min(maxMs, baseMs * 2 ** n);
