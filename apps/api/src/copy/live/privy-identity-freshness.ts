/**
 * How old a Privy identity proof may be when a setup decision rests on it: a
 * wallet's id, address and owner quorum, a policy's content fingerprint, a key
 * quorum's members. Measured from the proof's first read.
 *
 * Not Hyperliquid's 5 s. That bound is for exchange evidence (positions,
 * orders, an agent list, a mode), which changes from one second to the next.
 * These identities are immutable (a wallet's id, address and external id) or
 * change only by an owner's or an admin's explicit action (a policy, a
 * signer, a quorum). Privy also enforces the wallet's current policy and
 * signers at every signature, so an identity that changed after the read
 * still can't sign outside them. The 5 s bound was copied here from the
 * exchange checks (feat(copy) 22f9e963): one proof is up to a dozen Privy
 * HTTPS calls (~0.4–0.5 s each from a developer's link, more on a phone
 * hotspot), so it could not pass at all over a slower link (gate run 8,
 * 2026-10-13 12:51: `agent_identity_evidence_expired` every pass, the agent's
 * approval never recorded).
 *
 * 30 s: the reads now run in parallel (about three round trips on the
 * critical path), so this holds three of the Privy client's 10 s request
 * timeouts end to end, and stays far inside the decisions it guards (a
 * consent's and a nonce's five-minute windows).
 */
export const PRIVY_IDENTITY_MAX_AGE_MS = 30_000;

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
