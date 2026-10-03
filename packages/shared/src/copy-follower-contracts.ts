import { z } from "zod";
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const copyFollowerStatementSchema = z.object({
  accountId: z.string(), strategyId: z.number().int().positive(), network: z.enum(["testnet", "mainnet"]), accountAddress: z.string(),
  token: z.literal("USDC"), receiptCount: z.string().regex(/^\d+$/),
  actual: z.object({ realizedPnl: decimal, exchangeFee: decimal, builderFee: decimal, funding: decimal, tradingCashDelta: decimal }),
  quarantine: z.object({ blocked: z.boolean(), reason: z.string().nullable() }),
  coverage: z.object({ historicalCompleteness: z.literal("unproven"), scannedThrough: z.string().datetime().nullable(),
    unresolvedWindows: z.number().int().nonnegative().nullable(), issue: z.string().nullable(), updatedAt: z.string().datetime().nullable() }),
  latestReceipts: z.array(z.object({ key: z.string(), kind: z.enum(["fill", "funding"]), coin: z.string(), time: z.string().datetime(),
    attribution: z.enum(["execution", "account"]), executionKey: z.string().nullable() })).max(50),
});
export type CopyFollowerStatement = z.infer<typeof copyFollowerStatementSchema>;
