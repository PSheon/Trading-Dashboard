import { createHash } from 'node:crypto';
import { copyStrategySettingsSchema } from '@trading-dashboard/shared/contracts';

export function liveCopySettingsDigest(value: unknown): string {
  // Parsing fixes the field ordering, including JSONB reads, and rejects any
  // accidental token/signature field before producing the immutable digest.
  const settings = copyStrategySettingsSchema.strict().parse(value);
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}
