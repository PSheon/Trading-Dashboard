import { z } from "zod";

/** Hyperliquid permits a nonce up to one day ahead of block time. */
export const FUNDING_NONCE_SKEW_MS = 86_400_000;
/** …and down to two days behind it (docs: "Nonces must be within (T - 2 days,
 * T + 1 day)"): a transfer signed with an older nonce can no longer execute.
 * An hour of margin on top. */
export const FUNDING_NONCE_EXPIRY_MS = 2 * 86_400_000 + 3_600_000;
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
}).strict();
export type FundingScan = z.infer<typeof fundingScanSchema>;

export function fundingDetailBatch(hashes: string[], rows: Array<{ hash: string; time: number; delta: Record<string, unknown> }>): NonNullable<FundingScan['pendingDetails']> {
  const field = (value: unknown) => typeof value === 'string' && value.length <= 128 ? value : null;
  return hashes.map(hash => ({ hash, ledger: rows.filter(row => row.hash === hash).slice(0, 2).map(row => ({
    hash, time: Number.isSafeInteger(row.time) && row.time >= 0 ? row.time : null,
    delta: { type: field(row.delta.type), user: field(row.delta.user), destination: field(row.delta.destination), usdc: field(row.delta.usdc), fee: field(row.delta.fee) },
  })) }));
}
