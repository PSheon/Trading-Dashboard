import { createHash } from 'node:crypto';
import { liveStopCancellationIntentSchema } from '@trading-dashboard/shared/contracts';

/** Canonical digest of a stored cancellation intent (the owner's
 * cancellation consents recorded before the one signing model: the stopper
 * still honours them; no new ones are taken). Parsing fixes the field
 * order (JSONB reads reorder keys) and refuses any extra field, such as a
 * token or signature, before hashing. */
export function liveStopCancellationIntentDigest(value: unknown): string {
  const intent = liveStopCancellationIntentSchema.parse(structuredClone(value));
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
