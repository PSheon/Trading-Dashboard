import { createHash } from 'node:crypto';
import { verifyTypedData } from 'viem';
import { liveCopyMandateIntentSchema, liveCopyMandateOwnerTypedData, copyStrategySettingsSchema, type LiveCopyMandateIntent } from '@trading-dashboard/shared/contracts';

export function liveCopySettingsDigest(value: unknown): string {
  // Parsing fixes the field ordering, including JSONB reads, and rejects any
  // accidental token/signature field before producing the immutable digest.
  const settings = copyStrategySettingsSchema.strict().parse(value);
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

export async function verifyLiveCopyMandateConsent(value: LiveCopyMandateIntent, signature: string, now = Date.now()): Promise<boolean> {
  // Detach caller-owned identity before asynchronous signature verification.
  const parsed = liveCopyMandateIntentSchema.safeParse(structuredClone(value));
  if (!parsed.success || !Number.isSafeInteger(now) || now < parsed.data.nonce || now >= parsed.data.consentExpiresAt ||
      typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    return await verifyTypedData({ address: parsed.data.ownerAddress as `0x${string}`,
      ...liveCopyMandateOwnerTypedData(parsed.data), signature: signature as `0x${string}` });
  } catch { return false; }
}
