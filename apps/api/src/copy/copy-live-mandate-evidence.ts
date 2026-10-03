import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { liveCopyMandateIntentSchema, type LiveCopyMandateIntent } from '@trading-dashboard/shared/contracts';
import type { copyLiveMandates } from '@trading-dashboard/shared/database';

export type MandateRow = typeof copyLiveMandates.$inferSelect;
export const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Pure exact decoder: SQL readers must verify every persisted identity against
 * the canonical immutable intent before using a generation as authority. */
export function decodeLiveCopyMandate(row: MandateRow): LiveCopyMandateIntent {
  const parsed = liveCopyMandateIntentSchema.safeParse(row.intent);
  if (!parsed.success || digest(parsed.data) !== row.intentDigest) throw new ConflictException('Live mandate binding changed');
  const intent = parsed.data;
  for (const [key, value] of Object.entries(intent)) {
    const actual = key === 'mandateId' ? row.id : key === 'consentExpiresAt' ? row.consentExpiresAt.getTime() : key === 'expiresAt' ? row.expiresAt.getTime() : row[key as keyof MandateRow];
    if (actual !== value) throw new ConflictException('Live mandate binding changed');
  }
  return intent;
}
