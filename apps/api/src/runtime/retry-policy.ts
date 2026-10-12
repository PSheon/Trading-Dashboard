/** The `n`-th exponential wait (n = 0 is `baseMs`), capped at `maxMs`:
 * `min(max, base * 2 ** n)`, the formula the hand-written retry loops repeat
 * (architecture review E3 #5). Each caller keeps its own `n` (attempt - 1,
 * a capped exponent, …). */
export const expBackoff = (baseMs: number, maxMs: number, n: number): number => Math.min(maxMs, baseMs * 2 ** n);
