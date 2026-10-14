import { z } from "zod";
import { backoffMs, FUNDING_RETRY_POLICY } from "./live/error-class.js";

/** A confirmation pass that failed (the explorer or the ledger unreachable,
 * the budget refused) waits before the row's next background pass:
 * backoffMs(failures − 1, FUNDING_RETRY_POLICY) (live/error-class.ts, THE
 * back-off table: 3 s doubling to 60 s). Kept on the row
 * (scan_state.backoff), so a restart or another replica honours it too. */
export const fundingBackoffMs = (failures: number): number => backoffMs(Math.max(failures, 1) - 1, FUNDING_RETRY_POLICY);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const time = z.number().int().nonnegative().safe();
const units = z.string().max(32).regex(/^\d+(?:\.\d{1,6})?$/);
// Only the fields consumed by fundingCreditEvidence are retained. Invalid
// fields remain null, and duplicate hash rows remain duplicated: neither can
// become positive credit evidence by being omitted from the checkpoint.
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
  /** Ledger transfers from this source to this destination seen in this
   * cycle, proven or not: any at all means "no credit" is not known. */
  seen: z.number().int().nonnegative().max(1_000_000).optional(),
  /** Already-read ledger evidence awaiting explorer details. A quota failure
   * resumes here after restart instead of paying for the ledger again. */
  pendingDetails: z.array(z.object({ hash, ledger: z.array(ledgerRow).min(1).max(2) }).strict()).max(5).optional(),
  /** Consecutive failed passes and when the next background pass is due
   * (fundingBackoffMs). Bookkeeping only: written without a scan revision,
   * cleared by the next pass that reads anything. */
  backoff: z.object({ failures: z.number().int().positive().max(1_000_000), nextAt: time }).strict().optional(),
  /** Since when this row's explorer reads have failed for the network
   * (funding_explorer_unreachable) with none answering in between: kept
   * with the backoff, cleared by the next detail the explorer answers. */
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
