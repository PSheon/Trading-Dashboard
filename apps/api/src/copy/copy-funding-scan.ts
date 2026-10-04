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
export const fundingScanSchema = z.object({
  version: z.literal(1),
  windows: z.array(z.object({ start: time, end: time, afterHash: hash.optional() }).refine((row) => row.start <= row.end)).max(64),
  receipts: z.array(z.object({ transactionHash: hash, creditedAmount: units, fee: units })).max(2),
  /** Where this scan cycle's ledger read ends (frozen when it starts). */
  cycleEnd: time.optional(),
  /** Ledger transfers from this source to this destination seen in this
   * cycle, proven or not: any at all means "no credit" is not known. */
  seen: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict();
export type FundingScan = z.infer<typeof fundingScanSchema>;
