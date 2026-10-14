import { createHash } from 'node:crypto';
import { liveStopCancellationIntentSchema } from '@trading-dashboard/shared/contracts';

/** Canonical digest of a stored legacy cancellation intent (still honoured, no new ones taken).
 * Parsing fixes field order (JSONB reorders keys) and refuses extra fields before hashing. */
export function liveStopCancellationIntentDigest(value: unknown): string {
  const intent = liveStopCancellationIntentSchema.parse(structuredClone(value));
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
