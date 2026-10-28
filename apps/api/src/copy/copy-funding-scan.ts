import { z } from "zod";
import { backoffMs, FUNDING_RETRY_POLICY } from "./live/error-class.js";

/** Wait after a failed confirmation pass (3 s doubling to 60 s, FUNDING_RETRY_POLICY); kept on the
 * row so restarts and replicas honour it. */
export const fundingBackoffMs = (failures: number): number => backoffMs(Math.max(failures, 1) - 1, FUNDING_RETRY_POLICY);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const time = z.number().int().nonnegative();
const units = z.string().max(32).regex(/^\d+(?:\.\d{1,6})?$/);
// Only fundingCreditEvidence's fields; invalid stay null and duplicates stay duplicated, so
// nothing becomes credit evidence by omission.
const ledgerRow = z.object({ hash, time: time.nullable(), delta: z.object({
  type: z.string().max(128).nullable(), user: z.string().max(128).nullable(),
  destination: z.string().max(128).nullable(), usdc: z.string().max(128).nullable(), fee: z.string().max(128).nullable(),
}).strict() }).strict();
export const fundingScanSchema = z.object({
  version: z.literal(1),
  windows: z.array(z.object({ start: time, end: time, afterHash: hash.optional() }).refine((row) => row.start <= row.end)).max(64),
  receipts: z.array(z.object({ transactionHash: hash, creditedAmount: units, fee: units })).max(2),
  /** Where this scan cycle's ledger read ends (frozen when it starts). */
  cycleEnd: time.optional(),
  /** Source → destination transfers seen this cycle, proven or not: any rules out "never executed". */
  seen: z.number().int().nonnegative().max(1_000_000).optional(),
  /** Read ledger evidence awaiting explorer details (resumed without re-reading the ledger). */
  pendingDetails: z.array(z.object({ hash, ledger: z.array(ledgerRow).min(1).max(2) }).strict()).max(5).optional(),
  /** Failed passes and next due time; written without a scan revision, cleared by a successful read. */
  backoff: z.object({ failures: z.number().int().positive().max(1_000_000), nextAt: time }).strict().optional(),
  /** Start of the current explorer outage for this row; cleared when the explorer answers. */
  explorerFailingSince: time.optional(),
}).strict();
export type FundingScan = z.infer<typeof fundingScanSchema>;

export function fundingDetailBatch(hashes: string[], rows: Array<{ hash: string; time: number; delta: Record<string, unknown> }>): NonNullable<FundingScan['pendingDetails']> {
  const field = (value: unknown) => typeof value === 'string' && value.length <= 128 ? value : null;
  return hashes.map(hash => ({ hash, ledger: rows.filter(row => row.hash === hash).slice(0, 2).map(row => ({
    hash, time: Number.isSafeInteger(row.time) && row.time >= 0 ? row.time : null,
    delta: { type: field(row.delta.type), user: field(row.delta.user), destination: field(row.delta.destination), usdc: field(row.delta.usdc), fee: field(row.delta.fee) },
  })) }));
}
