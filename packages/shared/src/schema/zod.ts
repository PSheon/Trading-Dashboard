/**
 * Zod schemas + inferred TS types for the §6 data model and for the
 * API request/response shapes shared between apps/web and apps/api.
 *
 * Request/domain contracts used by controllers and business policies.
 * Strict JSON output schemas live in wire-contracts.ts; Date coercion here
 * describes domain values, not browser transport types.
 */

import { z } from "zod";
import { appSettingsKeyEnum, localeEnum, userRoleEnum } from "../enums.js";
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
  source: z.enum(["import", "favorite", "copy"]).default("import"),
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
  ruleId: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  address: addressSchema.transform((v) => v.toLowerCase()).optional(),
  coin: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

/** POST/PATCH /alert-rules — D5 rule editor */
export const upsertAlertRuleRequestSchema = z.object({
  id: z.number().int().min(1).max(2_147_483_647).optional(),
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

/** A leader as anyone may see it (`GET /leaders*` without `leaders.manage`):
 * no admin `notes`, and no `source`, which would say that users favorited
 * the address. Favorite-only leaders aren't shown publicly at all. */
export const publicLeaderSchema = leaderSchema.omit({ notes: true, source: true });
export type PublicLeader = z.infer<typeof publicLeaderSchema>;
export const publicLeaderSummarySchema = leaderSummarySchema.omit({ notes: true, source: true });
export type PublicLeaderSummary = z.infer<typeof publicLeaderSummarySchema>;

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
  /** The full row for `leaders.manage`, else the public projection. */
  leader: z.union([publicLeaderSchema.strict(), leaderSchema]),
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
  /** Who spends the Hyperliquid budget (trailing minute, per consumer
   * label) and how much the page reserve holds. Additive. */
  budget: z.object({
    effectivePerMin: z.number(),
    pageWeightLastMinute: z.number(),
    reserveTokens: z.number(),
    reserveCapacity: z.number(),
    /** 1 = background jobs run at their full allowance; lower while pages are busy. */
    backgroundFactor: z.number(),
    consumers: z.record(z.number()),
    /** The weight-per-minute cap each capped consumer is held to now: its
     * setting, scaled so that all caps fit the effective budget. */
    caps: z.record(z.number()).optional(),
  }).optional(),
  /** Age of the discovery pool's stored performance figures: the rows the
   * boards and home rows show (`visible`) and the whole pool. Additive. */
  discovery: z.object({
    visibleRows: z.number().int(),
    medianVisibleAgeSeconds: z.number().nullable(),
    oldestVisibleAgeSeconds: z.number().nullable(),
    poolRows: z.number().int(),
    poolReady: z.number().int(),
    medianPoolAgeSeconds: z.number().nullable(),
    oldestPoolAgeSeconds: z.number().nullable(),
  }).optional(),
  /** Watched addresses trading on the feed whose fills the info API doesn't
   * return; their fills and actions are missing until it does. */
  fillsUnavailable: z.array(
    z.object({ address: z.string(), missedTrades: z.number().int(), since: z.coerce.date() }),
  ),
  dryRun: z.boolean(),
  /** Hyperliquid S3 node-archive ingest (absent when it isn't configured). */
  archive: z.object({
    enabled: z.boolean(),
    /** Start of the next hourly object the forward cursor waits for. */
    liveNextHour: z.coerce.date().nullable(),
    /** Next hour of the running backfill pass; null when none runs. */
    backfillCursorHour: z.coerce.date().nullable(),
    /** The hour passes go down to (`S3_ARCHIVE_BACKFILL_DAYS` before today);
     * `addresses.backfilled` counts spans that reach it. */
    backfillFloor: z.coerce.date().optional(),
    /** When the latest pass began and the earliest start of the next one. */
    backfillPassStartedAt: z.coerce.date().nullable().optional(),
    backfillNextPassAt: z.coerce.date().nullable().optional(),
    /** Seconds between now and the end of the newest ingested hour. */
    lagSeconds: z.number().nullable(),
    objects: z.number().int(),
    bytes: z.number().int(),
    fillsSeen: z.number().int(),
    fillsKept: z.number().int(),
    /** Today's (UTC) download volume and its cost at the configured rate. */
    spendDayBytes: z.number().int(),
    spendDayUsd: z.number(),
    maxDailyUsd: z.number(),
    addresses: z.object({ total: z.number().int(), backfilled: z.number().int(), pending: z.number().int(), excluded: z.number().int() }),
    lastObjectKey: z.string().nullable(),
    lastRunAt: z.coerce.date().nullable(),
    lastError: z.string().nullable(),
  }).optional(),
  now: z.coerce.date(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// ===========================================================================
// Stage 2 — users (Privy), favorites, notification channels, discovery
// See docs/Stage 2 — 跟單平台前置（探索、Privy、UI 重做）.md
// ===========================================================================

export const userRoleSchema = z.enum(userRoleEnum);
export const localeSchema = z.enum(localeEnum);
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
  /** Margin the position ties up (Hyperliquid `marginUsed`), USD. Additive:
   * optional while older api builds roll out. */
  marginUsed: z.number().optional(),
  /** Funding since the position was opened, as Hyperliquid books it
   * (`cumFunding.sinceOpen`: positive = paid). The 持倉 tab shows its
   * negation, the funding received, as CopyDog does. Null when absent. */
  fundingSinceOpen: z.number().nullable().optional(),
  /** Unrealized PnL ÷ margin (Hyperliquid `returnOnEquity`, 0.12 = 12%). */
  returnOnEquity: z.number().nullable().optional(),
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
  /** Held by open orders (Hyperliquid `hold`); available = total − hold.
   * Additive: optional while older api builds roll out. */
  hold: z.number().optional(),
  /** USD per unit; null when there is no priced market (valued at 0). */
  px: z.number().nullable(),
  value: z.number(),
  /** The `allMids` key that tracks this balance's price live ("@107",
   * "PURR/USDC", "#123"); null for USDC and unpriced tokens. */
  priceKey: z.string().nullable(),
});
export type SpotBalance = z.infer<typeof spotBalanceSchema>;

/** A KOL as the trader page header shows it. `avatarUrl` is the api's
 * cached copy (`/kols/:address/avatar?v=…`, a path on the api), null until
 * the drip job has fetched it. */
export const kolCardSchema = z.object({
  displayName: z.string().nullable(),
  xHandle: z.string().nullable(),
  verified: z.boolean(),
  avatarUrl: z.string().nullable(),
});
export type KolCard = z.infer<typeof kolCardSchema>;

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
   * holds it) + spot value + staked HYPE. A vault's is its TVL: the latest
   * whole-account value of Hyperliquid's `portfolio`, which for a parent
   * vault (HLP) includes its child vaults; its own perp clearinghouse
   * state does not. */
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
  /** Maintenance margin in use (Hyperliquid `crossMaintenanceMarginUsed`),
   * summed over dexes: CopyDog's "% from liquidation" is
   * 1 − this ÷ perp equity. Additive: optional while older api builds
   * roll out. */
  maintenanceMarginUsed: z.number().nullable().optional(),
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
  /** The KOL registry's entry for this address (name, 𝕏 handle, verified
   * badge, cached avatar); null when it is not a KOL. Optional while older
   * clients and fixtures roll forward. */
  kol: kolCardSchema.nullable().optional(),
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
  /** @deprecated The flow-neutral estimate's disclosure; no longer sent
   * (metrics follow CopyDog's definitions, see `basis`). Kept optional so
   * older responses still parse. */
  methodology: z.object({
    version: z.literal("flow-neutral-v1"),
    intervals: z.number().int().nonnegative(),
    excludedIntervals: z.number().int().nonnegative(),
    excludedFraction: z.number().min(0).max(1).nullable(),
    capitalFloorUsd: z.number().nonnegative(),
    quality: z.enum(["observed", "partial", "unavailable"]),
  }).optional(),
  /** What the metrics were computed from (CopyDog's definitions, verified
   * against its public API 2026-09-30). Additive: optional while older api
   * builds roll out. */
  basis: z.object({
    version: z.literal("copydog-v1"),
    /** Peak net deposits of this market's series, the ROI's denominator:
     * max over the window of (account value − PnL). Null when ≤ 0. */
    capital: z.number().nullable(),
    /** Peak whole-account value over the window: the Sharpe / drawdown
     * returns' denominator. */
    peakAccountValue: z.number().nullable(),
    /** Interval returns behind the Sharpe (intervals from an empty account
     * skipped) and the annualisation used (365 ÷ median interval, days). */
    returns: z.number().int().nonnegative(),
    skippedIntervals: z.number().int().nonnegative(),
    periodsPerYear: z.number().nullable(),
  }).optional(),
  window: traderWindowSchema,
  market: z.enum(["all", "perp"]),
  accountValue: z.array(seriesPointSchema),
  pnl: z.array(seriesPointSchema),
  volume: z.number(),
  /** Largest peak-to-trough fall of the window's cumulative PnL (USD, ≥ 0). */
  maxDrawdownUsd: z.number(),
  /**
   * CopyDog's max drawdown, 0–1, of the whole account (perp + spot, whatever
   * `market`): interval returns rᵢ = ΔPnLᵢ ÷ the window's peak account value
   * (intervals from an empty account skipped); the largest fall of 1 + Σr
   * from its running peak, ÷ that peak, capped at 1. Deposits and
   * withdrawals don't move it. Coarse all-time sampling can make it smaller
   * than a shorter window's, as on CopyDog. Null without a usable interval.
   */
  maxDrawdownPct: z.number().nullable(),
  /**
   * CopyDog's Sharpe of the whole account over the window: mean(r) ÷ sample
   * stdev(r) × √(365 ÷ median interval in days), r as for `maxDrawdownPct`,
   * risk-free rate 0, Hyperliquid's latest (live) point included. Null with
   * fewer than 2 returns or zero variance.
   */
  sharpe: z.number().nullable(),
  /** Annualised volatility of the same returns: stdev(r) × √(365 ÷ median
   * interval). Additive. */
  volatility: z.number().nullable().optional(),
  /**
   * CopyDog's ROI for this market and window: its PnL ÷ `basis.capital`
   * (peak net deposits), so deposits and withdrawals don't count as return.
   * Capped at −100 %. Null without data, and null (shown as "—") when the
   * denominator is not real capital: below $100 of peak net deposits, when
   * the market's account value was never above 0 in the window (a unified
   * account's perp series), or above +10,000 %. The trader page's ROI tile
   * and the chart's ROI pill.
   */
  roi: z.number().nullable(),
  /**
   * PnL ÷ `basis.capital` at each `pnl` point (starting at 0), so the chart's
   * % mode ends at `roi`.
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

/** GET /traders/:address/fills?limit= — recent fills, perp and spot, as
 * CopyDog's 成交 tab lists them (ours when tracked, else Hyperliquid's
 * latest), TWAP slices included. Spot fills name a pair ("PURR/USDC") or a
 * spot index ("@107"). */
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
  /** Signed position size right before the fill (Hyperliquid
   * `startPosition`; 成交's 原持倉). Null when Hyperliquid didn't send it. */
  startPosition: z.number().nullable().optional(),
  /** The fill was part of a liquidation (Hyperliquid `liquidation`). */
  liquidation: z.boolean().optional(),
});
export type TraderFill = z.infer<typeof traderFillSchema>;

/** One resting order (Hyperliquid `frontendOpenOrders`), for the 訂單 tab. */
export const traderOrderSchema = z.object({
  oid: z.string(),
  coin: z.string(),
  side: z.enum(["buy", "sell"]),
  /** "Limit", "Stop Market", "Take Profit Limit", … as Hyperliquid names it. */
  orderType: z.string(),
  /** Remaining size; 0 for a position TP/SL, which closes the whole position. */
  size: z.number(),
  origSize: z.number(),
  limitPx: z.number().nullable(),
  triggerPx: z.number().nullable(),
  isTrigger: z.boolean(),
  triggerCondition: z.string().nullable(),
  reduceOnly: z.boolean(),
  isPositionTpsl: z.boolean(),
  placedAt: z.coerce.date(),
});
export type TraderOrder = z.infer<typeof traderOrderSchema>;

/** GET /traders/:address/orders — open orders on the main dex (spot
 * included) and every HIP-3 dex the account can have orders on. */
export const traderOrdersResponseSchema = z.object({
  orders: z.array(traderOrderSchema),
  /** Perp dexes queried ("" = main, which includes spot orders). */
  dexes: z.array(z.string()),
  fetchedAt: z.coerce.date(),
});
export type TraderOrdersResponse = z.infer<typeof traderOrdersResponseSchema>;

/** One running TWAP (Hyperliquid `twapHistory`, latest status "activated"). */
export const traderTwapSchema = z.object({
  twapId: z.number().int(),
  coin: z.string(),
  side: z.enum(["buy", "sell"]),
  size: z.number(),
  /** Executed so far, from its slice fills we can see (latest 2,000). */
  filledSize: z.number(),
  /** filledSize ÷ size, 0–1. */
  filledFraction: z.number(),
  minutes: z.number().int(),
  reduceOnly: z.boolean(),
  randomize: z.boolean(),
  startedAt: z.coerce.date(),
});
export type TraderTwap = z.infer<typeof traderTwapSchema>;

/** GET /traders/:address/twap — the address's running TWAP orders. */
export const traderTwapsResponseSchema = z.object({
  twaps: z.array(traderTwapSchema),
  fetchedAt: z.coerce.date(),
});
export type TraderTwapsResponse = z.infer<typeof traderTwapsResponseSchema>;

/** A ledger update's kind, as CopyDog classifies Hyperliquid's
 * `userNonFundingLedgerUpdates` (its labels: Deposit, Withdrawal, Sent,
 * Received, To HyperEVM, Vault Deposit, Staked, …). */
export const transferKindSchema = z.enum([
  "deposit", "withdraw", "sent", "received", "generic", "toHyperEvm", "toPerp", "fromPerp", "toSubaccount",
  "vaultDeposit", "vaultWithdraw", "vaultCreate", "vaultDistribution", "commission", "staked", "unstaked",
  "genesis", "rewards", "liquidated", "delegationSent", "delegationReceived", "dexAbstraction",
]);
export type TransferKind = z.infer<typeof transferKindSchema>;

/** One deposit, withdrawal, transfer, vault or staking movement. */
export const traderTransferSchema = z.object({
  time: z.coerce.date(),
  hash: z.string(),
  kind: transferKindSchema,
  /** "in" to the account, "out" of it, or "move" between its own balances. */
  direction: z.enum(["in", "out", "move"]),
  token: z.string(),
  /** In `token` units, or USD when `usd`. Always ≥ 0. */
  amount: z.number(),
  usd: z.boolean(),
  /** Counterparty addresses (lowercase); null when not an address. */
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type TraderTransfer = z.infer<typeof traderTransferSchema>;

/** GET /traders/:address/transfers — the last 90 days of ledger updates,
 * newest first (at most 500). */
export const traderTransfersResponseSchema = z.object({
  transfers: z.array(traderTransferSchema),
  /** Start of the window read. */
  from: z.coerce.date(),
  /** More updates exist in the window than were read. */
  truncated: z.boolean(),
  fetchedAt: z.coerce.date(),
});
export type TraderTransfersResponse = z.infer<typeof traderTransfersResponseSchema>;

// --- the signed-in user's wallet (Stage 4 step 2) ---------------------------

/** Where the user's own wallet lives (api HYPERLIQUID_NETWORK). The browser
 * signs bridge / withdraw actions for this network only. */
export const walletNetworkSchema = z.enum(["mainnet", "testnet"]);
export type WalletNetwork = z.infer<typeof walletNetworkSchema>;

/** GET /me/wallet — the main account (the user's Privy embedded wallet).
 * `address` is null until Privy reports one; the balances are then null too.
 * A part that couldn't be read is null (the rest still answers). USD values. */
export const walletResponseSchema = z.object({
  network: walletNetworkSchema,
  address: z.string().nullable(),
  hyperliquid: z
    .object({
      /** Perp account value (margin summary). */
      perpValue: z.number(),
      /** What `withdraw3` can take right now. */
      withdrawable: z.number(),
      /** Spot USDC, total and on hold by open spot orders. */
      spotUsdc: z.number(),
      spotUsdcHold: z.number(),
    })
    .nullable(),
  /** The deposit address's balances on the network's Arbitrum chain: USDC
   * not yet bridged, and ETH for gas. */
  arbitrum: z.object({ usdc: z.number(), eth: z.number() }).nullable(),
  /** Perp value + spot USDC + Arbitrum USDC waiting to be bridged. */
  totalValue: z.number(),
  fetchedAt: z.coerce.date(),
});
export type WalletResponse = z.infer<typeof walletResponseSchema>;

/** GET /me/wallet/history — the main account's deposits, withdrawals and
 * transfers on the wallet network (the 90-day ledger of the 轉帳 tab). */
export const walletHistoryResponseSchema = traderTransfersResponseSchema.extend({
  network: walletNetworkSchema,
  address: z.string().nullable(),
});
export type WalletHistoryResponse = z.infer<typeof walletHistoryResponseSchema>;

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
  /** Jointly completed raw-history snapshot. Null on the legacy path. */
  through: z.coerce.date().nullable().optional(),
  backfill: z.object({
    status: z.enum(["pending", "caught_up", "blocked"]),
    reason: z.enum(["timestamp_saturated", "upstream_unavailable"]).nullable(),
    regular: z.enum(["pending", "complete", "blocked"]),
    twap: z.enum(["pending", "complete", "blocked"]),
    retentionLimited: z.literal(true),
  }).optional(),
  /** "tracked": our own fills table; "hyperliquid": Hyperliquid's fill
   * history, read for this page. */
  source: z.enum(["tracked", "hyperliquid"]),
  /** Earliest fill read; null when there are none. */
  from: z.coerce.date().nullable(),
  /** Older history exists that isn't included (Hyperliquid's retention,
   * the lookback, or a position already open at `from`): the UI says
   * "based on trades since `from`". */
  truncated: z.boolean(),
  /** "complete": every position was opened inside the history held and
   * upstream retention cannot have cut it. "partial": figures cover only
   * trades since `partialSince`; never present them as lifetime figures. */
  completeness: z.enum(["complete", "partial"]).optional(),
  partialSince: z.coerce.date().nullable().optional(),
  /** Span certified by the public node archive (no REST retention limit);
   * both null when the address has none. */
  archiveFrom: z.coerce.date().nullable().optional(),
  archiveThrough: z.coerce.date().nullable().optional(),
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
export const patchCopyAlertsRequestSchema = z.object({ enabled: z.boolean() }).strict();

export const telegramStatusSchema = z.object({
  copyAlertsEnabled: z.boolean().default(false),
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
  /** Always the official bot's deep link: the page opens it in a new tab,
   * so anything else would be an open redirect. */
  url: z.string().url().startsWith("https://t.me/"),
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

// --- insights: cohorts (Stage 3 §3, CopyDog's /hyperliquid/cohorts) -----------

/** A PnL tier as a cohort (CopyDog's cohorts; 極度盈利 is the default). */
export const cohortTierSchema = pnlTierSchema;
export type CohortTier = z.infer<typeof cohortTierSchema>;

export const cohortWalletSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  verified: z.boolean(),
  /** Coins held, largest notional first, at most 5. */
  topAssets: z.array(z.string()),
  /** All-time perp PnL and ROI (CopyDog's definition); null when unknown. */
  totalPnl: z.number().nullable(),
  roi: z.number().nullable(),
  perpEquity: z.number().nullable(),
  copyScore: z.number().int().nullable(),
  /** Σ |notional| of open positions. */
  positionValue: z.number(),
  /** positionValue ÷ perpEquity; null without equity. */
  leverage: z.number().nullable(),
  sumUpnl: z.number(),
  /** Long share of the wallet's notional, 0–100; null when flat. */
  biasPct: z.number().nullable(),
});
export type CohortWallet = z.infer<typeof cohortWalletSchema>;

export const cohortMarketSchema = z.object({
  coin: z.string(),
  notionalLong: z.number(),
  notionalShort: z.number(),
  /** Long share of the market's notional, 0–100. */
  biasPct: z.number().nullable(),
  upnl: z.number(),
  tradersLong: z.number().int(),
  tradersShort: z.number().int(),
  /** Members whose position in this market is in profit / at a loss. */
  tradersProfit: z.number().int(),
  tradersLoss: z.number().int(),
});
export type CohortMarket = z.infer<typeof cohortMarketSchema>;

/** The share of a tier's members that must have a fresh snapshot before its
 * headline (the long share, the notional and PnL split, the per-market
 * split) is shown or recorded. Below it the figure is the positioning of
 * whichever members happened to be read first, not of the tier: on Stage,
 * 33 of 150 members gave "6.9 % long" where the full tier was at 41.8 %
 * (review finding 52). */
export const COHORT_HEADLINE_MIN_COVERAGE = 0.8;

/** Whether enough of a tier is fresh for its headline figures. */
export function cohortHeadlineReady(walletCount: number, memberCount: number): boolean {
  return memberCount > 0 && walletCount / memberCount >= COHORT_HEADLINE_MIN_COVERAGE;
}

/** GET /insights/cohorts/:tier — the tier's current positioning. */
export const cohortDetailResponseSchema = z.object({
  tier: cohortTierSchema,
  /** Members of the tier (≤ `discovery.cohortMembersPerTier`). */
  memberCount: z.number().int(),
  /** Members with a fresh snapshot (the wallets below). */
  walletCount: z.number().int(),
  /** {@link cohortHeadlineReady}: the page withholds the headline while
   * false. Absent from an api built before the field; the page then
   * decides from the two counts. */
  headlineReady: z.boolean().optional(),
  hero: z.object({
    upnlProfit: z.number(),
    upnlLoss: z.number(),
    /** upnlProfit ÷ (upnlProfit + upnlLoss), 0–100. */
    upnlProfitPct: z.number().nullable(),
    walletsInProfit: z.number().int(),
    walletsInLoss: z.number().int(),
    notionalLong: z.number(),
    notionalShort: z.number(),
    longPct: z.number().nullable(),
  }),
  /** By notional, largest first. */
  markets: z.array(cohortMarketSchema),
  /** By perp equity, largest first. */
  wallets: z.array(cohortWalletSchema),
  /** Oldest snapshot among the wallets; null when none. */
  updatedAt: z.coerce.date().nullable(),
});
export type CohortDetailResponse = z.infer<typeof cohortDetailResponseSchema>;

export const cohortWindowSchema = z.enum(["7d", "30d", "90d", "all"]);
export type CohortWindow = z.infer<typeof cohortWindowSchema>;

/** GET /insights/cohorts/:tier/history?window= — 倉位傾向: the long share
 * per refresh, and BTC's price over the same window (Hyperliquid candles). */
export const cohortHistoryResponseSchema = z.object({
  tier: cohortTierSchema,
  window: cohortWindowSchema,
  series: z.array(z.object({
    t: z.coerce.date(), pctLong: z.number(),
    /** Selected-member identity, not freshness coverage; legacy history is unknown. */
    membershipVersion: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    /** A membership boundary occurred since the previous returned point, even if downsampled out. */
    membershipChanged: z.boolean().optional(),
  })),
  /** [epoch ms, close], oldest first. */
  btc: z.array(z.tuple([z.number(), z.number()])),
});
export type CohortHistoryResponse = z.infer<typeof cohortHistoryResponseSchema>;

// --- site settings (admin) -------------------------------------------------------

export const localizedTextSchema = z.object({
  "zh-TW": z.string().max(280),
  en: z.string().max(280),
});

/**
 * Maintenance mode (review finding 17). While `enabled` the api refuses
 * writes with 503 `maintenance` (admins and the health routes excepted),
 * reads keep working and the web shows a notice on every page. `endsAt` is
 * when the work is expected to end, shown to visitors; it switches nothing
 * off by itself: writes stay refused until an admin turns maintenance off.
 * An empty `message` shows the web's own wording.
 */
export const maintenanceSettingsSchema = z.object({
  enabled: z.boolean(),
  message: localizedTextSchema,
  endsAt: z.string().datetime({ offset: true }).nullable(),
});
export type MaintenanceSettings = z.infer<typeof maintenanceSettingsSchema>;

/** What the retention job cleans, in the order it does. `account_deletion_records`
 * are the `user.delete` rows of `admin_audit_logs` (counts only); every
 * other audit row is `admin_audit_logs`. */
export const RETENTION_TABLES = [
  "position_snapshots", "equity_snapshots", "admin_audit_logs", "account_deletion_records",
  "action_outbox", "notification_outbox", "copy_signal_outbox", "alerts",
] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

const retentionDays = (min: number) => z.number().int().min(min).max(3650);
/**
 * How long operational data is kept (review findings 3 and 20). The worker
 * deletes what is older, once a day off-peak, in bounded batches. The
 * defaults are the periods the privacy policy (§6) states: changing one here
 * makes that text untrue until the policy is changed too.
 */
const retentionFields = {
  /** Off stops the job; nothing is deleted. */
  enabled: z.boolean(),
  /** position_snapshots and equity_snapshots. */
  snapshotDays: retentionDays(30),
  /** admin_audit_logs, except account-deletion records. */
  auditDays: retentionDays(30),
  /** `user.delete` audit rows (counts only, no email or address). */
  accountDeletionDays: retentionDays(30),
  /** Finished action_outbox, notification_outbox and copy_signal_outbox rows. */
  queueDays: retentionDays(7),
  /** Alert delivery records (`alerts`): what was sent to whom, and its result. */
  alertDays: retentionDays(7),
};
export const RETENTION_DEFAULTS = { enabled: true, snapshotDays: 90, auditDays: 365, accountDeletionDays: 365, queueDays: 30, alertDays: 30 } as const;
/** A stored value that lacks a field reads that field's default. */
export const retentionSettingsSchema = z.object({
  enabled: retentionFields.enabled.default(RETENTION_DEFAULTS.enabled),
  snapshotDays: retentionFields.snapshotDays.default(RETENTION_DEFAULTS.snapshotDays),
  auditDays: retentionFields.auditDays.default(RETENTION_DEFAULTS.auditDays),
  accountDeletionDays: retentionFields.accountDeletionDays.default(RETENTION_DEFAULTS.accountDeletionDays),
  queueDays: retentionFields.queueDays.default(RETENTION_DEFAULTS.queueDays),
  alertDays: retentionFields.alertDays.default(RETENTION_DEFAULTS.alertDays),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;
/** A save sends every field: a missing one must not quietly fall back to its default. */
export const retentionPatchSchema = z.object(retentionFields).strict();

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
  maintenance: maintenanceSettingsSchema.default({ enabled: false, message: { "zh-TW": "", en: "" }, endsAt: null }),
  /** Favorites a user may keep (review finding 18). null = not set here: the
   * deployment's MAX_FAVORITES_PER_USER applies. Lowering it removes nothing;
   * it only stops additions. */
  maxFavoritesPerUser: z.number().int().min(1).max(10_000).nullable().default(null),
  /** Addresses watched because a user favorites or copies them, across all
   * users (review finding 34): each one costs the worker snapshots and
   * sweeps, and the per-user limits alone let a few accounts take the whole
   * Hyperliquid budget. At the cap a favorite or copy of an address nobody
   * watches yet is refused; addresses already watched, and the admin's
   * imported leaders, are not affected. Lowering it stops additions only. */
  maxWatchedAddresses: z.number().int().min(1).max(100_000).default(100),
  /** Data retention periods (the whole value when changed). */
  retention: retentionSettingsSchema.default(RETENTION_DEFAULTS),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

/** A perp coin as Hyperliquid names it: "BTC", or "dex:COIN" for a HIP-3
 * market ("xyz:TSLA"). */
export const boardCoinSchema = z.string().regex(/^(?:[a-z0-9]{1,12}:)?[A-Za-z0-9]{1,20}$/);

export const discoverySettingsSchema = z.object({
  /** Trader cards on the home page, in order; empty → top by month PnL. */
  featuredAddresses: z.array(addressSchema).max(12).default([]),
  /** "Browse by market" chips on the home page. */
  homeMarkets: z.array(z.string().min(1).max(24)).max(16)
    .default(["BTC", "ETH", "SOL", "HYPE", "xyz:SP500", "xyz:GOLD", "xyz:NVDA", "xyz:TSLA"]),
  hideVaults: z.boolean().default(true),
  /** Fewer 30-day fills than this → greyed out with a "low sample" tag. */
  lowSampleThreshold: z.number().int().min(0).max(1000).default(20),
  leaderboardRefreshMinutes: z.number().int().min(5).max(240).default(15),
  /** Default activity filter on explore and home lists: "month" hides
   * accounts with no volume in 30 days (holders, not traders). */
  defaultActiveWithin: activeWithinSchema.default("month"),
  /** Discovery pool: the official leaderboard's top N (by all-time PnL)
   * among non-vault accounts that traded in 30 days, plus every KOL. */
  candidatePoolSize: z.number().int().min(50).max(5000).default(1000),
  /** Hyperliquid weight per minute the pool's trade-ledger loop (cold
   * builds and incremental refreshes of `trader_trades`) may spend; shared
   * with page traffic under the global budget, it always yields to pages
   * and scales down while pages are busy. 0 pauses it. */
  poolWeightPerMinute: z.number().int().min(0).max(600).default(100),
  /** Hyperliquid weight per minute the pool's performance loop (one
   * `portfolio` read of 20 per row: PnL, ROI, Sharpe, drawdown, copy score,
   * sparklines) may spend, independently of the ledger loop. Rows the
   * boards and home rows show, KOLs and followed traders are refreshed
   * four times as often as the rest. 240 → 12 rows a minute. */
  poolPerformanceWeightPerMinute: z.number().int().min(0).max(600).default(240),
  /** Cap on the durable fill-history job's Hyperliquid weight per minute
   * (enforced by the budgeter as a token bucket). */
  historyWeightPerMinute: z.number().int().min(0).max(600).default(120),
  /** Cap on the watcher's backward fill backfill (one window a minute). */
  backfillWeightPerMinute: z.number().int().min(0).max(600).default(120),
  /** Explore / home coin boards, in order (Hyperliquid coin names). */
  cryptoBoards: z.array(boardCoinSchema).max(16).default(["BTC", "ETH", "SOL", "DOGE", "HYPE", "ZEC", "NEAR"]),
  stockBoards: z.array(boardCoinSchema).max(16)
    .default(["xyz:SP500", "xyz:GOLD", "xyz:CL", "xyz:NVDA", "xyz:TSLA", "xyz:BRENTOIL", "xyz:SILVER"]),
  /** 洞察 cohorts: members per PnL tier whose positions are tracked … */
  cohortMembersPerTier: z.number().int().min(0).max(500).default(150),
  /** … refreshed this often (each member, and one history row per tier) … */
  cohortRefreshMinutes: z.number().int().min(5).max(240).default(15),
  /** … within this much Hyperliquid weight per minute (yields to pages). */
  cohortWeightPerMinute: z.number().int().min(0).max(600).default(60),
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
    maintenance: maintenanceSettingsSchema.extend({ message: localizedTextSchema.strict() }).strict().optional(),
    retention: retentionPatchSchema.optional(),
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
  /** Optional while older APIs roll out; absent means not in maintenance. */
  maintenance: maintenanceSettingsSchema.optional(),
  featuredAddresses: z.array(z.string()),
  homeMarkets: z.array(z.string()),
  /** Coin boards on explore and home (optional while older APIs roll out). */
  cryptoBoards: z.array(z.string()).optional(),
  stockBoards: z.array(z.string()).optional(),
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
  /** Per day (UTC), earned that day. */
  daily: z.array(
    z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), builder: z.number(), referral: z.number() }),
  ),
  lastSnapshotAt: z.coerce.date().nullable(),
});
export type AdminRevenueResponse = z.infer<typeof adminRevenueResponseSchema>;

// ===========================================================================
// Stage 3 — discovery boards (explore / home) and the KOL registry
// See docs/Stage 3 — CopyDog 頁面對齊（探索、收藏、洞察）.md §0.5, §1
// ===========================================================================

export const boardMarketSchema = z.enum(["crypto", "stocks"]);
export type BoardMarket = z.infer<typeof boardMarketSchema>;
export const boardSortSchema = z.enum(["copyScore", "pnl", "roi", "accountValue"]);
export type BoardSort = z.infer<typeof boardSortSchema>;
/** CopyDog's 30天 / 全部時間; coin boards are always all-time. */
export const boardWindowSchema = z.enum(["30d", "all"]);
export type BoardWindow = z.infer<typeof boardWindowSchema>;

/** GET /discover/boards — one board, fixed top 100, no paging (CopyDog's).
 * `board`: "top100", "kol", or a coin from the admin's board lists. */
export const boardQuerySchema = z.object({
  market: boardMarketSchema.default("crypto"),
  board: z.union([z.enum(["top100", "kol"]), boardCoinSchema]).default("top100"),
  sort: boardSortSchema.default("copyScore"),
  window: boardWindowSchema.default("all"),
  style: tradingStyleSchema.optional(),
}).strict();
export type BoardQuery = z.infer<typeof boardQuerySchema>;

/** A trader card / row. `pnl` and `roi` are the board's: the window's perp
 * figures, the market's realized figures (stocks), or the coin's realized
 * PnL and PnL ÷ volume traded (coin boards). */
/** Computation timestamps for the performance figures actually displayed,
 * not a guarantee that the underlying fills are equally recent. */
export const boardFreshnessSchema = z.object({
  oldestUpdatedAt: z.coerce.date().nullable(),
  newestUpdatedAt: z.coerce.date().nullable(),
  missingTimestamps: z.number().int().nonnegative(),
});
export const discoveryPoolSchema = z.object({
  ready: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  tradesReady: z.number().int().nonnegative().optional(),
});
export const boardTraderSchema = z.object({
  metricsUpdatedAt: z.coerce.date().nullable().optional(),
  address: z.string(),
  /** KOL name, else the leaderboard's display name; null → short address. */
  displayName: z.string().nullable(),
  /** A KOL's cached avatar, a path on the api (`/kols/:address/avatar?v=…`);
   * null → the web's generated avatar. */
  avatarUrl: z.string().nullable(),
  xHandle: z.string().nullable(),
  verified: z.boolean(),
  kol: z.boolean(),
  accountValue: z.number().nullable(),
  pnl: z.number().nullable(),
  roi: z.number().nullable(),
  /** 0–98, CopyDog's definition (docs/trade-analytics.md); null until computed. */
  copyScore: z.number().int().nullable(),
  style: tradingStyleSchema.nullable(),
  /** Most-traded coins, at most 5 (Hyperliquid names). */
  topCoins: z.array(z.string()),
  lastTradeAt: z.coerce.date().nullable(),
  /** Start of the fill history behind the trade-derived figures (win rate,
   * per-coin PnL and volume, style): they are "since this date", never
   * lifetime, unless the trader page's coverage says "complete". Null when
   * no trades have been computed. */
  tradesFrom: z.coerce.date().nullable().optional(),
  /** Whole-account PnL series (values only, oldest first) of the window. */
  sparkline: z.array(z.number()),
});
export type BoardTrader = z.infer<typeof boardTraderSchema>;

export const boardResponseSchema = z.object({
  market: boardMarketSchema,
  board: z.string(),
  /** The coin a coin board ranks by; null for top100 / kol. */
  coin: z.string().nullable(),
  sort: boardSortSchema,
  window: boardWindowSchema,
  style: tradingStyleSchema.nullable(),
  items: z.array(boardTraderSchema),
  /** Pool rows with figures / all pool rows: coverage while the job warms up. */
  pool: discoveryPoolSchema,
  rankingScope: z.literal("candidate_pool").optional(),
  eligibleCount: z.number().int().nonnegative().optional(),
  freshness: boardFreshnessSchema.optional(),
  /** Newest refresh among the board's rows; null when none is computed. */
  updatedAt: z.coerce.date().nullable(),
});
export type BoardResponse = z.infer<typeof boardResponseSchema>;

/** GET /discover/cards?addresses=… — any traders as explore cards with the
 * extra columns CopyDog's watchlist shows (favorites, insights wallets).
 * `pnl` / `roi` / `sparkline` are all-time. From the discovery pool when it
 * has the trader's figures (`source: "pool"`), else the leaderboard
 * (`"leaderboard"`: no copy score, sparkline, win rate or risk figures),
 * else identity only (`"none"`). No Hyperliquid calls. */
export const traderCardSchema = boardTraderSchema.extend({
  pnl30d: z.number().nullable(),
  /** Winning ÷ all closed trades of the trade ledger (all coins). */
  winRate: z.number().nullable(),
  sharpe: z.number().nullable(),
  /** 0–1. */
  maxDrawdown: z.number().nullable(),
  source: z.enum(["pool", "leaderboard", "none"]),
});
export type TraderCard = z.infer<typeof traderCardSchema>;
export const traderCardsQuerySchema = z.object({
  /** Comma-separated addresses, at most 200. */
  addresses: z.string().max(200 * 43),
}).strict();
export const traderCardsResponseSchema = z.object({ items: z.array(traderCardSchema) });
export type TraderCardsResponse = z.infer<typeof traderCardsResponseSchema>;

/** GET /discover/home — every home row in one read (7 cards each). */
export const homeBoardsResponseSchema = z.object({
  pool: discoveryPoolSchema.optional(),
  rankingScope: z.literal("candidate_pool").optional(),
  freshness: boardFreshnessSchema.optional(),
  /** 精選: the KOLs with figures, by copy score. */
  featured: z.array(boardTraderSchema),
  crypto: z.array(boardTraderSchema),
  stocks: z.array(boardTraderSchema),
  /** Per coin, in the admin's board order (crypto, then stocks). */
  markets: z.array(z.object({ coin: z.string(), market: boardMarketSchema, items: z.array(boardTraderSchema) })),
  /** The calculator card's six traders (all-time ROI). */
  calculator: z.array(boardTraderSchema),
  updatedAt: z.coerce.date().nullable(),
});
export type HomeBoardsResponse = z.infer<typeof homeBoardsResponseSchema>;

// --- Coin leaderboards (CopyDog's 市場 pages) -----------------------------------

/** One row of GET /discover/coins (CopyDog's `/hyperliquid/coins`): a market
 * with at least one pool trader who made money on it. */
export const coinIndexRowSchema = z.object({
  /** Hyperliquid name: "BTC", "xyz:TSLA". */
  coin: z.string(),
  market: boardMarketSchema,
  /** 獲利交易者: pool traders with realized PnL > 0 on this coin. */
  traders: z.number().int(),
  /** 獲利總額: their realized PnL, summed. */
  profit: z.number(),
});
export type CoinIndexRow = z.infer<typeof coinIndexRowSchema>;
export const coinIndexResponseSchema = z.object({
  /** By `profit`, highest first. */
  items: z.array(coinIndexRowSchema),
  pool: discoveryPoolSchema,
  updatedAt: z.coerce.date().nullable(),
});
export type CoinIndexResponse = z.infer<typeof coinIndexResponseSchema>;

/** A row of one coin's leaderboard: identity plus that coin's realized
 * figures from the trade ledger (all-time, net of fees). */
export const coinTraderSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  xHandle: z.string().nullable(),
  verified: z.boolean(),
  kol: z.boolean(),
  pnl: z.number(),
  /** Winning ÷ closed round trips on this coin; null when none closed. */
  winRate: z.number().nullable(),
  trades: z.number().int(),
  volume: z.number(),
});
export type CoinTrader = z.infer<typeof coinTraderSchema>;

/** GET /discover/coins/:coin — 「Hyperliquid 上最強的 BTC 交易者」: the pool's
 * traders who made money on the coin, by realized PnL, at most 40 (as
 * CopyDog lists); `stats` sums the listed rows. */
export const coinBoardResponseSchema = z.object({
  coin: z.string(),
  market: boardMarketSchema,
  stats: z.object({
    /** 列出的交易者 */
    traders: z.number().int(),
    /** 獲利總額 */
    profit: z.number(),
    /** 交易量 */
    volume: z.number(),
    /** 交易數 */
    trades: z.number().int(),
  }),
  items: z.array(coinTraderSchema),
  /** Whether the name is a Hyperliquid perp market (main dex or HIP-3):
   * false is "no such market" (the page answers 404), true with no items
   * is a real market without data yet, null is "not known right now". */
  listed: z.boolean().nullable(),
  pool: discoveryPoolSchema,
  updatedAt: z.coerce.date().nullable(),
});
export type CoinBoardResponse = z.infer<typeof coinBoardResponseSchema>;

// --- Header search (CopyDog's /traders/search) ------------------------------------

/** GET /discover/search?q=&limit= — name (KOL name, 𝕏 handle, leaderboard
 * name) or address prefix. */
export const discoverSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(10).default(5),
}).strict();
export type DiscoverSearchQuery = z.infer<typeof discoverSearchQuerySchema>;
export const discoverSearchResultSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  xHandle: z.string().nullable(),
  verified: z.boolean(),
  kol: z.boolean(),
  /** All-time PnL and ROI: the pool's perp figures, else the leaderboard's. */
  pnl: z.number().nullable(),
  roi: z.number().nullable(),
  accountValue: z.number().nullable(),
});
export type DiscoverSearchResult = z.infer<typeof discoverSearchResultSchema>;
export const discoverSearchResponseSchema = z.object({ items: z.array(discoverSearchResultSchema) });
export type DiscoverSearchResponse = z.infer<typeof discoverSearchResponseSchema>;

/** GET /traders/:address/copy-score — the trader page's 複製評分 and its
 * inputs (CopyDog's `/copy-score`), from the all-time portfolio. */
export const copyScoreResponseSchema = z.object({
  address: z.string(),
  copyScore: z.number().int().nullable(),
  components: z.object({
    roi: z.number().nullable(),
    pnl: z.number().nullable(),
    sharpe: z.number().nullable(),
    maxDrawdown: z.number().nullable(),
    returnSamples: z.number().int(),
    spanDays: z.number(),
    accountValue: z.number().nullable(),
  }),
  version: z.literal("copydog-v5-fit"),
});
export type CopyScoreResponse = z.infer<typeof copyScoreResponseSchema>;

// --- KOL registry (admin) ------------------------------------------------------

export const kolSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  /** As stored: the admin's explicit source URL; null → the 𝕏 handle's
   * profile picture. Pages never load it directly. */
  avatarUrl: z.string().nullable(),
  /** The api's cached copy (see `kolCardSchema`); null until fetched. */
  cachedAvatarUrl: z.string().nullable().optional(),
  xHandle: z.string().nullable(),
  verified: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Kol = z.infer<typeof kolSchema>;

const xHandleSchema = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);
/** POST /admin/kols (upsert by address) and PATCH /admin/kols/:address. */
export const kolInputSchema = z.object({
  address: addressSchema,
  displayName: z.string().trim().min(1).max(64).nullable().default(null),
  avatarUrl: z.string().url().max(512).refine((u) => u.startsWith("https://"), "https only").nullable().default(null),
  xHandle: xHandleSchema.nullable().default(null),
  verified: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1_000_000).default(0),
}).strict();
export type KolInput = z.infer<typeof kolInputSchema>;
export const kolPatchSchema = kolInputSchema.omit({ address: true }).partial().strict();
export type KolPatch = z.infer<typeof kolPatchSchema>;

/** POST /admin/kols/import — CSV with a header row: address, display_name,
 * x_handle, verified, sort_order[, avatar_url]. `replace` removes KOLs the
 * file doesn't list. */
export const kolImportRequestSchema = z.object({
  csv: z.string().min(1).max(500_000),
  replace: z.boolean().default(false),
}).strict();
export type KolImportRequest = z.infer<typeof kolImportRequestSchema>;
export const kolImportResponseSchema = z.object({
  inserted: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
  /** Rows skipped, with the 1-based line number and why. */
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
});
export type KolImportResponse = z.infer<typeof kolImportResponseSchema>;

// Copy trading (Stage 4 step 3, paper mode).
export * from "./copy.js";
export * from "./copy-runtime.js";
