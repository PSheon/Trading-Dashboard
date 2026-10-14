import { PRIVY_IDENTITY_MAX_AGE_MS } from '../../config/constants/timings.js';

/** Whether an identity proof first read at `checkedAt` is still usable at `now`. */
export function privyIdentityFresh(checkedAt: number, now = Date.now()): boolean {
  return Number.isSafeInteger(checkedAt) && Number.isSafeInteger(now) && checkedAt > 0 && checkedAt <= now && now - checkedAt <= PRIVY_IDENTITY_MAX_AGE_MS;
}

/** One remote read of an identity proof: its name, its start from the proof's
 * first read, and how long it took (names and durations only). */
export interface IdentitySpan { readonly name: string; readonly atMs: number; readonly ms: number }

/** Times the reads of one identity proof, from its first read. */
export class IdentitySpans {
  readonly spans: IdentitySpan[] = [];
  constructor(readonly startedAt: number = Date.now(), private readonly now: () => number = Date.now) {}
  async time<T>(name: string, work: () => Promise<T>): Promise<T> {
    const start = this.now();
    try { return await work(); }
    finally { this.spans.push({ name, atMs: start - this.startedAt, ms: this.now() - start }); }
  }
  /** Elapsed since the first read. */
  elapsed(): number { return this.now() - this.startedAt; }
  toJSON() { return { elapsedMs: this.elapsed(), spans: this.spans }; }
}

/**
 * Settles every read and throws the first failure in the given order, so a
 * proof's error is the one its sequential reads would have raised (a
 * conflict before an unavailable later read), whatever finished first.
 */
export async function allInOrder<T extends readonly unknown[]>(work: { readonly [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(work as readonly Promise<unknown>[]);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  return settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
