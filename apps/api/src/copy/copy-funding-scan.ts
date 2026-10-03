import { z } from "zod";

/** Hyperliquid permits a nonce up to one day ahead of block time. */
export const FUNDING_NONCE_SKEW_MS = 86_400_000;
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const time = z.number().int().nonnegative().safe();
const units = z.string().max(32).regex(/^\d+(?:\.\d{1,6})?$/);
export const fundingScanSchema = z.object({
  version: z.literal(1),
  windows: z.array(z.object({ start: time, end: time, afterHash: hash.optional() }).refine((row) => row.start <= row.end)).max(64),
  receipts: z.array(z.object({ transactionHash: hash, creditedAmount: units, fee: units })).max(2),
}).strict();
export type FundingScan = z.infer<typeof fundingScanSchema>;
