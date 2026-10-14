import { createHash } from 'node:crypto';
import { MAX_LIVE_LEG_ATTEMPTS } from '../../config/constants/limits.js';

/** Stable economic identity of one attempt of one leader leg, independent of
 * a worker, quote or retry time. Attempt 0 is the original derivation
 * (unchanged); attempt k > 0 adds k to it. */
export function liveSourceExecutionCloid(mandateId: string, sourceFillId: string, leg: 'open' | 'close', attempt = 0): `0x${string}` {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= MAX_LIVE_LEG_ATTEMPTS) throw new RangeError('live_leg_attempt_invalid');
  const parts: unknown[] = ['live-copy-v1', mandateId, sourceFillId, leg, ...(attempt ? [attempt] : [])];
  return `0x${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

/** Which attempt of this leg `cloid` is (0 .. MAX_LIVE_LEG_ATTEMPTS - 1), or
 * null when it is not one of the leg's derived order identities. */
export function liveSourceExecutionAttempt(mandateId: string, sourceFillId: string, leg: 'open' | 'close', cloid: string): number | null {
  for (let attempt = 0; attempt < MAX_LIVE_LEG_ATTEMPTS; attempt++)
    if (liveSourceExecutionCloid(mandateId, sourceFillId, leg, attempt) === cloid) return attempt;
  return null;
}
