/**
 * Copy trading contracts (Stage 4 step 3, paper mode).
 *
 * CopyDog's copy configuration, read from its Hyperliquid copy widget
 * (`POST /api/copy-trading/configure`), is mirrored field for field:
 * `copy_direction` (same | reverse), `allocation_amount`, `allocation_mode`
 * (ratio, the Hyperliquid default | fixed), `max_total_exposure` (null),
 * `max_leverage` (null) and `copy_start_mode` (adopt = 跟單目前持倉 on, the
 * default | delta). CopyDog has no take-profit / stop-loss or minimum-order
 * field; the minimum order is a platform risk limit here.
 */
import { z } from "zod";

import {
  copyControlCommandEnum,
  copyDirectionEnum,
  copyLegEnum,
  copyOrderStatusEnum,
  copySizingModeEnum,
  copyStartModeEnum,
  copyStrategyStatusEnum,
  copyTradingModeEnum,
} from "../enums.js";

/** Leader addresses are compared and stored lower-case everywhere (dedupe,
 * one live copy per leader, signal matching, DB uniqueness). */
const address = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v.toLowerCase());
const usd = z.number().finite();
/** A USDC amount a user or admin types: at most 6 decimals (USDC's own
 * precision), so what is validated is exactly what is stored. */
const usdAmount = z.number().finite().refine((v) => Number(v.toFixed(6)) === v, "At most 6 decimals");
export const copyIdempotencyKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);

/**
 * The one comparison key of a Hyperliquid perp name, used when an admin saves
 * a coin list and when a signal is checked against it. Hyperliquid names are
 * case-sensitive in spelling (`kPEPE`) but never differ only by case, so the
 * key is case-insensitive; a HIP-3 name keeps its `dex:` prefix.
 */
export function coinKey(coin: string): string {
  return coin.trim().toLowerCase();
}

/** The dex of a perp name: "" for the main dex, else the HIP-3 prefix
 * ("xyz" for "xyz:TSLA"), exactly as fills and positions name them. */
export function coinDex(coin: string): string {
  const i = coin.indexOf(":");
  return i < 0 ? "" : coin.slice(0, i).trim().toLowerCase();
}

export const copyDirectionSchema = z.enum(copyDirectionEnum);
export const copySizingModeSchema = z.enum(copySizingModeEnum);
export const copyStartModeSchema = z.enum(copyStartModeEnum);
export const copyStrategyStatusSchema = z.enum(copyStrategyStatusEnum);
export const copyOrderStatusSchema = z.enum(copyOrderStatusEnum);
export const copyLegSchema = z.enum(copyLegEnum);
export const copyControlCommandSchema = z.enum(copyControlCommandEnum);
export const copyTradingModeSchema = z.enum(copyTradingModeEnum);

/**
 * Platform hard caps, edited by admins with `risk.manage` as a form and
 * stored as immutable versions (copy_risk_policies). Defaults are the
 * values in force before any admin edit.
 */
export const copyRiskLimitsSchema = z.object({
  /** Virtual USDC a user's paper account starts with. */
  paperStartingBalanceUsd: usd.min(0).max(10_000_000).default(10_000),
  /** CopyDog: "Minimum allocation to copy a Hyperliquid trader is $100". */
  minAllocationUsd: usd.min(0).max(1_000_000).default(100),
  maxAllocationUsd: usd.min(1).max(10_000_000).default(100_000),
  maxStrategiesPerUser: z.number().int().min(1).max(100).default(10),
  /** Per strategy: open notional ÷ equity. Also caps a strategy's own max_leverage. */
  maxLeverage: usd.min(1).max(50).default(10),
  maxOrderNotionalUsd: usd.min(1).max(10_000_000).default(50_000),
  /** Hyperliquid rejects orders under $10 notional. */
  minOrderNotionalUsd: usd.min(0).max(100_000).default(10),
  /** Per user, one coin across all of their strategies (absolute notional). */
  maxCoinExposureUsd: usd.min(1).max(100_000_000).default(100_000),
  /** Per user, all coins across all strategies. */
  maxUserExposureUsd: usd.min(1).max(100_000_000).default(250_000),
  /** An open is rejected when the mid moved more than this from the leader's fill price. */
  maxSlippageBps: usd.min(0).max(10_000).default(50),
  /** Paper fills pay this against the mid (buys higher, sells lower). */
  simulatedSlippageBps: usd.min(0).max(1_000).default(5),
  /** Hyperliquid's base-tier taker fee is 0.045%. */
  takerFeeBps: usd.min(0).max(100).default(4.5),
  /** Opens from leader fills older than this are not copied (reductions always are). */
  maxSignalAgeSeconds: z.number().int().min(1).max(86_400).default(120),
  /** Orders a strategy may create per rolling minute. */
  maxOrdersPerMinute: z.number().int().min(1).max(1_000).default(30),
  /** HIP-3 builder-dex markets (`xyz:TSLA`). Off: only the main perp dex is copied. */
  allowHip3: z.boolean().default(false),
  /** Coins never copied. Matched with {@link coinKey}; the admin service
   * stores each entry in Hyperliquid's own spelling and rejects unknown names. */
  blockedCoins: z.array(z.string().trim().min(1).max(80)
    // Venue names are provider identities, including actual testnet i<3fl.
    // The admin service still resolves every accepted spelling against meta.
    .regex(/^(?:[^\s:/@\\]{1,40}:)?[A-Za-z0-9]+$/, "A Hyperliquid perp name, e.g. BTC, kPEPE or xyz:TSLA")
    .refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), "No control bytes"))
    .max(200).default([])
    .transform((list) => [...new Map(list.map((c) => [coinKey(c), c.trim()])).values()]),
}).strict().superRefine((v, ctx) => {
  // Reject a policy no order could ever satisfy.
  if (v.minAllocationUsd > v.maxAllocationUsd) ctx.addIssue({ code: "custom", path: ["minAllocationUsd"], message: "Must not exceed maxAllocationUsd" });
  if (v.minOrderNotionalUsd > v.maxOrderNotionalUsd) ctx.addIssue({ code: "custom", path: ["minOrderNotionalUsd"], message: "Must not exceed maxOrderNotionalUsd" });
  if (v.maxCoinExposureUsd > v.maxUserExposureUsd) ctx.addIssue({ code: "custom", path: ["maxCoinExposureUsd"], message: "Must not exceed maxUserExposureUsd" });
  if (v.minOrderNotionalUsd > v.maxCoinExposureUsd) ctx.addIssue({ code: "custom", path: ["minOrderNotionalUsd"], message: "Must not exceed maxCoinExposureUsd" });
});
export type CopyRiskLimits = z.infer<typeof copyRiskLimitsSchema>;
export const DEFAULT_COPY_RISK_LIMITS: CopyRiskLimits = copyRiskLimitsSchema.parse({});

export const copyStrategySettingsSchema = z.object({
  direction: copyDirectionSchema,
  sizingMode: copySizingModeSchema,
  perTradeUsd: usd.positive().nullable(),
  maxTotalExposureUsd: usd.positive().nullable(),
  maxLeverage: usd.min(1).max(50).nullable(),
  copyStartMode: copyStartModeSchema,
});
export type CopyStrategySettings = z.infer<typeof copyStrategySettingsSchema>;

/** POST /me/copy/strategies — CopyDog's configure body, Orbie names. */
export const createCopyStrategyRequestSchema = z.object({
  idempotencyKey: copyIdempotencyKeySchema.optional(),
  leader: address,
  direction: copyDirectionSchema.default("same"),
  allocationUsd: usdAmount.pipe(z.number().positive()),
  sizingMode: copySizingModeSchema.default("ratio"),
  perTradeUsd: usdAmount.pipe(z.number().positive()).nullable().default(null),
  maxTotalExposureUsd: usdAmount.pipe(z.number().positive()).nullable().default(null),
  maxLeverage: usd.min(1).max(50).nullable().default(null),
  copyStartMode: copyStartModeSchema.default("adopt"),
}).strict();
export type CreateCopyStrategyRequest = z.infer<typeof createCopyStrategyRequestSchema>;

/** PATCH /me/copy/strategies/:id — CopyDog's 跟單交易設定 (edit) dialog: a new strategy version. */
export const patchCopyStrategyRequestSchema = z.object({
  sizingMode: copySizingModeSchema.optional(),
  perTradeUsd: usdAmount.pipe(z.number().positive()).nullable().optional(),
  maxTotalExposureUsd: usdAmount.pipe(z.number().positive()).nullable().optional(),
  maxLeverage: usd.min(1).max(50).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "Empty patch");
export type PatchCopyStrategyRequest = z.infer<typeof patchCopyStrategyRequestSchema>;

/** POST /me/copy/strategies/:id/funds — CopyDog's 加碼. */
export const addCopyFundsRequestSchema = z.object({ amountUsd: usdAmount.pipe(z.number().positive()), idempotencyKey: copyIdempotencyKeySchema.optional() }).strict();
export type AddCopyFundsRequest = z.infer<typeof addCopyFundsRequestSchema>;
export const withdrawCopyFundsRequestSchema = addCopyFundsRequestSchema;
export type WithdrawCopyFundsRequest = z.infer<typeof withdrawCopyFundsRequestSchema>;

/** The owner's commands on one strategy. pause = pause_new_risk; stop =
 * close_positions, then the strategy's cash returns to the paper balance. */
export const copyStrategyCommandSchema = z.enum(["pause", "resume", "reduce_only", "cancel_pending", "close_positions", "stop"]);
export type CopyStrategyCommand = z.infer<typeof copyStrategyCommandSchema>;
export const copyStrategyCommandRequestSchema = z.object({ command: copyStrategyCommandSchema, idempotencyKey: copyIdempotencyKeySchema.optional() }).strict();

export const copyControlStateSchema = z.object({
  pauseNewRisk: z.boolean(),
  reduceOnly: z.boolean(),
  revision: z.number().int(),
});
export type CopyControlState = z.infer<typeof copyControlStateSchema>;

export const copyPositionSchema = z.object({
  coin: z.string(),
  /** Signed coin size: long > 0. */
  size: z.number(),
  entryPx: z.number(),
  /** Mid used for valuation; null when prices are unavailable (PnL is then null, never 0). */
  markPx: z.number().nullable(),
  notionalUsd: z.number().nullable(),
  unrealizedPnl: z.number().nullable(),
  realizedPnl: z.number(),
  funding: z.number(),
  openedAt: z.coerce.date(),
});
export type CopyPosition = z.infer<typeof copyPositionSchema>;

/** One of the leader's positions at the start of a copy. `adopted` means an
 * order was approved for it (it fills on the worker's next pass); otherwise
 * `reason` is the refusal, the same text an order's `reason` carries
 * (`symbol_not_allowed`, `below_min_notional`, `symbol_blocked`, …). */
export const copyAdoptionSchema = z.object({
  coin: z.string(),
  adopted: z.boolean(),
  reason: z.string().nullable(),
  /** Coin size ordered (0 when not adopted). */
  size: z.number(),
});
export type CopyAdoption = z.infer<typeof copyAdoptionSchema>;

export const copyStrategySchema = z.object({
  id: z.number().int(),
  mode: z.literal("paper"),
  leaderAddress: z.string(),
  status: copyStrategyStatusSchema,
  version: z.number().int(),
  settings: copyStrategySettingsSchema,
  allocated: z.number(),
  withdrawn: z.number().optional(),
  freeCollateralUsd: z.number().nullable().optional(),
  cash: z.number(),
  /** cash + unrealized; null while prices are unavailable and a position is open. */
  equity: z.number().nullable(),
  unrealizedPnl: z.number().nullable(),
  realizedPnl: z.number(),
  fees: z.number(),
  funding: z.number(),
  /** equity − allocated. */
  totalPnl: z.number().nullable(),
  roiPct: z.number().nullable(),
  exposureUsd: z.number().nullable(),
  pauseNewRisk: z.boolean(),
  reduceOnly: z.boolean(),
  tradesCopied: z.number().int(),
  pendingOrders: z.number().int(),
  positions: z.array(copyPositionSchema),
  activatedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  stoppedAt: z.coerce.date().nullable(),
  /** Only on the answer to starting a copy with 跟單目前持倉: every position
   * the leader held, and whether it was adopted (review 39). */
  adoption: z.array(copyAdoptionSchema).optional(),
});
export type CopyStrategy = z.infer<typeof copyStrategySchema>;

/** GET /me/copy — the paper account and every copy of the signed-in user. */
export const copyOverviewResponseSchema = z.object({
  mode: copyTradingModeSchema,
  paper: z.object({
    balance: z.number(),
    startingBalance: z.number(),
    allocated: z.number(),
    /** balance + every live strategy's equity; null while any equity is unknown. */
    totalValue: z.number().nullable(),
    totalPnl: z.number().nullable(),
  }),
  limits: z.object({ minAllocationUsd: z.number(), maxAllocationUsd: z.number(), maxStrategies: z.number().int() }),
  platform: copyControlStateSchema,
  user: copyControlStateSchema,
  strategies: z.array(copyStrategySchema),
  pricedAt: z.coerce.date().nullable(),
});
export type CopyOverviewResponse = z.infer<typeof copyOverviewResponseSchema>;

export const copyOrderSchema = z.object({
  id: z.string(),
  cloid: z.string(),
  strategyId: z.number().int(),
  userId: z.number().int(),
  leaderAddress: z.string(),
  coin: z.string(),
  leg: copyLegSchema,
  side: z.enum(["B", "A"]),
  reduceOnly: z.boolean(),
  size: z.number(),
  signalPx: z.number(),
  signalTime: z.coerce.date(),
  status: copyOrderStatusSchema,
  reason: z.string().nullable(),
  filledSize: z.number(),
  avgPx: z.number().nullable(),
  fee: z.number(),
  builderFee: z.number(),
  strategyVersion: z.number().int(),
  riskPolicyVersion: z.number().int(),
  executionPolicyVersion: z.number().int().nullable().optional(),
  executionStrategyVersion: z.number().int().nullable().optional(),
  executionFeeSnapshot: z.object({ takerFeeBps: z.number(), builderFeeTenthsBps: z.number() }).nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CopyOrder = z.infer<typeof copyOrderSchema>;
export const copyOrdersQuerySchema = z.object({
  before: z.string().regex(/^[1-9]\d{0,18}$/).refine((v) => BigInt(v) <= 9223372036854775807n).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict();
export const copyOrdersResponseSchema = z.object({ items: z.array(copyOrderSchema),
  previousCursor: z.string().regex(/^\d+$/).nullable().optional(), hasMore: z.boolean().optional(),
});
export type CopyOrdersResponse = z.infer<typeof copyOrdersResponseSchema>;

/** Exact persisted paper accounting; wire decimals stay strings. */
const copyHistoryDecimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const copyLedgerEntrySchema = z.object({
  id: z.string().regex(/^\d+$/), kind: z.string(), amount: copyHistoryDecimal,
  coin: z.string().nullable(), orderId: z.string().nullable(), createdAt: z.coerce.date(),
});
export const copyFillEntrySchema = z.object({
  id: z.string().regex(/^\d+$/), orderId: z.string(), coin: z.string(), side: z.enum(["B", "A"]),
  size: copyHistoryDecimal, px: copyHistoryDecimal, fee: copyHistoryDecimal,
  builderFee: copyHistoryDecimal, realizedPnl: copyHistoryDecimal, ts: z.coerce.date(),
});
const copyHistoryPage = z.object({ mode: z.literal("paper"), previousCursor: z.string().nullable(), hasMore: z.boolean() });
export const copyLedgerResponseSchema = copyHistoryPage.extend({ items: z.array(copyLedgerEntrySchema) });
export const copyFillsResponseSchema = copyHistoryPage.extend({ items: z.array(copyFillEntrySchema) });
export type CopyLedgerResponse = z.infer<typeof copyLedgerResponseSchema>;
export type CopyFillsResponse = z.infer<typeof copyFillsResponseSchema>;

// --- admin ------------------------------------------------------------------

/** POST /admin/copy/controls — a stop / resume command at platform or user
 * level. `expectedRevision` must equal the scope's current revision (409
 * otherwise), so a stale screen can't undo a newer command. */
const controlCommon = {
  command: copyControlCommandSchema,
  reason: z.string().trim().min(3).max(500),
  expectedRevision: z.number().int().min(0),
};
/** The target is exactly one of: the platform (no userId), or one user
 * (userId required). Authorization and the command act on this parsed
 * target only. */
export const adminCopyControlRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("platform"), ...controlCommon }).strict(),
  z.object({ scope: z.literal("user"), userId: z.number().int().positive().max(2_147_483_647), ...controlCommon }).strict(),
]);
export type AdminCopyControlRequest = z.infer<typeof adminCopyControlRequestSchema>;

export const copyControlEventSchema = z.object({
  id: z.string(),
  scope: z.enum(["platform", "user", "strategy"]),
  scopeId: z.number().int(),
  command: copyControlCommandSchema,
  revision: z.number().int(),
  actorUserId: z.number().int().nullable(),
  actorEmail: z.string().nullable(),
  reason: z.string().nullable(),
  result: z.object({ cancelledOrders: z.number().int(), closeOrders: z.number().int() }),
  createdAt: z.coerce.date(),
});
export type CopyControlEvent = z.infer<typeof copyControlEventSchema>;

export const adminCopyControlResponseSchema = z.object({
  scope: z.enum(["platform", "user"]),
  scopeId: z.number().int(),
  state: copyControlStateSchema,
  event: copyControlEventSchema,
});
export type AdminCopyControlResponse = z.infer<typeof adminCopyControlResponseSchema>;

/** Failed execution attempts after which an order is reported to the
 * operator and listed in /admin/copy. */
export const COPY_STUCK_ORDER_ATTEMPTS = 5;

export const adminCopyOverviewSchema = z.object({
  mode: copyTradingModeSchema,
  platform: copyControlStateSchema.extend({ updatedAt: z.coerce.date().nullable() }),
  strategies: z.record(copyStrategyStatusSchema, z.number().int()),
  orders24h: z.record(copyOrderStatusSchema, z.number().int()),
  outbox: z.object({
    pending: z.number().int(),
    failed: z.number().int(),
    /** Checkpoint of the copy signal consumer (outbox id). */
    checkpoint: z.string(),
    oldestPendingAt: z.coerce.date().nullable(),
  }),
  riskPolicyVersion: z.number().int(),
  events: z.array(copyControlEventSchema),
  /** Orders whose execution keeps failing (attempts ≥ the alert threshold):
   * each one holds its strategy's later orders until it goes through.
   * Optional while older APIs roll out. */
  stuckOrders: z.array(z.object({
    id: z.string(), strategyId: z.number().int(), userId: z.number().int(), coin: z.string(), leg: copyLegSchema,
    reduceOnly: z.boolean(), attempts: z.number().int(), lastError: z.string().nullable(), since: z.coerce.date(),
  })).optional(),
});
export type AdminCopyOverview = z.infer<typeof adminCopyOverviewSchema>;

export const adminCopyStrategySchema = copyStrategySchema.extend({
  userId: z.number().int(),
  userEmail: z.string().nullable(),
});
export type AdminCopyStrategy = z.infer<typeof adminCopyStrategySchema>;
export const adminCopyStrategiesResponseSchema = z.object({ items: z.array(adminCopyStrategySchema) });
export type AdminCopyStrategiesResponse = z.infer<typeof adminCopyStrategiesResponseSchema>;

export const adminCopyStrategyDetailSchema = z.object({
  strategy: adminCopyStrategySchema,
  versions: z.array(z.object({ version: z.number().int(), settings: copyStrategySettingsSchema, createdAt: z.coerce.date() })),
  orders: z.array(copyOrderSchema),
  ledger: z.array(z.object({ id: z.string(), kind: z.string(), amount: z.number(), coin: z.string().nullable(), orderId: z.string().nullable(), createdAt: z.coerce.date() })),
});
export type AdminCopyStrategyDetail = z.infer<typeof adminCopyStrategyDetailSchema>;

export const adminCopyOrdersResponseSchema = z.object({ items: z.array(copyOrderSchema.extend({ userEmail: z.string().nullable() })) });
export type AdminCopyOrdersResponse = z.infer<typeof adminCopyOrdersResponseSchema>;

export const adminCopyExposureSchema = z.object({
  userId: z.number().int(),
  userEmail: z.string().nullable(),
  strategies: z.number().int(),
  allocated: z.number(),
  equity: z.number().nullable(),
  exposureUsd: z.number().nullable(),
  coins: z.array(z.object({ coin: z.string(), longUsd: z.number(), shortUsd: z.number(), netUsd: z.number() })),
  control: copyControlStateSchema,
});
export const adminCopyExposureResponseSchema = z.object({ items: z.array(adminCopyExposureSchema), pricedAt: z.coerce.date().nullable() });
export type AdminCopyExposureResponse = z.infer<typeof adminCopyExposureResponseSchema>;

export const adminCopyRiskResponseSchema = z.object({
  version: z.number().int(),
  limits: copyRiskLimitsSchema,
  reason: z.string().nullable(),
  createdAt: z.coerce.date().nullable(),
  history: z.array(z.object({ version: z.number().int(), reason: z.string().nullable(), createdByUserId: z.number().int().nullable(), createdAt: z.coerce.date() })),
});
export type AdminCopyRiskResponse = z.infer<typeof adminCopyRiskResponseSchema>;

/** PUT /admin/copy/risk — a whole new policy version. */
export const putCopyRiskRequestSchema = z.object({
  limits: copyRiskLimitsSchema,
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().min(0),
}).strict();
export type PutCopyRiskRequest = z.infer<typeof putCopyRiskRequestSchema>;

/** A testnet copy's budget in USDC (up to six decimals, positive). */
export const liveCopyBudgetSchema = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/).max(32)
  .refine(value => /[1-9]/.test(value), 'Positive budget required');
