/**
 * Zod schemas + inferred TS types for the §6 data model and for the
 * API request/response shapes shared between apps/web and apps/api.
 *
 * Request/domain contracts used by controllers and business policies.
 * Strict JSON output schemas live in wire-contracts.ts; Date coercion here
 * describes domain values, not browser transport types.
 */

import { z } from "zod";
import { appSettingsKeyEnum } from "../enums.js";
import { PERMISSIONS } from "../permissions.js";

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

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

/** New alerts persist version 1; readers also accept pre-version nested and flat rows. */
const alertDisplayValuesSchema = z.object({
  actionKind: actionKindSchema,
  notionalUsd: z.union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()]),
});
export const alertPayloadSchema = z.object({
  version: z.literal(1),
  values: alertDisplayValuesSchema.passthrough(),
}).passthrough();

export const notificationDeliveryPayloadSchema = alertPayloadSchema.extend({
  text: z.string(),
  chatId: z.string().nullable(),
  reasons: z.object({ favorite: z.boolean(), rules: z.array(z.string()) }),
});

export function readAlertDisplayValues(payload: Record<string, unknown>) {
  if (payload.version !== undefined && payload.version !== 1) return undefined;
  const candidate = payload.values ?? (payload.version === undefined
    ? { actionKind: payload.kind, notionalUsd: payload.notionalUsd }
    : undefined);
  const result = alertDisplayValuesSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

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
  /** Null: triggered by the recipient's favorite alert, not a rule. */
  ruleId: z.number().int().nullable(),
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
  source: z.string().trim().min(1).max(64).default("copydog"),
  fileName: z.string().trim().min(1).max(255),
  /** Raw parsed rows; column mapping happens server-side per A1. */
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
}).strict();
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
  fromListId: z.coerce.number().int().positive(),
  toListId: z.coerce.number().int().positive(),
}).strict();
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
  active: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional(),
}).strict();
export type LeadersQuery = z.infer<typeof leadersQuerySchema>;

/** PATCH /leaders/:chain/:address — A3 manual leader management. All
 * fields optional; only the ones present are updated. */
export const patchLeaderRequestSchema = z.object({
  label: z.string().nullable().optional(),
  tier: tierSchema.optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
}).strict();
export type PatchLeaderRequest = z.infer<typeof patchLeaderRequestSchema>;

/** A positive Postgres bigint action id, as a decimal string. */
export const actionIdCursorSchema = z.string().regex(/^[1-9]\d{0,18}$/).refine(
  (value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
  "Invalid action cursor id",
);

/** Filters shared by GET /actions and GET /actions/stream. */
const actionsFeedFilterShape = {
  /** `favorites`: only addresses the signed-in user favorited. */
  scope: z.enum(["all", "favorites"]).default("all"),
  address: addressSchema.transform((v) => v.toLowerCase()).optional(),
  coin: z.string().optional(),
  kind: actionKindSchema.optional(),
  tier: tierSchema.optional(),
};

/** GET /actions (Live Feed) — D1 */
export const actionsFeedQuerySchema = z.object({
  ...actionsFeedFilterShape,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.date().optional(),
  /** Pair with before using the last row's timestamp and id for lossless pagination. */
  beforeId: actionIdCursorSchema.optional(),
}).strict().refine((value) => value.beforeId === undefined || value.before !== undefined, {
  message: "before is required with beforeId", path: ["before"],
});
export type ActionsFeedQuery = z.infer<typeof actionsFeedQuerySchema>;

/** GET /actions/stream — the live feed's filters (no paging). Resuming uses
 * the SSE `Last-Event-ID` header: an action id (`actionIdCursorSchema`). */
export const actionsStreamQuerySchema = z.object(actionsFeedFilterShape).strict();
export type ActionsStreamQuery = z.infer<typeof actionsStreamQuerySchema>;

/** GET /alerts — D5 log (filterable by rule/address/coin) */
export const alertsQuerySchema = z.object({
  ruleId: z.coerce.number().int().optional(),
  address: addressSchema.transform((v) => v.toLowerCase()).optional(),
  coin: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();
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
}).strict();
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
}).strict();
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
  lastSnapshotAttemptAt: z.coerce.date().nullable().optional(),
  lastSnapshotFailureAt: z.coerce.date().nullable().optional(),
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
  permissions: z.array(z.enum(PERMISSIONS)),
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
}).strict();
export type PatchMeRequest = z.infer<typeof patchMeRequestSchema>;

/** Query-string boolean: only the literals "true" and "false" (z.coerce.boolean
 * would turn "false" into true). */
export const booleanQuerySchema = z.enum(["true", "false"]).transform((v) => v === "true");

/** Hyperliquid address, normalized to lowercase by the api. */

// --- discovery -------------------------------------------------------------

export const traderWindowSchema = z.enum(["day", "week", "month", "allTime"]);
export type TraderWindowInput = z.infer<typeof traderWindowSchema>;

export const traderActivitySchema = z.enum(["day", "week", "month", "inactive"]);
export type TraderActivity = z.infer<typeof traderActivitySchema>;
/** Filter: traded within this window; "any" includes inactive accounts. */
export const activeWithinSchema = z.enum(["day", "week", "month", "any"]);
export type ActiveWithin = z.infer<typeof activeWithinSchema>;

/** One row of `trader_stats` (official leaderboard), numbers as JS numbers. */
export const traderStatsSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  accountValue: z.number(),
  pnl: z.object({ day: z.number(), week: z.number(), month: z.number(), allTime: z.number() }),
  roi: z.object({ day: z.number(), week: z.number(), month: z.number(), allTime: z.number() }),
  volume: z.object({ day: z.number(), week: z.number(), month: z.number(), allTime: z.number() }),
  /** A Hyperliquid vault: account value is TVL, not one trader's equity. */
  isVault: z.boolean(),
  /** Most recent leaderboard window with volume > 0: traded in the last
   * day / week / month, or not at all in 30 days ("inactive": a holder, not
   * a trader). */
  activity: traderActivitySchema,
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
  /** "true" / "false"; omitted → the admin's `discovery.hideVaults` setting. */
  hideVaults: booleanQuerySchema.optional(),
  /** Omitted → the admin's `discovery.defaultActiveWithin` setting. */
  active: activeWithinSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();
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

/**
 * How an account holds collateral (Hyperliquid `userAbstraction`). In
 * "unified" and "portfolioMargin" accounts the spot clearinghouse holds every
 * balance, perp collateral included, so the per-dex perp states are views
 * into it and must not be added to it. "standard" covers Hyperliquid's
 * "disabled"/"default" (separate perp, per-dex and spot balances) and the
 * discontinued "dexAbstraction".
 */
export const accountModeSchema = z.enum(["standard", "unified", "portfolioMargin"]);
export type AccountMode = z.infer<typeof accountModeSchema>;

/** One non-zero spot balance, valued at its USDC mark (USDC = 1). */
export const spotBalanceSchema = z.object({
  coin: z.string(),
  /** Spot token index; null for prediction-market outcome tokens ("+123"). */
  token: z.number().int().nullable(),
  total: z.number(),
  /** USD per unit; null when there is no priced market (valued at 0). */
  px: z.number().nullable(),
  value: z.number(),
  /** The `allMids` key that tracks this balance's price live ("@107",
   * "PURR/USDC", "#123"); null for USDC and unpriced tokens. */
  priceKey: z.string().nullable(),
});
export type SpotBalance = z.infer<typeof spotBalanceSchema>;

/** GET /traders/:address — the trader page's left column and header. Public;
 * `favorite` is false when signed out. */
export const traderProfileResponseSchema = z.object({
  /** Source timestamps are observations, not the profile assembly time.
   * Optional while rolling out older clients/fixtures. Nullable totals must
   * not be interpreted as zero; positions may contain only available dexes. */
  dataQuality: z.object({
    partial: z.boolean(),
    sources: z.record(z.object({
      status: z.enum(["available", "unavailable"]),
      asOf: z.string().datetime().nullable(),
      stale: z.boolean(),
      maxAgeMs: z.number().int().nonnegative(),
    })),
  }).optional(),
  address: z.string(),
  displayName: z.string().nullable(),
  stats: traderStatsSchema.nullable(),
  /** Total equity, as Hyperliquid's portfolio totals it: perp equity (except
   * in unified / portfolio-margin accounts, where the spot balance already
   * holds it) + spot value + staked HYPE. */
  accountValue: z.number().nullable(),
  /** Sum of `marginSummary.accountValue` over every perp dex. Leverage and
   * margin usage are relative to this. */
  perpEquity: z.number().nullable(),
  /** Spot balances at their USDC marks. */
  spotValue: z.number(),
  /** Staked HYPE (delegated, undelegated and pending withdrawal). */
  stakedValue: z.number().nullable(),
  accountMode: accountModeSchema,
  /** Largest first. */
  spotBalances: z.array(spotBalanceSchema),
  /** Perp dexes queried: "" is the main dex, then every HIP-3 dex with a
   * listed market. Live clients subscribe to the same set. */
  perpDexes: z.array(z.string()),
  /** Perp only, summed over dexes. */
  marginUsed: z.number().nullable(),
  withdrawable: z.number().nullable(),
  longNotional: z.number().nullable(),
  shortNotional: z.number().nullable(),
  positions: z.array(livePositionSchema),
  /** Watched by the live pipeline (imported or someone's favorite). */
  tracked: z.boolean(),
  isVault: z.boolean(),
  /** @deprecated Moved to GET /traders/:address/activity; no longer sent.
   * Kept optional for one step so older clients still parse. */
  lastTradeAt: z.coerce.date().nullable().optional(),
  /** @deprecated Moved to GET /traders/:address/activity; no longer sent.
   * Kept optional for one step so older clients still parse. */
  sample: z
    .object({
      fills30d: z.number().int(),
      capped: z.boolean(),
      lowSample: z.boolean(),
    })
    .optional(),
  favorite: z.boolean(),
  /** @deprecated Tracked addresses only, from the actions table. The web
   * reads GET /traders/:address/analytics (any address) instead; kept for
   * API clients for one step. */
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

/** GET /traders/:address/activity — the fills-derived part of the trader
 * page, served apart from the profile because it costs far more Hyperliquid
 * weight (fill lists) and would hold up the first paint. Public. TWAP slice
 * fills count like any other fill. */
export const traderActivityResponseSchema = z.object({
  address: z.string(),
  /** Latest perp fill we know of (ours or Hyperliquid's latest lists). */
  lastTradeAt: z.coerce.date().nullable(),
  /** Sample size, so a 3-trade 300% ROI doesn't look like a 300-trade one
   * (競品分析 §3.2). Tracked: our fills or Hyperliquid's latest lists,
   * whichever is larger; untracked: Hyperliquid's latest `userFills` plus
   * latest TWAP slices (each at most 2,000, so `capped` means "at least"). */
  sample: z.object({
    fills30d: z.number().int(),
    capped: z.boolean(),
    /** fills30d below the admin's `discovery.lowSampleThreshold`. */
    lowSample: z.boolean(),
  }),
  fetchedAt: z.coerce.date(),
});
export type TraderActivityResponse = z.infer<typeof traderActivityResponseSchema>;

/** 503 body when Hyperliquid's request budget can't serve a page load in
 * time; the response carries `Retry-After` (seconds). */
export const busyErrorSchema = z.object({
  statusCode: z.literal(503),
  code: z.literal("busy"),
  message: z.string(),
  retryAfterSeconds: z.number().int(),
});
export type BusyError = z.infer<typeof busyErrorSchema>;

/** GET /traders/:address/portfolio?window=&market= — PnL and account value
 * history from Hyperliquid's `portfolio`. Points are [epoch ms, value]. */
export const portfolioQuerySchema = z.object({
  window: traderWindowSchema.default("month"),
  market: z.enum(["all", "perp"]).default("perp"),
}).strict();
export type PortfolioQuery = z.infer<typeof portfolioQuerySchema>;

export const seriesPointSchema = z.tuple([z.number(), z.number()]);
export const portfolioResponseSchema = z.object({
  /** Additive during rolling deployment. Observed intervals do not prove complete source history. */
  methodology: z.object({
    version: z.literal("flow-neutral-v1"),
    intervals: z.number().int().nonnegative(),
    excludedIntervals: z.number().int().nonnegative(),
    excludedFraction: z.number().min(0).max(1).nullable(),
    capitalFloorUsd: z.number().nonnegative(),
    quality: z.enum(["observed", "partial", "unavailable"]),
  }).optional(),
  window: traderWindowSchema,
  market: z.enum(["all", "perp"]),
  accountValue: z.array(seriesPointSchema),
  pnl: z.array(seriesPointSchema),
  volume: z.number(),
  /** Largest peak-to-trough fall of the window's cumulative PnL (USD, ≥ 0). */
  maxDrawdownUsd: z.number(),
  /**
   * Largest peak-to-trough fall of the time-weighted return index (see
   * `cumulativeReturn`), 0–1; 1 = the account was wiped out at some point.
   * Deposits and withdrawals don't move it. Null without a usable interval.
   */
  maxDrawdownPct: z.number().nullable(),
  /**
   * Annualized Sharpe ratio of the time-weighted returns resampled to UTC
   * days, as log returns (days without a point return 0; a wiped-out day
   * counts as −99.99 %): mean ÷ sample stdev × √365, risk-free rate 0. Its
   * sign always matches `roi`'s. Null with fewer than 7 daily returns (e.g.
   * the "day" window) or zero variance.
   */
  sharpe: z.number().nullable(),
  /**
   * The window's time-weighted return: the last `cumulativeReturn` value,
   * what a dollar kept in the account for the whole window would have
   * returned. Flow-neutral, so defined even when more was withdrawn than
   * deposited. Null without a usable interval. The trader page's ROI.
   */
  roi: z.number().nullable(),
  /**
   * Time-weighted return index − 1 at each `pnl` point, starting at 0.
   * Interval i returns ΔPnLᵢ ÷ (whole-account value at its start + any net
   * deposit during it), where net deposit = Δaccount value − ΔPnL of the
   * whole account ("all" market, also for "perp": perp account value isn't
   * meaningful in unified / portfolio-margin accounts). Intervals whose base
   * is under $10 or 1% of the window's largest account value count as 0.
   */
  cumulativeReturn: z.array(seriesPointSchema),
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
}).strict();
/** Address → PnL series; [] when its fetch failed. Addresses whose
 * portfolio isn't ready within the api's deadline (8 s) are left out and
 * keep loading into the cache: ask again for them. */
export const sparklinesResponseSchema = z.record(z.string(), z.array(seriesPointSchema));
export type SparklinesResponse = z.infer<typeof sparklinesResponseSchema>;

/** GET /traders/:address/fills?limit= — recent perp fills (ours when
 * tracked, else Hyperliquid's latest), TWAP slices included. */
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
  /** The TWAP this fill is a slice of; null for a regular fill. */
  twapId: z.number().int().nullable().optional(),
});
export type TraderFill = z.infer<typeof traderFillSchema>;

// --- trade analytics (any address) -----------------------------------------

/** Window of the trade analytics: every closed trade in coverage, or those
 * closed in the last 30 / 7 / 1 days (the trader page's windows). */
export const tradeWindowSchema = z.enum(["all", "30d", "7d", "1d"]);
export type TradeWindow = z.infer<typeof tradeWindowSchema>;

/** CopyDog's trading styles, from the median hold of closed trades:
 * scalp < 15 min ≤ intraday < 24 h ≤ swing < 14 days ≤ position. */
export const tradingStyleSchema = z.enum(["scalp", "intraday", "swing", "position"]);
export type TradingStyle = z.infer<typeof tradingStyleSchema>;

/** CopyDog's PnL cohorts on Hyperliquid's leaderboard all-time PnL: ≥ $1M,
 * ≥ $100K, > $0, $0 (break even), > −$100K, > −$1M, else rekt. */
export const pnlTierSchema = z.enum([
  "extremely_profitable",
  "very_profitable",
  "profitable",
  "break_even",
  "unprofitable",
  "very_unprofitable",
  "rekt",
]);
export type PnlTier = z.infer<typeof pnlTierSchema>;

/** CopyDog's size cohorts on perp account value (Σ clearinghouse
 * `marginSummary.accountValue`, not spot or staking): apex ≥ $5M, whale ≥
 * $1M, large ≥ $100K, medium ≥ $10K, else small. */
export const sizeTierSchema = z.enum(["apex", "whale", "large", "medium", "small"]);
export type SizeTier = z.infer<typeof sizeTierSchema>;

/** One round trip: a coin's position from leaving 0 to returning to 0 (or
 * flipping). Open trips have no exit yet. */
export const roundTripSchema = z.object({
  /** The tid of its first fill we hold, negative for a partial trade;
   * unique per address. */
  id: z.string(),
  coin: z.string(),
  side: z.enum(["long", "short"]),
  status: z.enum(["open", "closed"]),
  entryTime: z.coerce.date(),
  exitTime: z.coerce.date().nullable(),
  /** Volume-weighted over every fill that grew the position (a partial
   * trade's unseen part priced from its first closing fill). */
  entryPx: z.number(),
  /** Volume-weighted over every fill that shrank it; null before any. */
  exitPx: z.number().nullable(),
  /** Σ every fill that grew the position, in coins (CopyDog's `size`). */
  size: z.number(),
  /** size × (entryPx + exitPx), USD: CopyDog's 名義價值 column. */
  notional: z.number(),
  /** size × entryPx, USD: what CopyDog sums as a coin's volume. */
  volume: z.number(),
  /** Closed: exit − entry; open: so far. */
  holdSeconds: z.number(),
  /** Σ closedPnl (Hyperliquid's, before fees). */
  realizedPnl: z.number(),
  fees: z.number(),
  /** Funding paid (−) or received (+) over the hold; null when the hold
   * started before funding coverage (`coverage.fundingFrom`). Not in
   * `netPnl`, as on CopyDog. */
  funding: z.number().nullable(),
  /** realizedPnl − fees. Decides win/loss. */
  netPnl: z.number(),
  liquidated: z.boolean(),
  /** Some of its fills were TWAP slices. */
  twap: z.boolean(),
  fills: z.number().int(),
  /** Already open at the first fill we hold: the real open time is before
   * `entryTime` (CopyDog shows "before …" and "> duration"). */
  partial: z.boolean(),
  /** A partial trade not closed from yet: `entryPx` covers only the fills
   * we hold (CopyDog's "≈"). */
  entryApprox: z.boolean(),
});
export type RoundTrip = z.infer<typeof roundTripSchema>;

/** What history the analytics are based on. */
export const tradeCoverageSchema = z.object({
  /** "tracked": our own fills table; "hyperliquid": Hyperliquid's fill
   * history, read for this page. */
  source: z.enum(["tracked", "hyperliquid"]),
  /** Earliest fill read; null when there are none. */
  from: z.coerce.date().nullable(),
  /** Older history exists that isn't included (Hyperliquid's retention,
   * the lookback, or a position already open at `from`): the UI says
   * "based on trades since `from`". */
  truncated: z.boolean(),
  /** Funding is included for trades opened on or after this; null until
   * it has been read. */
  fundingFrom: z.coerce.date().nullable(),
  /** Last fully read funding timestamp; amounts can be partial after it. */
  fundingThrough: z.coerce.date().nullable(),
  /** Fills behind the trades. */
  fills: z.number().int(),
});
export type TradeCoverage = z.infer<typeof tradeCoverageSchema>;

/** One coin's closed trades (CopyDog's `byAsset`). */
export const tradeCoinSchema = z.object({
  coin: z.string(),
  trades: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  /** Σ size × entry price. */
  volume: z.number(),
  netPnl: z.number(),
  winRate: z.number(),
});
export type TradeCoin = z.infer<typeof tradeCoinSchema>;

export const tradeSummarySchema = z.object({
  /** Closed trades in the window (by exit time). */
  trades: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  /** wins ÷ trades (net PnL > 0); null without trades. */
  winRate: z.number().nullable(),
  avgHoldSeconds: z.number().nullable(),
  medianHoldSeconds: z.number().nullable(),
  /** Σ winning net PnL ÷ |Σ losing net PnL|; null without a loss. */
  profitFactor: z.number().nullable(),
  realizedPnl: z.number(),
  fees: z.number(),
  netPnl: z.number(),
  /** Σ size × entry price of the window's closed trades. */
  volume: z.number(),
  /** Open trades now (not window-dependent). */
  openTrades: z.number().int(),
  /** The 10 closed trades with the highest net PnL (highest first) and
   * the 10 with the lowest (lowest first), whatever the sign. */
  best: z.array(roundTripSchema),
  worst: z.array(roundTripSchema),
  /** Every coin with a closed trade in the window, by net PnL (highest
   * first). CopyDog's rail "most traded" sorts these by volume, its 表現
   * tab by trade count. */
  coins: z.array(tradeCoinSchema),
});
export type TradeSummary = z.infer<typeof tradeSummarySchema>;

export const traderClassificationSchema = z.object({
  /** From the median hold of all closed trades in coverage; null without
   * any. */
  style: tradingStyleSchema.nullable(),
  /** From `allTimePnl`; null when it couldn't be read. */
  pnlTier: pnlTierSchema.nullable(),
  /** From `perpAccountValue`; null when it couldn't be read. */
  sizeTier: sizeTierSchema.nullable(),
  /** Hyperliquid's leaderboard all-time PnL (what CopyDog tiers on); for an
   * address not on the leaderboard, its portfolio's all-time PnL. */
  allTimePnl: z.number().nullable(),
  /** Perp account value summed over dexes (CopyDog's `accountValue`). */
  perpAccountValue: z.number().nullable(),
});
export type TraderClassification = z.infer<typeof traderClassificationSchema>;

/** GET /traders/:address/analytics?window= — round-trip statistics for any
 * address. Served from the store; a cold address answers 503 busy while its
 * history is read, then the retry finds it. */
export const traderAnalyticsQuerySchema = z.object({ window: tradeWindowSchema.default("all") }).strict();
export type TraderAnalyticsQuery = z.infer<typeof traderAnalyticsQuerySchema>;

export const traderAnalyticsResponseSchema = z.object({
  address: z.string(),
  window: tradeWindowSchema,
  summary: tradeSummarySchema,
  classification: traderClassificationSchema,
  coverage: tradeCoverageSchema,
  computedAt: z.coerce.date(),
  /** Older than the staleness window; a refresh is running. */
  refreshing: z.boolean(),
});
export type TraderAnalyticsResponse = z.infer<typeof traderAnalyticsResponseSchema>;

/** GET /traders/:address/trades?status=&limit=&cursor= — the round-trip
 * ledger, latest first by exit (open trades by entry), as CopyDog sorts. */
export const traderTradesQuerySchema = z.object({
  status: z.enum(["all", "closed", "open"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** `nextCursor` of the previous page. */
  cursor: z.string().max(38).regex(/^\d+_-?\d+$/).refine(value => {
    const [ms, tid] = value.split("_");
    if (ms === undefined || tid === undefined) return false;
    const time = Number(ms);
    try {
      const id = BigInt(tid);
      return Number.isSafeInteger(time) && time >= 0 && time <= 8_640_000_000_000_000
        && id >= -(2n ** 63n) && id <= 2n ** 63n - 1n;
    } catch { return false; }
  }, "Invalid trade cursor").optional(),
}).strict();
export type TraderTradesQuery = z.infer<typeof traderTradesQuerySchema>;

export const traderTradesResponseSchema = z.object({
  address: z.string(),
  items: z.array(roundTripSchema),
  nextCursor: z.string().nullable(),
  /** Trades matching `status` in all ("Show more (50 / 120)"). */
  total: z.number().int(),
  coverage: tradeCoverageSchema,
  computedAt: z.coerce.date(),
});
export type TraderTradesResponse = z.infer<typeof traderTradesResponseSchema>;

// --- favorites (signed in) --------------------------------------------------

/** GET /me/favorites; PUT and DELETE /me/favorites/:address */
export const alertSidesSchema = z.enum(["buy", "sell", "both"]);
export type AlertSidesInput = z.infer<typeof alertSidesSchema>;

/** Telegram trade alert for one favorite (CopyDog-style). `sides`: buy =
 * actions on the buy side (open/add long, reduce/close short), sell = the
 * sell side. `minUsd`: skip actions below this notional; null = any. */
export const favoriteAlertSchema = z.object({
  enabled: z.boolean(),
  sides: alertSidesSchema,
  minUsd: z.number().nullable(),
});
export type FavoriteAlert = z.infer<typeof favoriteAlertSchema>;

export const favoriteSchema = z.object({
  address: z.string(),
  createdAt: z.coerce.date(),
  stats: traderStatsSchema.nullable(),
  alert: favoriteAlertSchema,
});
export type Favorite = z.infer<typeof favoriteSchema>;

/** PATCH /me/favorites/:address/alert → the updated `favoriteSchema`.
 * Turning alerts on answers 409 `{code:"telegram_not_linked"}` without a
 * linked Telegram, and 409 `{code:"alert_limit", limit}` when the user
 * already has `notifications.maxAlertTraders` switched on. */
export const patchFavoriteAlertRequestSchema = z.object({
  enabled: z.boolean().optional(),
  sides: alertSidesSchema.optional(),
  minUsd: z.number().min(0).max(1e12).nullable().optional(),
}).strict();
export type PatchFavoriteAlertRequest = z.infer<typeof patchFavoriteAlertRequestSchema>;

// --- notifications (signed in) ----------------------------------------------

/** GET /me/telegram — the official bot and whether this user's chat is
 * linked to it. */
export const telegramStatusSchema = z.object({
  /** Bot username without "@" (TELEGRAM_BOT_USERNAME); null = not set up. */
  bot: z.string().nullable(),
  linked: z.boolean(),
  /** The chat's @username at link time, without "@". */
  username: z.string().nullable(),
  enabled: z.boolean(),
  linkedAt: z.coerce.date().nullable(),
});
export type TelegramStatus = z.infer<typeof telegramStatusSchema>;

/** POST /me/telegram/link — a one-time deep link (10 min). Opening it and
 * pressing Start in Telegram links that chat; the page polls GET
 * /me/telegram. DELETE /me/telegram unlinks (204). */
export const telegramLinkResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.coerce.date(),
});
export type TelegramLinkResponse = z.infer<typeof telegramLinkResponseSchema>;

/** POST /me/telegram/test — sends a test message to the linked chat. */
export const telegramTestResponseSchema = z.object({
  sent: z.boolean(),
  /** TELEGRAM_DRY_RUN is on: logged, not sent. */
  dryRun: z.boolean(),
});
export type TelegramTestResponse = z.infer<typeof telegramTestResponseSchema>;

// --- copy trading (panel only in Stage 2; nothing is executed) ------------

export const copyDirectionSchema = z.enum(["follow", "reverse"]);
export type CopyDirection = z.infer<typeof copyDirectionSchema>;

// --- insights: crowd view (競品分析 §3.4) -------------------------------------

/** GET /insights/crowd — what the tracked traders hold, per coin. Public.
 * From each tracked address's latest position snapshot. */
export const crowdCoinSchema = z.object({
  coin: z.string(),
  longNotional: z.number().nullable(),
  shortNotional: z.number().nullable(),
  longTraders: z.number().int(),
  shortTraders: z.number().int(),
  /** (long − short) ÷ (long + short) notional, −1…1. */
  netBias: z.number().nullable(),
  /** Net notional (long − short) 24 h ago; null without a snapshot then. */
  netNotional24hAgo: z.number().nullable(),
  /** Marked exposure difference for addresses observed in both periods, not trade flow.
   * Optional only for rolling deployment compatibility. */
  netNotionalChange24h: z.number().nullable().optional(),
});
export type CrowdCoin = z.infer<typeof crowdCoinSchema>;

export const crowdResponseSchema = z.object({
  trackedTraders: z.number().int(),
  comparison: z.object({
    currentTraders: z.number().int().nonnegative(),
    pastTraders: z.number().int().nonnegative(),
    matchedTraders: z.number().int().nonnegative(),
  }).optional(),
  coins: z.array(crowdCoinSchema),
  updatedAt: z.coerce.date().nullable(),
});
export type CrowdResponse = z.infer<typeof crowdResponseSchema>;

// --- site settings (admin) -------------------------------------------------------

export const localizedTextSchema = z.object({
  "zh-TW": z.string().max(280),
  en: z.string().max(280),
});

/** One schema per `app_settings.key`; `.default()`s are the values before
 * an admin saves anything. */
export const generalSettingsSchema = z.object({
  /** Banner across the top of every page. */
  announcement: z
    .object({ enabled: z.boolean(), text: localizedTextSchema })
    .default({ enabled: false, text: { "zh-TW": "", en: "" } }),
  /** New Privy users may sign up; existing users can always sign in. */
  signupsOpen: z.boolean().default(true),
  /** The copy panel's CTA; nothing is executed in Stage 2 regardless. */
  copyTradingEnabled: z.boolean().default(false),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

export const discoverySettingsSchema = z.object({
  /** Trader cards on the home page, in order; empty → top by month PnL. */
  featuredAddresses: z.array(addressSchema).max(12).default([]),
  /** "Browse by market" chips on the home page. */
  homeMarkets: z.array(z.string().min(1).max(24)).max(16).default(["BTC", "ETH", "SOL", "HYPE"]),
  hideVaults: z.boolean().default(true),
  /** Fewer 30-day fills than this → greyed out with a "low sample" tag. */
  lowSampleThreshold: z.number().int().min(0).max(1000).default(20),
  leaderboardRefreshMinutes: z.number().int().min(5).max(240).default(15),
  /** Default activity filter on explore and home lists: "month" hides
   * accounts with no volume in 30 days (holders, not traders). */
  defaultActiveWithin: activeWithinSchema.default("month"),
});
export type DiscoverySettings = z.infer<typeof discoverySettingsSchema>;

export const notificationSettingsSchema = z.object({
  /** Global kill switch for user alerts (system messages still go out). */
  alertsEnabled: z.boolean().default(true),
  /** How many favorites one user may have Telegram alerts switched on for
   * (CopyDog allows 3). Lowering it doesn't switch existing ones off. */
  maxAlertTraders: z.number().int().min(1).max(1000).default(3),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const revenueSettingsSchema = z.object({
  /** The platform's Hyperliquid address: builder code and referrer. */
  builderAddress: addressSchema.nullable().default(null),
  /** Builder fee in tenths of a basis point (Hyperliquid's unit; perps max
   * 100 = 0.1%). Charged on copy-trade orders once execution ships. */
  builderFeeTenthsBps: z.number().int().min(0).max(100).default(0),
  /** Hyperliquid referral code shown to new users. */
  referralCode: z.string().regex(/^[A-Za-z0-9]{1,20}$/).nullable().default(null),
});
export type RevenueSettings = z.infer<typeof revenueSettingsSchema>;

/** GET /admin/settings (admin) → every section; PATCH /admin/settings with
 * any subset of sections, each section a partial that is merged, validated
 * as a whole, and saved. */
export const adminSettingsSchema = z.object({
  general: generalSettingsSchema,
  discovery: discoverySettingsSchema,
  notifications: notificationSettingsSchema,
  revenue: revenueSettingsSchema,
});
export type AdminSettings = z.infer<typeof adminSettingsSchema>;

const settingsRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const adminSettingsSnapshotSchema = adminSettingsSchema.extend({
  revisions: z.object({ general: settingsRevisionSchema, discovery: settingsRevisionSchema,
    notifications: settingsRevisionSchema, revenue: settingsRevisionSchema }),
  invalidSections: z.array(z.enum(appSettingsKeyEnum)),
});
export type AdminSettingsSnapshot = z.infer<typeof adminSettingsSnapshotSchema>;

export const patchAdminSettingsRequestSchema = z.object({
  general: generalSettingsSchema.partial().extend({
    announcement: z.object({ enabled: z.boolean(), text: localizedTextSchema.strict() }).strict().optional(),
  }).strict().optional(),
  discovery: discoverySettingsSchema.partial().strict().optional(),
  notifications: notificationSettingsSchema.partial().strict().optional(),
  revenue: revenueSettingsSchema.partial().strict().optional(),
  expectedRevisions: z.record(z.enum(appSettingsKeyEnum), settingsRevisionSchema).optional(),
}).strict().superRefine((value, ctx) => {
  const keys = appSettingsKeyEnum.filter(key => value[key] !== undefined);
  if (!keys.length) ctx.addIssue({ code: "custom", message: "At least one settings field is required" });
  for (const key of keys) {
    if (!Object.values(value[key]!).some(field => field !== undefined)) {
      ctx.addIssue({ code: "custom", path: [key], message: "Empty settings section" });
    }
  }
});
export type PatchAdminSettingsRequest = z.infer<typeof patchAdminSettingsRequestSchema>;

/** GET /settings — the public subset the web needs before anyone signs in. */
export const publicSettingsSchema = z.object({
  announcement: generalSettingsSchema.shape.announcement,
  signupsOpen: z.boolean(),
  copyTradingEnabled: z.boolean(),
  featuredAddresses: z.array(z.string()),
  homeMarkets: z.array(z.string()),
  hideVaults: z.boolean(),
  lowSampleThreshold: z.number().int(),
  defaultActiveWithin: activeWithinSchema,
  maxAlertTraders: z.number().int(),
  referralCode: z.string().nullable(),
});
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

// --- users (admin) -----------------------------------------------------------

/** GET /admin/users?q=&role=&limit=&offset= */
export const adminUsersQuerySchema = z.object({
  /** Email, wallet or display-name substring (case-insensitive). */
  q: z.string().max(64).optional(),
  role: userRoleSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

export const adminUserSchema = z.object({
  id: z.number().int(),
  email: z.string().nullable(),
  walletAddress: z.string().nullable(),
  displayName: z.string().nullable(),
  role: userRoleSchema,
  locale: localeSchema,
  favorites: z.number().int(),
  telegramEnabled: z.boolean(),
  disabled: z.boolean(),
  createdAt: z.coerce.date(),
  lastLoginAt: z.coerce.date(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUsersResponseSchema = z.object({
  total: z.number().int(),
  items: z.array(adminUserSchema),
});
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;

/** PATCH /admin/users/:id — an admin can't demote or disable themself. */
export const patchAdminUserRequestSchema = z.object({
  role: userRoleSchema.optional(),
  disabled: z.boolean().optional(),
}).strict();
export type PatchAdminUserRequest = z.infer<typeof patchAdminUserRequestSchema>;

// --- overview + revenue (admin) ------------------------------------------------

/** GET /admin/overview — the admin home's KPI row. */
export const adminOverviewSchema = z.object({
  users: z.object({ total: z.number().int(), new7d: z.number().int(), active7d: z.number().int() }),
  trackedTraders: z.object({
    total: z.number().int(),
    imported: z.number().int(),
    favorited: z.number().int(),
  }),
  alerts24h: z.object({ sent: z.number().int(), failed: z.number().int(), dryRun: z.number().int() }),
  revenue30dUsd: z.number(),
  generatedAt: z.coerce.date(),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

export const revenueRangeSchema = z.enum(["7d", "30d", "90d", "all"]);

/** GET /admin/revenue?range= — from `revenue_snapshots`. */
export const adminRevenueQuerySchema = z.object({ range: revenueRangeSchema.default("30d") }).strict();
export type AdminRevenueQuery = z.infer<typeof adminRevenueQuerySchema>;

export const adminRevenueResponseSchema = z.object({
  /** null until an admin sets `revenue.builderAddress`. */
  address: z.string().nullable(),
  builderFeeTenthsBps: z.number().int(),
  referralCode: z.string().nullable(),
  /** Cumulative, as of the latest snapshot. */
  totals: z.object({
    builderUsd: z.number(),
    referralUsd: z.number(),
    claimedUsd: z.number(),
    unclaimedUsd: z.number(),
    referredUsers: z.number().int(),
    referredVolumeUsd: z.number(),
  }),
  /** Earned within the range. */
  rangeUsd: z.object({ builder: z.number(), referral: z.number() }),
  /** Per day (Asia/Taipei), earned that day. */
  daily: z.array(
    z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), builder: z.number(), referral: z.number() }),
  ),
  lastSnapshotAt: z.coerce.date().nullable(),
});
export type AdminRevenueResponse = z.infer<typeof adminRevenueResponseSchema>;
