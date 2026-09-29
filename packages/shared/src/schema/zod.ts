/**
 * Zod schemas + inferred TS types for the §6 data model and for the
 * API request/response shapes shared between apps/web and apps/api.
 *
 * These are intentionally permissive placeholders for the M1 scaffold —
 * no business logic validates against them yet, but the shapes are wired
 * so both apps can import the same contracts.
 */

import { z } from "zod";

export const chainSchema = z.literal("hyperliquid");
export type Chain = z.infer<typeof chainSchema>;

export const tierSchema = z.enum(["A", "B", "C"]);
export type TierInput = z.infer<typeof tierSchema>;

export const actionKindSchema = z.enum([
  "open",
  "add",
  "reduce",
  "close",
  "flip",
  "liquidation",
]);
export type ActionKindInput = z.infer<typeof actionKindSchema>;

export const alertRuleScopeSchema = z.enum(["address", "group"]);
export const alertRuleKindSchema = z.enum([
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
  "R7",
  "R8",
  "R9",
]);
export const sendStatusSchema = z.enum(["pending", "sent", "failed", "dry_run"]);

// ---------------------------------------------------------------------------
// Entity schemas (mirror packages/shared/src/schema/db.ts)
// ---------------------------------------------------------------------------

export const leaderListSchema = z.object({
  id: z.number().int(),
  source: z.string(),
  importedAt: z.coerce.date(),
  fileName: z.string(),
});
export type LeaderList = z.infer<typeof leaderListSchema>;

export const leaderListItemSchema = z.object({
  listId: z.number().int(),
  address: z.string(),
  rank: z.number().int(),
  statsJson: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type LeaderListItem = z.infer<typeof leaderListItemSchema>;

export const leaderSchema = z.object({
  chain: chainSchema,
  address: z.string(),
  label: z.string().nullable().optional(),
  tier: tierSchema,
  notes: z.string().nullable().optional(),
  active: z.boolean(),
  source: z.enum(["import", "favorite"]).default("import"),
  firstSeenAt: z.coerce.date(),
});
export type Leader = z.infer<typeof leaderSchema>;

export const fillSchema = z.object({
  chain: chainSchema,
  tid: z.union([z.bigint(), z.string(), z.number()]),
  address: z.string(),
  coin: z.string(),
  side: z.string(),
  dir: z.string(),
  px: z.union([z.string(), z.number()]),
  sz: z.union([z.string(), z.number()]),
  fee: z.union([z.string(), z.number()]),
  closedPnl: z.union([z.string(), z.number()]).nullable().optional(),
  hash: z.string().nullable().optional(),
  ts: z.coerce.date(),
  raw: z.record(z.string(), z.unknown()),
});
export type Fill = z.infer<typeof fillSchema>;

export const actionSchema = z.object({
  id: z.union([z.bigint(), z.string(), z.number()]),
  chain: chainSchema,
  address: z.string(),
  coin: z.string(),
  kind: actionKindSchema,
  side: z.string(),
  notionalUsd: z.union([z.string(), z.number()]),
  avgPx: z.union([z.string(), z.number()]),
  leverage: z.union([z.string(), z.number()]).nullable().optional(),
  fillIds: z.array(z.union([z.bigint(), z.string(), z.number()])),
  ts: z.coerce.date(),
});
export type Action = z.infer<typeof actionSchema>;

export const alertRuleSchema = z.object({
  id: z.number().int(),
  /** Owner; null for the defaults copied to each new user. */
  userId: z.number().int().nullable().optional(),
  scope: alertRuleScopeSchema,
  kind: alertRuleKindSchema,
  paramsJson: z.record(z.string(), z.unknown()),
  cooldownS: z.number().int(),
  quietHours: z.record(z.string(), z.unknown()).nullable().optional(),
  tiers: z.array(tierSchema),
  enabled: z.boolean(),
});
export type AlertRule = z.infer<typeof alertRuleSchema>;

export const alertSchema = z.object({
  id: z.union([z.bigint(), z.string(), z.number()]),
  ruleId: z.number().int(),
  userId: z.number().int().nullable().optional(),
  chain: chainSchema,
  address: z.string().nullable().optional(),
  coin: z.string().nullable().optional(),
  actionId: z.union([z.bigint(), z.string(), z.number()]).nullable().optional(),
  payloadJson: z.record(z.string(), z.unknown()),
  sentAt: z.coerce.date().nullable().optional(),
  sendStatus: sendStatusSchema,
  pxAtSend: z.union([z.string(), z.number()]).nullable().optional(),
  px1h: z.union([z.string(), z.number()]).nullable().optional(),
  px4h: z.union([z.string(), z.number()]).nullable().optional(),
  px24h: z.union([z.string(), z.number()]).nullable().optional(),
});
export type AlertEntry = z.infer<typeof alertSchema>;

// ---------------------------------------------------------------------------
// API request/response shapes
// ---------------------------------------------------------------------------

/** POST /import/lists — body for A1 (CopyDog CSV/JSON upload). */
export const importLeaderListRequestSchema = z.object({
  source: z.string().default("copydog"),
  fileName: z.string(),
  /** Raw parsed rows; column mapping happens server-side per A1. */
  rows: z.array(z.record(z.string(), z.unknown())),
});
export type ImportLeaderListRequest = z.infer<
  typeof importLeaderListRequestSchema
>;

export const importLeaderListResponseSchema = z.object({
  listId: z.number().int(),
  itemCount: z.number().int(),
  newAddresses: z.array(z.string()),
});
export type ImportLeaderListResponse = z.infer<
  typeof importLeaderListResponseSchema
>;

/** GET /lists/diff?from=<listId>&to=<listId> — A4 */
export const listDiffRequestSchema = z.object({
  fromListId: z.number().int(),
  toListId: z.number().int(),
});
export type ListDiffRequest = z.infer<typeof listDiffRequestSchema>;

export const listDiffEntrySchema = z.object({
  address: z.string(),
  fromRank: z.number().int().nullable(),
  toRank: z.number().int().nullable(),
  status: z.enum(["new", "dropped", "unchanged", "moved"]),
});
export type ListDiffEntry = z.infer<typeof listDiffEntrySchema>;

export const listDiffResponseSchema = z.object({
  entries: z.array(listDiffEntrySchema),
});
export type ListDiffResponse = z.infer<typeof listDiffResponseSchema>;

/** GET /leaders — D2 */
export const leadersQuerySchema = z.object({
  tier: tierSchema.optional(),
  active: z.coerce.boolean().optional(),
});
export type LeadersQuery = z.infer<typeof leadersQuerySchema>;

/** PATCH /leaders/:chain/:address — A3 manual leader management. All
 * fields optional; only the ones present are updated. */
export const patchLeaderRequestSchema = z.object({
  label: z.string().nullable().optional(),
  tier: tierSchema.optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
export type PatchLeaderRequest = z.infer<typeof patchLeaderRequestSchema>;

/** GET /actions (Live Feed) — D1 */
export const actionsFeedQuerySchema = z.object({
  /** `favorites`: only addresses the signed-in user favorited. */
  scope: z.enum(["all", "favorites"]).default("all"),
  address: z.string().optional(),
  coin: z.string().optional(),
  kind: actionKindSchema.optional(),
  tier: tierSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.date().optional(),
});
export type ActionsFeedQuery = z.infer<typeof actionsFeedQuerySchema>;

/** GET /alerts — D5 log (filterable by rule/address/coin) */
export const alertsQuerySchema = z.object({
  ruleId: z.coerce.number().int().optional(),
  address: z.string().optional(),
  coin: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

/** POST/PATCH /alert-rules — D5 rule editor */
export const upsertAlertRuleRequestSchema = z.object({
  id: z.number().int().optional(),
  scope: alertRuleScopeSchema,
  kind: alertRuleKindSchema,
  paramsJson: z.record(z.string(), z.unknown()),
  cooldownS: z.number().int().nonnegative(),
  quietHours: z.record(z.string(), z.unknown()).nullable().optional(),
  tiers: z.array(tierSchema),
  enabled: z.boolean().default(true),
});
export type UpsertAlertRuleRequest = z.infer<
  typeof upsertAlertRuleRequestSchema
>;

// ---------------------------------------------------------------------------
// M2 additions: rule params, rules-engine event payload, dashboard responses
// ---------------------------------------------------------------------------

/** R1/R3 share the identical "≥min(flat, equity%)" shape (§4.3, §11 決策紀錄
 * "R1 門檻" — "A≥X or A≥Y" and "A≥min(X,Y)" are the same condition). */
export const flatOrPctParamsSchema = z.object({
  flatThresholdUsd: z.number().positive(),
  pctThreshold: z.number().positive(),
});
export type FlatOrPctParams = z.infer<typeof flatOrPctParamsSchema>;

/** GET /actions (D1) — enriched with the leader join needed for the tier
 * filter and for showing a label instead of a bare address in the feed. */
export const actionFeedItemSchema = actionSchema.extend({
  leaderLabel: z.string().nullable().optional(),
  leaderTier: tierSchema.nullable().optional(),
});
export type ActionFeedItem = z.infer<typeof actionFeedItemSchema>;

/** GET /leaders (D2) — the plain `Leader` row plus everything the table
 * needs, derived from position_snapshots/equity_snapshots/actions/fills
 * (never from the Watcher's in-memory state — see leaders.service.ts). */
export const leaderSummarySchema = leaderSchema.extend({
  rank: z.number().int().nullable(),
  openPositionCount: z.number().int(),
  pnl7d: z.number(),
  pnl30d: z.number(),
  winRate: z.number().min(0).max(1).nullable(),
  avgHoldTimeSeconds: z.number().nullable(),
  lastActionAt: z.coerce.date().nullable(),
});
export type LeaderSummary = z.infer<typeof leaderSummarySchema>;

/** GET /leaders/:chain/:address (D3) */
export const positionRowSchema = z.object({
  coin: z.string(),
  szi: z.union([z.string(), z.number()]),
  entryPx: z.union([z.string(), z.number()]).nullable(),
  leverage: z.union([z.string(), z.number()]).nullable(),
  marginMode: z.string().nullable(),
  unrealizedPnl: z.union([z.string(), z.number()]).nullable(),
  liqPx: z.union([z.string(), z.number()]).nullable(),
  ts: z.coerce.date(),
});
export type PositionRow = z.infer<typeof positionRowSchema>;

export const equityPointSchema = z.object({
  ts: z.coerce.date(),
  accountValue: z.union([z.string(), z.number()]),
});
export type EquityPoint = z.infer<typeof equityPointSchema>;

export const coinDistributionEntrySchema = z.object({
  coin: z.string(),
  notionalUsd: z.number(),
  shareOfTotal: z.number(),
});
export type CoinDistributionEntry = z.infer<typeof coinDistributionEntrySchema>;

export const equityIntervalSchema = z.enum(["hour", "5m"]);
export type EquityInterval = z.infer<typeof equityIntervalSchema>;

export const leaderDetailQuerySchema = z.object({
  equityInterval: equityIntervalSchema.default("hour").optional(),
});
export type LeaderDetailQuery = z.infer<typeof leaderDetailQuerySchema>;

export const leaderDetailResponseSchema = z.object({
  leader: leaderSchema,
  rank: z.number().int().nullable(),
  positions: z.array(positionRowSchema),
  fills: z.array(fillSchema),
  equityCurve: z.array(equityPointSchema),
  coinDistribution: z.array(coinDistributionEntrySchema),
  alerts: z.array(alertSchema),
  winRate: z.number().min(0).max(1).nullable(),
});
export type LeaderDetailResponse = z.infer<typeof leaderDetailResponseSchema>;

/**
 * GET /health — heartbeat per §8 可觀測: is the trade feed connected, when
 * did it last see a trade / store a fill, when did the safety nets last run,
 * and how much REST budget is in use.
 */
export const heartbeatResponseSchema = z.object({
  feedConnected: z.boolean(),
  feedSocketsOpen: z.number().int(),
  feedSocketsTotal: z.number().int(),
  marketsSubscribed: z.number().int(),
  feedDisconnectedSince: z.coerce.date().nullable(),
  lastTradeAt: z.coerce.date().nullable(),
  lastFillAt: z.coerce.date().nullable(),
  lastSnapshotAt: z.coerce.date().nullable(),
  lastSweepAt: z.coerce.date().nullable(),
  requestsLastMinute: z.number().int(),
  weightLastMinute: z.number(),
  queuedRequests: z.object({ live: z.number().int(), background: z.number().int() }),
  /** Watched addresses trading on the feed whose fills the info API doesn't
   * return; their fills and actions are missing until it does. */
  fillsUnavailable: z.array(
    z.object({ address: z.string(), missedTrades: z.number().int(), since: z.coerce.date() }),
  ),
  dryRun: z.boolean(),
  now: z.coerce.date(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// ===========================================================================
// Stage 2 — users (Privy), favorites, notification channels, discovery
// See docs/Stage 2 — 跟單平台前置（探索、Privy、UI 重做）.md
// ===========================================================================

export const userRoleSchema = z.enum(["user", "admin"]);
export const localeSchema = z.enum(["zh-TW", "en"]);
export type LocaleInput = z.infer<typeof localeSchema>;

/** GET /me */
export const meResponseSchema = z.object({
  id: z.number().int(),
  privyUserId: z.string(),
  email: z.string().nullable(),
  walletAddress: z.string().nullable(),
  displayName: z.string().nullable(),
  role: userRoleSchema,
  locale: localeSchema,
  createdAt: z.coerce.date(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** PATCH /me */
export const patchMeRequestSchema = z.object({
  locale: localeSchema.optional(),
  displayName: z.string().max(64).nullable().optional(),
});
export type PatchMeRequest = z.infer<typeof patchMeRequestSchema>;

/** Hyperliquid address, normalized to lowercase by the api. */
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

// --- discovery -------------------------------------------------------------

export const traderWindowSchema = z.enum(["day", "week", "month", "allTime"]);
export type TraderWindowInput = z.infer<typeof traderWindowSchema>;

/** One row of `trader_stats` (official leaderboard), numbers as JS numbers. */
export const traderStatsSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  accountValue: z.number(),
  pnl: z.object({ day: z.number(), week: z.number(), month: z.number(), allTime: z.number() }),
  roi: z.object({ day: z.number(), week: z.number(), month: z.number(), allTime: z.number() }),
  volume: z.object({ day: z.number(), week: z.number(), month: z.number(), allTime: z.number() }),
  updatedAt: z.coerce.date(),
});
export type TraderStats = z.infer<typeof traderStatsSchema>;

/** GET /traders — the discovery table. Public. */
export const tradersQuerySchema = z.object({
  window: traderWindowSchema.default("month"),
  sort: z.enum(["pnl", "roi", "volume", "accountValue"]).default("pnl"),
  order: z.enum(["asc", "desc"]).default("desc"),
  /** Address prefix or display-name substring. */
  q: z.string().max(64).optional(),
  minAccountValue: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TradersQuery = z.infer<typeof tradersQuerySchema>;

export const tradersResponseSchema = z.object({
  total: z.number().int(),
  /** When the leaderboard was last imported. */
  updatedAt: z.coerce.date().nullable(),
  items: z.array(traderStatsSchema.extend({ favorite: z.boolean() })),
});
export type TradersResponse = z.infer<typeof tradersResponseSchema>;

/** Current position across all dexes (live `clearinghouseState`). */
export const livePositionSchema = z.object({
  coin: z.string(),
  szi: z.number(),
  side: z.enum(["long", "short"]),
  entryPx: z.number().nullable(),
  positionValue: z.number(),
  unrealizedPnl: z.number(),
  leverage: z.number().nullable(),
  marginMode: z.string().nullable(),
  liqPx: z.number().nullable(),
});
export type LivePosition = z.infer<typeof livePositionSchema>;

/** GET /traders/:address — the trader page's left column and header. Public;
 * `favorite` is false when signed out. */
export const traderProfileResponseSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  stats: traderStatsSchema.nullable(),
  accountValue: z.number(),
  marginUsed: z.number(),
  withdrawable: z.number(),
  longNotional: z.number(),
  shortNotional: z.number(),
  positions: z.array(livePositionSchema),
  /** Watched by the live pipeline (imported or someone's favorite). */
  tracked: z.boolean(),
  favorite: z.boolean(),
  /** From this system's own records; null when not tracked. */
  analytics: z
    .object({
      winRate30d: z.number().nullable(),
      roundTrips30d: z.number().int(),
      realizedPnl30d: z.number(),
      avgHoldSeconds: z.number().nullable(),
      bestCoins: z.array(z.object({ coin: z.string(), pnl: z.number() })),
      worstCoins: z.array(z.object({ coin: z.string(), pnl: z.number() })),
    })
    .nullable(),
  fetchedAt: z.coerce.date(),
});
export type TraderProfileResponse = z.infer<typeof traderProfileResponseSchema>;

/** GET /traders/:address/portfolio?window=&market= — PnL and account value
 * history from Hyperliquid's `portfolio`. Points are [epoch ms, value]. */
export const portfolioQuerySchema = z.object({
  window: traderWindowSchema.default("month"),
  market: z.enum(["all", "perp"]).default("perp"),
});
export type PortfolioQuery = z.infer<typeof portfolioQuerySchema>;

export const seriesPointSchema = z.tuple([z.number(), z.number()]);
export const portfolioResponseSchema = z.object({
  window: traderWindowSchema,
  market: z.enum(["all", "perp"]),
  accountValue: z.array(seriesPointSchema),
  pnl: z.array(seriesPointSchema),
  volume: z.number(),
});
export type PortfolioResponse = z.infer<typeof portfolioResponseSchema>;

/** GET /traders/sparklines?addresses=a,b,c&window= — small PnL series for
 * trader cards, one request for a whole row of cards. */
export const sparklinesQuerySchema = z.object({
  addresses: z
    .string()
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(z.string()).max(30)),
  window: traderWindowSchema.default("month"),
});
export const sparklinesResponseSchema = z.record(z.string(), z.array(seriesPointSchema));
export type SparklinesResponse = z.infer<typeof sparklinesResponseSchema>;

/** GET /traders/:address/fills?limit= — recent perp fills (ours when
 * tracked, else Hyperliquid's latest). */
export const traderFillSchema = z.object({
  tid: z.string(),
  coin: z.string(),
  side: z.enum(["buy", "sell"]),
  dir: z.string(),
  px: z.number(),
  sz: z.number(),
  notionalUsd: z.number(),
  closedPnl: z.number().nullable(),
  fee: z.number().nullable(),
  ts: z.coerce.date(),
});
export type TraderFill = z.infer<typeof traderFillSchema>;

// --- favorites (signed in) --------------------------------------------------

/** GET /me/favorites; PUT and DELETE /me/favorites/:address */
export const favoriteSchema = z.object({
  address: z.string(),
  createdAt: z.coerce.date(),
  stats: traderStatsSchema.nullable(),
});
export type Favorite = z.infer<typeof favoriteSchema>;

// --- notifications (signed in) ----------------------------------------------

/** GET /me/notification-channels; PUT /me/notification-channels/telegram */
export const notificationChannelSchema = z.object({
  kind: z.literal("telegram"),
  target: z.string(),
  enabled: z.boolean(),
});
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const putTelegramChannelRequestSchema = z.object({
  /** Telegram chat id: digits, optionally negative (groups). */
  target: z.string().regex(/^-?\d{1,20}$/),
  enabled: z.boolean().default(true),
});
export type PutTelegramChannelRequest = z.infer<typeof putTelegramChannelRequestSchema>;

// --- copy trading (panel only in Stage 2; nothing is executed) ------------

export const copyDirectionSchema = z.enum(["follow", "reverse"]);
export type CopyDirection = z.infer<typeof copyDirectionSchema>;

