import { createHash } from 'node:crypto';
import { verifyTypedData } from 'viem';
import { liveStopCancellationIntentSchema, liveStopCancellationOwnerTypedData } from '@trading-dashboard/shared/contracts';

const MAX_TIME = 8640000000000000;

/** Canonical digest of a stored cancellation intent. Parsing fixes the field
 * order (JSONB reads reorder keys) and refuses any extra field, such as a
 * token or signature, before hashing. */
export function liveStopCancellationIntentDigest(value: unknown): string {
  const intent = liveStopCancellationIntentSchema.parse(structuredClone(value));
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

/** True only for the exact owner's signature over the exact intent, inside its
 * approval window. Malformed or hostile inputs return false, never throw. */
export async function verifyLiveStopCancellationConsent(value: unknown, signature: unknown, now: number): Promise<boolean> {
  try {
    // Detach the caller's object before any asynchronous step.
    const parsed = liveStopCancellationIntentSchema.safeParse(structuredClone(value));
    if (!parsed.success || typeof now !== 'number' || !Number.isSafeInteger(now) || now <= 0 || now > MAX_TIME) return false;
    const intent = parsed.data;
    if (now < intent.nonce || now >= intent.consentExpiresAt || now >= intent.expiresAt) return false;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
    return await verifyTypedData({ address: intent.ownerAddress as `0x${string}`,
      ...liveStopCancellationOwnerTypedData(intent), signature: signature as `0x${string}` });
  } catch { return false; }
}
