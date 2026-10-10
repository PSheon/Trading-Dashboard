import { kolPreviewSchema } from "./kol-preview-contracts.js";
import { adminSourcesSchema } from "./admin-sources-contracts.js";
import { importPreviewSchema } from "./import-preview-contracts.js";
import { adminTraderSchema } from "./admin-trader-contracts.js";
import { favoriteGroupSchema, favoriteGroupsSchema } from "./favorite-group-contracts.js";
import { traderSearchResponseSchema } from "./trader-search-contracts.js";
import { appliedDiscoverySchema, deploymentTuningSchema, settingsRuntimeSchema, auditResponseSchema } from "./settings-ops-contracts.js";
import { backfillJobSchema, backfillJobsResponseSchema } from "./job-contracts.js";
import { z } from "zod";
import { adminResolvedWithdrawalSchema, adminUnresolvedWithdrawalsSchema, walletWithdrawalSchema, walletWithdrawalClaimSchema } from "./wallet-withdrawal-contracts.js";
import { copyExecutionAccountSchema, copyExecutionWalletsSchema, copyWalletGrantSchema } from "./copy-wallet-contracts.js";
import { copyFundingSchema, copyFundingClaimSchema, copyFundingOverviewSchema, copyReturnChallengeSchema, copyBuilderApprovalSchema } from "./copy-funding-contracts.js";
import { copyAgentSetupSchema, copyAgentOverviewSchema } from "./copy-agent-contracts.js";
import { copyAccountModeOverviewSchema, copyAccountModeOperationSchema } from "./copy-account-mode-contracts.js";
import { copyFollowerStatementSchema } from "./copy-follower-contracts.js";
import { copyFollowerActivitySchema } from "./copy-follower-activity-contracts.js";
import { copyFollowerSnapshotReadSchema } from "./copy-follower-view-contracts.js";
import { liveCopySetupSchema, liveCopySetupsSchema } from "./copy-live-setup-contracts.js";
import { liveCopySetupAbortSchema } from "./copy-live-setup-abort-contracts.js";
import { liveCopyOverviewSchema, liveCopyMandateSchema, liveCopyPortfolioSchema, liveManualCloseSchema, liveManualClosesSchema } from "./copy-live-mandate-contracts.js";
import { liveCopyStopSchema, liveCopyStopsSchema } from './copy-live-stop-contracts.js';
import { adminLiveAccountsSchema, adminLiveTransfersSchema, adminLiveOrdersSchema, adminLiveLatencySchema, adminRevokedLiveGrantSchema } from './admin-copy-live-contracts.js';
import * as s from "./schema/zod.js";
import { referralOverviewSchema, referralCodeSchema, referralCheckSchema, referralBindSchema, referralFriendsSchema, referralClaimSchema, referralClaimsSchema } from './referral-contracts.js';

const iso = z.string().datetime({ offset: true });
const id = z.string().regex(/^\d+$/);
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const wireActionSchema = s.actionFeedItemSchema.extend({ id, ts: iso, fillIds: z.array(id), notionalUsd: decimal, avgPx: decimal, leverage: decimal.nullable().optional() });
export const wireFillSchema = s.fillSchema.extend({ tid: id, ts: iso, px: decimal, sz: decimal, fee: decimal, closedPnl: decimal.nullable().optional() });
export const wireAlertSchema = s.alertSchema.extend({ id, actionId: id.nullable().optional(), sentAt: iso.nullable().optional(),
  pxAtSend: decimal.nullable().optional(), px1h: decimal.nullable().optional(), px4h: decimal.nullable().optional(), px24h: decimal.nullable().optional() });
export const wireLeaderSchema = s.leaderSchema.extend({ firstSeenAt: iso });
export const wireLeaderSummarySchema = s.leaderSummarySchema.extend({ firstSeenAt: iso, lastActionAt: iso.nullable() });
export const wirePublicLeaderSchema = s.publicLeaderSchema.extend({ firstSeenAt: iso });
export const wirePublicLeaderSummarySchema = s.publicLeaderSummarySchema.extend({ firstSeenAt: iso, lastActionAt: iso.nullable() });
export const wireLeaderDetailSchema = s.leaderDetailResponseSchema.extend({ leader: z.union([wirePublicLeaderSchema.strict(), wireLeaderSchema]), fills: z.array(wireFillSchema),
  positions: z.array(s.positionRowSchema.extend({ ts: iso })), equityCurve: z.array(s.equityPointSchema.extend({ ts: iso })), alerts: z.array(wireAlertSchema) });
export const wireTraderStatsSchema = s.traderStatsSchema.extend({ updatedAt: iso });
export const wireTradersSchema = s.tradersResponseSchema.extend({ updatedAt: iso.nullable(), items: z.array(wireTraderStatsSchema.extend({ favorite: z.boolean() })) });
export const wireTraderProfileSchema = s.traderProfileResponseSchema.extend({ stats: wireTraderStatsSchema.nullable(), lastTradeAt: iso.nullable().optional(), fetchedAt: iso });
export const wireTraderActivitySchema = s.traderActivityResponseSchema.extend({ lastTradeAt: iso.nullable(), fetchedAt: iso });
export const wireRoundTripSchema = s.roundTripSchema.extend({ id: z.string().regex(/^-?\d+$/), entryTime: iso, exitTime: iso.nullable() });
export const wireTradeCoverageSchema = s.tradeCoverageSchema.extend({ through: iso.nullable().optional(), from: iso.nullable(), fundingFrom: iso.nullable(), fundingThrough: iso.nullable(),
  partialSince: iso.nullable().optional(), archiveFrom: iso.nullable().optional(), archiveThrough: iso.nullable().optional() });
export const wireTraderAnalyticsSchema = s.traderAnalyticsResponseSchema.extend({
  summary: s.tradeSummarySchema.extend({ best: z.array(wireRoundTripSchema), worst: z.array(wireRoundTripSchema) }),
  coverage: wireTradeCoverageSchema, computedAt: iso,
});
export const wireTraderOrdersSchema = s.traderOrdersResponseSchema.extend({ orders: z.array(s.traderOrderSchema.extend({ placedAt: iso })), fetchedAt: iso });
export const wireTraderTwapsSchema = s.traderTwapsResponseSchema.extend({ twaps: z.array(s.traderTwapSchema.extend({ startedAt: iso })), fetchedAt: iso });
export const wireTraderTransfersSchema = s.traderTransfersResponseSchema.extend({ transfers: z.array(s.traderTransferSchema.extend({ time: iso })), from: iso, fetchedAt: iso });
export const wireTraderTradesSchema = s.traderTradesResponseSchema.extend({ items: z.array(wireRoundTripSchema), coverage: wireTradeCoverageSchema, computedAt: iso });
export const wireAdminUserSchema = s.adminUserSchema.extend({ createdAt: iso, lastLoginAt: iso });
export const wireMeSchema = s.meResponseSchema.extend({ createdAt: iso });
export const wireFavoriteSchema = s.favoriteSchema.extend({ createdAt: iso, stats: wireTraderStatsSchema.nullable() });
export const wireHeartbeatSchema = s.heartbeatResponseSchema.extend({
  feedDisconnectedSince: iso.nullable(), lastTradeAt: iso.nullable(), lastFillAt: iso.nullable(), lastSnapshotAt: iso.nullable(),
  lastSnapshotAttemptAt: iso.nullable().optional(), lastSnapshotFailureAt: iso.nullable().optional(), lastSweepAt: iso.nullable(), now: iso,
  fillsUnavailable: z.array(z.object({ address: z.string(), missedTrades: z.number().int(), since: iso })),
  archive: s.heartbeatResponseSchema.shape.archive.unwrap().extend({ liveNextHour: iso.nullable(), backfillCursorHour: iso.nullable(), lastRunAt: iso.nullable(),
    backfillFloor: iso.optional(), backfillPassStartedAt: iso.nullable().optional(), backfillNextPassAt: iso.nullable().optional() }).optional(),
});
/**
 * GET /health as anyone may read it (review finding 36): whether the site's
 * data feed is up, and the server's time. The budget, the queues, dry-run,
 * discovery and archive figures of the full heartbeat are for admins
 * (the admin system overview) and the worker's private monitor.
 */
export const publicHealthSchema = z.object({ status: z.enum(["ok", "degraded"]), feedConnected: z.boolean(), now: iso });
export type PublicHealth = z.infer<typeof publicHealthSchema>;
/** Private worker probe and admin monitoring share an explicit JSON contract. */
export const runtimeBudgetSchema = z.object({
  requestsLastMinute: z.number(), weightLastMinute: z.number(), effectiveBudgetPerMin: z.number(),
  configuredBudgetPerMin: z.number(), burstCapacity: z.number(), tokensAvailable: z.number(),
  lastRateLimitedAt: iso.nullable(), queued: z.object({ live: z.number(), background: z.number() }),
});
/** The deployment switches a process was started with (review finding 19):
 * read-only facts from its environment, shown to admins. Changing one means
 * changing the environment and restarting, not a setting. */
export const operationalSwitchesSchema = z.object({
  /** IS_WORKER: true on the worker, false on the api. */
  isWorker: z.boolean(),
  copyTradingMode: s.copyTradingModeSchema,
  hyperliquidNetwork: z.enum(["mainnet", "testnet"]),
  telegramDryRun: z.boolean(),
  archiveEnabled: z.boolean(),
  archiveMaxDailyUsd: z.number(),
  maxFavoritesPerUserDefault: z.number().int(),
});
export type OperationalSwitches = z.infer<typeof operationalSwitchesSchema>;
export const workerMonitorSchema = z.object({
  state: z.enum(["active", "standby", "stopping"]), instanceId: z.string().min(1), sampledAt: iso,
  settings: z.array(appliedDiscoverySchema).optional(),
  /** Optional while older workers roll out. */
  switches: operationalSwitchesSchema.optional(),
  /** The worker's deploy-time tuning (optional while older workers roll out). */
  tuning: deploymentTuningSchema.optional(),
  uptimeSeconds: z.number().nonnegative(), budget: runtimeBudgetSchema.nullable(), heartbeat: wireHeartbeatSchema.nullable(),
}).refine(v => v.state !== "active" || (v.budget !== null && v.heartbeat !== null), "Active worker requires telemetry");
/** `removed` and `cutoffs` are keyed by `RETENTION_TABLES`; a table absent
 * from `removed` was not reached in that run. `running` is a live lease. */
export const retentionStatusSchema = z.object({
  running: z.boolean(),
  lastStartedAt: iso.nullable(), lastFinishedAt: iso.nullable(),
  lastStatus: z.enum(["ok", "partial", "failed"]).nullable(),
  removed: z.record(z.string(), z.number().int()).nullable(),
  cutoffs: z.record(z.string(), iso).nullable(),
  lastError: z.string().nullable(), durationMs: z.number().int().nullable(),
});
export type RetentionStatus = z.infer<typeof retentionStatusSchema>;
export const adminSystemSchema = z.object({
  sampledAt: iso,
  api: z.object({ state: z.literal("active"), uptimeSeconds: z.number(), budget: runtimeBudgetSchema,
    /** Optional while older APIs roll out. */
    switches: operationalSwitchesSchema.optional(),
    tuning: deploymentTuningSchema.optional() }),
  worker: z.object({ state: z.enum(["active", "standby", "stopping", "stale", "unavailable", "not_configured"]), sample: workerMonitorSchema.nullable() }),
  database: z.object({ state: z.enum(["available", "unavailable"]), latencyMs: z.number().nullable() }),
  data: z.object({
    leaderboardCount: z.number(), leaderboardUpdatedAt: iso.nullable(), watched: z.number(), candidates: z.number(),
    freshness: z.object({
      leaderboardThresholdMinutes: z.number(), portfolioThresholdMinutes: z.number(), tradesThresholdMinutes: z.number(),
      leaderboard: z.enum(["fresh", "stale", "missing"]), portfolioStale: z.number(), portfolioMissing: z.number(), tradesStale: z.number(), tradesMissing: z.number(),
    }).optional(),
    portfolios: z.number(), trades: z.number(), errors: z.number(), oldestPortfolioAt: iso.nullable(), newestPortfolioAt: iso.nullable(),
  }).nullable(),
  outbox: z.array(z.object({ kind: z.enum(["evaluations", "deliveries"]), pending: z.number(), processing: z.number(), failed: z.number(), due: z.number(), expiredLeases: z.number(), oldestDueAt: iso.nullable() })).nullable(),
  /** The data-retention job: its last run and what it removed per table.
   * Optional while older APIs roll out; null when it could not be read. */
  retention: retentionStatusSchema.nullable().optional(),
});
export type AdminSystemOverview = z.infer<typeof adminSystemSchema>;
export const wireBoardFreshnessSchema = s.boardFreshnessSchema.extend({ oldestUpdatedAt: iso.nullable(), newestUpdatedAt: iso.nullable() });
/** A figure is never shown without the time of the Hyperliquid read
 * behind it: a card whose `metricsUpdatedAt` is missing has its PnL, ROI
 * and copy score blanked (shown "—"), whatever the api sent. */
const withoutUnstampedFigures = <T extends { metricsUpdatedAt?: string | null; pnl: number | null; roi: number | null; copyScore: number | null }>(t: T): T =>
  t.metricsUpdatedAt ? t : { ...t, pnl: null, roi: null, copyScore: null };
export const wireBoardTraderSchema = s.boardTraderSchema.extend({ metricsUpdatedAt: iso.nullable().optional(), lastTradeAt: iso.nullable(), tradesFrom: iso.nullable().optional() }).transform(withoutUnstampedFigures);
export const wireBoardSchema = s.boardResponseSchema.extend({ freshness: wireBoardFreshnessSchema.optional(), items: z.array(wireBoardTraderSchema), updatedAt: iso.nullable() });
export const wireHomeBoardsSchema = s.homeBoardsResponseSchema.extend({
  freshness: wireBoardFreshnessSchema.optional(),
  featured: z.array(wireBoardTraderSchema), crypto: z.array(wireBoardTraderSchema), stocks: z.array(wireBoardTraderSchema),
  markets: z.array(z.object({ coin: z.string(), market: s.boardMarketSchema, items: z.array(wireBoardTraderSchema) })),
  calculator: z.array(wireBoardTraderSchema), updatedAt: iso.nullable(),
});
export const wireKolSchema = s.kolSchema.extend({ createdAt: iso, updatedAt: iso });
export const wireCoinIndexSchema = s.coinIndexResponseSchema.extend({ updatedAt: iso.nullable() });
/** `listed` is absent from an api built before the field existed; that reads as "not known". */
export const wireCoinBoardSchema = s.coinBoardResponseSchema.extend({ updatedAt: iso.nullable(), listed: z.boolean().nullable().default(null) });
export const wireDiscoverSearchSchema = s.discoverSearchResponseSchema;
export const wireTraderCardSchema = s.traderCardSchema.extend({ metricsUpdatedAt: iso.nullable().optional(), lastTradeAt: iso.nullable(), tradesFrom: iso.nullable().optional() }).transform(withoutUnstampedFigures);
export const wireTraderCardsSchema = s.traderCardsResponseSchema.extend({ items: z.array(wireTraderCardSchema) });
export const wireCohortDetailSchema = s.cohortDetailResponseSchema.extend({ updatedAt: iso.nullable() });
export const wireCohortHistorySchema = s.cohortHistoryResponseSchema.extend({ series: z.array(s.cohortHistoryResponseSchema.shape.series.element.extend({ t: iso })) });
export const wireCopyScoreSchema = s.copyScoreResponseSchema;
export const wireWalletSchema = s.walletResponseSchema.extend({ fetchedAt: iso });
export const wireWalletHistorySchema = s.walletHistoryResponseSchema.extend({ transfers: z.array(s.traderTransferSchema.extend({ time: iso })), from: iso, fetchedAt: iso });
const wireCopyPositionSchema = s.copyPositionSchema.extend({ openedAt: iso });
export const wireCopyStrategySchema = s.copyStrategySchema.extend({ positions: z.array(wireCopyPositionSchema), activatedAt: iso, createdAt: iso, stoppedAt: iso.nullable() });
export const wireCopyOverviewSchema = s.copyOverviewResponseSchema.extend({ strategies: z.array(wireCopyStrategySchema), pricedAt: iso.nullable() });
export const wireCopyOrderSchema = s.copyOrderSchema.extend({ signalTime: iso, createdAt: iso, updatedAt: iso });
export const wireCopyLedgerSchema = s.copyLedgerResponseSchema.extend({ items: z.array(s.copyLedgerEntrySchema.extend({ createdAt: iso })) });
export const wireCopyFillsSchema = s.copyFillsResponseSchema.extend({ items: z.array(s.copyFillEntrySchema.extend({ ts: iso })) });
export type WireCopyLedger = z.infer<typeof wireCopyLedgerSchema>;
export type WireCopyFills = z.infer<typeof wireCopyFillsSchema>;
export const wireCopyOrdersSchema = s.copyOrdersResponseSchema.extend({ items: z.array(wireCopyOrderSchema) });
export const wireCopyPerformanceSchema = s.copyPerformanceResponseSchema.extend({
  from: iso, to: iso, points: z.array(s.copyPerformancePointSchema.extend({ time: iso })),
  coverage: s.copyPerformanceResponseSchema.shape.coverage.extend({ firstSnapshotAt: iso.nullable(), lastSnapshotAt: iso.nullable() }),
});
export const wireCopyEventSchema = s.copyEventSchema.extend({ createdAt: iso });
export const wireCopyEventsSchema = s.copyEventsResponseSchema.extend({ items: z.array(wireCopyEventSchema) });
/** GET /me/copy/stream (text/event-stream): the owner's copy events as they
 * commit (CopyDog's `portfolio-feed`), each exactly as GET /me/copy/events
 * lists it. `copy`: its SSE `id:` is the event id (the resume cursor; send it
 * back as `Last-Event-ID` to replay what was missed). `reset`: more were
 * missed than the replay bound; reload the list. */
export const copyStreamEventSchemas = {
  copy: wireCopyEventSchema,
  reset: z.object({ reason: z.literal("replay_truncated") }),
} as const;
export type CopyStreamEventName = keyof typeof copyStreamEventSchemas;
export const wireChartSnapshotsSchema = s.chartSnapshotsResponseSchema.extend({ coverageStart: iso.nullable() });
export const wireFundsHistorySchema = s.fundsHistoryResponseSchema.extend({ items: z.array(s.fundsFlowSchema.extend({ time: iso })) });
export const wireCopyPortfolioSchema = s.copyPortfolioResponseSchema.extend({ from: iso, to: iso, points: z.array(s.copyPortfolioResponseSchema.shape.points.element.extend({ time: iso })) });
export const wireCopyTradesSchema = s.copyTradesResponseSchema.extend({ items: z.array(s.copyClosedTradeSchema.extend({ openedAt: iso, closedAt: iso })) });
const wireCopyControlEventSchema = s.copyControlEventSchema.extend({ createdAt: iso });
export const wireAdminCopyControlSchema = s.adminCopyControlResponseSchema.extend({ event: wireCopyControlEventSchema });
export const wireAdminCopyOverviewSchema = s.adminCopyOverviewSchema.extend({
  platform: s.copyControlStateSchema.extend({ updatedAt: iso.nullable() }),
  outbox: s.adminCopyOverviewSchema.shape.outbox.extend({ oldestPendingAt: iso.nullable() }),
  events: z.array(wireCopyControlEventSchema),
});
const wireAdminCopyStrategySchema = s.adminCopyStrategySchema.extend({ positions: z.array(wireCopyPositionSchema), activatedAt: iso, createdAt: iso, stoppedAt: iso.nullable() });
export const wireAdminCopyStrategiesSchema = z.object({ items: z.array(wireAdminCopyStrategySchema) });
export const wireAdminCopyStrategyDetailSchema = s.adminCopyStrategyDetailSchema.extend({
  strategy: wireAdminCopyStrategySchema,
  versions: z.array(s.adminCopyStrategyDetailSchema.shape.versions.element.extend({ createdAt: iso })),
  orders: z.array(wireCopyOrderSchema),
  ledger: z.array(s.adminCopyStrategyDetailSchema.shape.ledger.element.extend({ createdAt: iso })),
});
export const wireAdminCopyOrdersSchema = z.object({ items: z.array(wireCopyOrderSchema.extend({ userEmail: z.string().nullable() })) });
export const wireAdminCopyExposureSchema = s.adminCopyExposureResponseSchema.extend({ pricedAt: iso.nullable() });
export const wireAdminCopyRiskSchema = s.adminCopyRiskResponseSchema.extend({
  createdAt: iso.nullable(),
  history: z.array(s.adminCopyRiskResponseSchema.shape.history.element.extend({ createdAt: iso })),
});
/** GET /actions/stream (text/event-stream). Each SSE `event:` name maps to the
 * schema of its JSON `data:`; both ends validate every event.
 * - `action`: a new row, exactly as GET /actions returns it; its SSE `id:` is the action id (the resume cursor).
 * - `update`: the slow path corrected a row in place (kind/side); no SSE id.
 * - `reset`: the resume gap was larger than the replay bound; refetch the list. */
export const actionStreamEventSchemas = {
  action: wireActionSchema,
  update: wireActionSchema,
  reset: z.object({ reason: z.literal("replay_truncated") }),
} as const;
export type ActionStreamEventName = keyof typeof actionStreamEventSchemas;
export interface HttpStreamContract { contentType: "text/event-stream"; events: Record<string, z.ZodTypeAny> }
/**
 * Stable `error.code`s of the copy routes (one-click copy plan §3h), for the
 * UI to say what went wrong instead of a bare 409. Each route lists the ones
 * it may answer in `errors`; the setup codes belong to the one-click setup
 * routes (plan steps 5–7).
 */
export const copyErrorCodes = [
  "already_copying", "strategy_limit", "below_min_allocation", "above_max_allocation", "leverage_above_limit",
  "copy_not_open", "copy_paused", "watch_capacity", "insufficient_main_balance", "funding_pending",
  "builder_fee_approval_required", "live_stop_in_progress",
  "consent_expired", "invalid_consent", "setup_unavailable", "setup_wallet_conflict", "setup_funding_rejected",
  "setup_abort_unavailable", "setup_abort_key_conflict", "setup_abort_wallet_conflict", "setup_abort_generation_conflict", "setup_already_applied",
  "setup_account_mode_failed", "setup_agent_rejected", "setup_builder_rejected", "setup_expired", "worker_signer_missing", "renewal_unavailable",
  "live_not_allowed", "live_fixed_sizing_required", "live_per_trade_out_of_range", "live_source_network_unsupported",
] as const;
export const copyErrorCodeSchema = z.enum(copyErrorCodes);
export type CopyErrorCode = z.infer<typeof copyErrorCodeSchema>;
const liveStrategyErrors: readonly CopyErrorCode[] = ["copy_not_open", "copy_paused", "strategy_limit", "already_copying", "below_min_allocation", "above_max_allocation", "leverage_above_limit", "watch_capacity",
  "live_not_allowed", "live_fixed_sizing_required", "live_per_trade_out_of_range", "live_source_network_unsupported"];

export interface HttpRouteContract {
  method: string; path: string; status: number; auth: string;
  /** Stable error codes this route may answer, besides the generic ones. */
  errors?: readonly CopyErrorCode[];
  /** JSON body schema; `z.never()` for a stream (no JSON body). */
  response: z.ZodTypeAny;
  /** Set for server-sent-event routes. */
  stream?: HttpStreamContract;
  raw?: boolean;
  /** Set for routes answering bytes (an image), not JSON: the media types
   * it may send. `response` is `z.never()`; errors keep the JSON envelope. */
  binary?: { contentTypes: string[] };
  pagination?: { type: "offset" | "cursor"; query: z.ZodTypeAny };
}
/** One registry drives server output validation, browser validation and route docs. */
export const httpRouteContracts: HttpRouteContract[] = [
  { method: "GET", path: "/health", status: 200, auth: "public; raw", raw: true, response: publicHealthSchema },
  { method: "GET", path: "/health/ready", status: 200, auth: "public; raw", raw: true, response: z.object({ ready: z.literal(true) }) },
  { method: "GET", path: "/actions", status: 200, auth: "public; favorites requires user", response: z.array(wireActionSchema) },
  { method: "GET", path: "/actions/stream", status: 200, auth: "public; favorites requires user; SSE", response: z.never(),
    stream: { contentType: "text/event-stream", events: actionStreamEventSchemas } },
  { method: "GET", path: "/actions/:id/fills", status: 200, auth: "public", response: z.array(wireFillSchema) },
  { method: "GET", path: "/alerts", status: 200, auth: "user own; alerts.readAll for all", response: z.array(wireAlertSchema) },
  { method: "GET", path: "/leaders", status: 200, auth: "public projection; full rows for leaders.manage", response: z.array(z.union([wirePublicLeaderSummarySchema.strict(), wireLeaderSummarySchema])) },
  { method: "GET", path: "/leaders/:chain/:address", status: 200, auth: "public projection; full row for leaders.manage; private alerts scoped", response: wireLeaderDetailSchema },
  { method: "PATCH", path: "/leaders/:chain/:address", status: 200, auth: "leaders.manage", response: wireLeaderSchema },
  { method: "GET", path: "/lists", status: 200, auth: "lists.read", response: z.array(s.leaderListSchema.extend({ importedAt: iso })) },
  { method: "POST", path: "/import/lists/preview", status: 200, auth: "leaders.import", response: importPreviewSchema },
  { method: "POST", path: "/import/lists", status: 201, auth: "leaders.import", response: s.importLeaderListResponseSchema },
  { method: "GET", path: "/alert-rules", status: 200, auth: "rules.read", response: z.array(s.alertRuleSchema) },
  { method: "POST", path: "/alert-rules", status: 201, auth: "rules.manage", response: s.alertRuleSchema },
  { method: "GET", path: "/trader-search", status: 200, auth: "public", response: traderSearchResponseSchema },
  { method: "GET", path: "/traders", pagination: { type: "offset", query: s.tradersQuerySchema }, status: 200, auth: "public", response: wireTradersSchema },
  { method: "GET", path: "/traders/sparklines", status: 200, auth: "public", response: s.sparklinesResponseSchema },
  { method: "GET", path: "/traders/:address", status: 200, auth: "public", response: wireTraderProfileSchema },
  { method: "GET", path: "/traders/:address/portfolio", status: 200, auth: "public", response: s.portfolioResponseSchema },
  { method: "GET", path: "/traders/:address/chart-snapshots", status: 200, auth: "public", response: wireChartSnapshotsSchema },
  { method: "GET", path: "/traders/:address/activity", status: 200, auth: "public", response: wireTraderActivitySchema },
  { method: "GET", path: "/traders/:address/fills", status: 200, auth: "public", response: z.array(s.traderFillSchema.extend({ ts: iso })) },
  { method: "GET", path: "/traders/:address/analytics", status: 200, auth: "public; 503 busy while a cold address computes", response: wireTraderAnalyticsSchema },
  { method: "GET", path: "/traders/:address/trades", pagination: { type: "cursor", query: s.traderTradesQuerySchema }, status: 200, auth: "public; 503 busy while a cold address computes", response: wireTraderTradesSchema },
  { method: "GET", path: "/traders/:address/orders", status: 200, auth: "public; 503 busy", response: wireTraderOrdersSchema },
  { method: "GET", path: "/traders/:address/twap", status: 200, auth: "public; 503 busy", response: wireTraderTwapsSchema },
  { method: "GET", path: "/traders/:address/transfers", status: 200, auth: "public; 503 busy", response: wireTraderTransfersSchema },
  { method: "GET", path: "/me", status: 200, auth: "user", response: wireMeSchema },
  { method: "PATCH", path: "/me", status: 200, auth: "user", response: wireMeSchema },
  { method: "DELETE", path: "/me", status: 204, auth: "user; 409 last_admin", response: z.undefined() },
  { method: "GET", path: "/me/favorite-groups", status: 200, auth: "user", response: favoriteGroupsSchema },
  { method: "POST", path: "/me/favorite-groups", status: 201, auth: "user", response: favoriteGroupSchema },
  { method: "PATCH", path: "/me/favorite-groups/:id", status: 200, auth: "user", response: favoriteGroupSchema },
  { method: "DELETE", path: "/me/favorite-groups/:id", status: 204, auth: "user", response: z.undefined() },
  { method: "PUT", path: "/me/favorite-groups/:id/members/:address", status: 204, auth: "user", response: z.undefined() },
  { method: "DELETE", path: "/me/favorite-groups/:id/members/:address", status: 204, auth: "user", response: z.undefined() },
  { method: "GET", path: "/me/favorites", status: 200, auth: "user", response: z.array(wireFavoriteSchema) },
  { method: "PUT", path: "/me/favorites/:address", status: 200, auth: "user", response: wireFavoriteSchema },
  { method: "DELETE", path: "/me/favorites/:address", status: 204, auth: "user", response: z.undefined() },
  { method: "PATCH", path: "/me/favorites/:address/alert", status: 200, auth: "user", response: wireFavoriteSchema },
  { method: "GET", path: "/me/telegram", status: 200, auth: "user", response: s.telegramStatusSchema.extend({ linkedAt: iso.nullable() }) },
  { method: "PATCH", path: "/me/telegram/copy-alerts", status: 200, auth: "user", response: s.telegramStatusSchema.extend({ linkedAt: iso.nullable() }) },
  { method: "POST", path: "/me/telegram/link", status: 200, auth: "user", response: s.telegramLinkResponseSchema.extend({ expiresAt: iso }) },
  { method: "POST", path: "/me/telegram/test", status: 200, auth: "user", response: s.telegramTestResponseSchema },
  { method: "DELETE", path: "/me/telegram", status: 204, auth: "user", response: z.undefined() },
  { method: "GET", path: "/me/wallet", status: 200, auth: "user; 503 busy", response: wireWalletSchema },
  { method: "GET", path: "/me/wallet/history", status: 200, auth: "user; 503 busy", response: wireWalletHistorySchema },
  { method: "GET", path: "/me/wallet/withdrawals/current", status: 200, auth: "user", response: walletWithdrawalSchema.nullable() },
  { method: "POST", path: "/me/wallet/withdrawals", status: 200, auth: "user; 409 withdrawal_pending", response: walletWithdrawalSchema },
  { method: "POST", path: "/me/wallet/withdrawals/import", status: 200, auth: "user; legacy metadata only", response: walletWithdrawalSchema },
  { method: "POST", path: "/me/wallet/withdrawals/:id/broadcast", status: 200, auth: "user; one broadcast permission", response: walletWithdrawalClaimSchema },
  { method: "POST", path: "/me/wallet/withdrawals/:id/submit", status: 200, auth: "user; verified main-wallet signature; one attempt", response: walletWithdrawalSchema },
  { method: "POST", path: "/me/wallet/withdrawals/:id/cancel", status: 200, auth: "user; unbroadcast preparation only", response: walletWithdrawalSchema },
  { method: "POST", path: "/me/wallet/withdrawals/:id/reconcile", status: 200, auth: "user; authoritative lookup only", response: walletWithdrawalSchema },
  { method: "GET", path: "/admin/wallet/withdrawals/unresolved", status: 200, auth: "admin.access + users.read", response: adminUnresolvedWithdrawalsSchema },
  { method: "POST", path: "/admin/wallet/withdrawals/:id/resolve", status: 200, auth: "admin.access + users.manage; after the nonce window; audited wallet.withdrawal.resolve", response: adminResolvedWithdrawalSchema },
  { method: "GET", path: "/insights/cohorts/:tier", status: 200, auth: "public", response: wireCohortDetailSchema },
  { method: "GET", path: "/insights/cohorts/:tier/history", status: 200, auth: "public", response: wireCohortHistorySchema },
  { method: "GET", path: "/insights/crowd", status: 200, auth: "public", response: s.crowdResponseSchema.extend({ updatedAt: iso.nullable() }) },
  { method: "GET", path: "/settings", status: 200, auth: "public", response: s.publicSettingsSchema },
  { method: "GET", path: "/admin/settings/runtime", status: 200, auth: "settings.read", response: settingsRuntimeSchema },
  { method: "GET", path: "/admin/audit", status: 200, auth: "audit.read", response: auditResponseSchema },
  { method: "GET", path: "/admin/settings", status: 200, auth: "settings.read", response: s.adminSettingsSnapshotSchema },
  { method: "PATCH", path: "/admin/settings", status: 200, auth: "settings.write", response: s.adminSettingsSnapshotSchema },
  { method: "GET", path: "/admin/users", pagination: { type: "offset", query: s.adminUsersQuerySchema }, status: 200, auth: "users.read", response: s.adminUsersResponseSchema.extend({ items: z.array(wireAdminUserSchema) }) },
  { method: "PATCH", path: "/admin/users/:id", status: 200, auth: "users.manage", response: wireAdminUserSchema },
  { method: "GET", path: "/admin/data-sources", status: 200, auth: "sources.read", response: adminSourcesSchema },
  { method: "GET", path: "/admin/traders/:chain/:address", status: 200, auth: "traders.read", response: adminTraderSchema },
  { method: "GET", path: "/admin/jobs", status: 200, auth: "jobs.read", response: backfillJobsResponseSchema },
  { method: "POST", path: "/admin/jobs/:id/retry", status: 202, auth: "jobs.retry", response: backfillJobSchema },
  { method: "GET", path: "/admin/system/overview", status: 200, auth: "admin.access", response: adminSystemSchema },
  { method: "GET", path: "/admin/overview", status: 200, auth: "overview.read", response: s.adminOverviewSchema.extend({ generatedAt: iso }) },
  { method: "GET", path: "/admin/revenue", status: 200, auth: "revenue.read", response: s.adminRevenueResponseSchema.extend({ lastSnapshotAt: iso.nullable() }) },
  { method: "GET", path: "/traders/:address/copy-score", status: 200, auth: "public; 503 busy", response: wireCopyScoreSchema },
  { method: "GET", path: "/discover/boards", status: 200, auth: "public", response: wireBoardSchema },
  { method: "GET", path: "/discover/home", status: 200, auth: "public", response: wireHomeBoardsSchema },
  { method: "GET", path: "/discover/coins", status: 200, auth: "public", response: wireCoinIndexSchema },
  { method: "GET", path: "/discover/markets", status: 200, auth: "public", response: s.marketNamesResponseSchema },
  { method: "GET", path: "/discover/coins/:coin", status: 200, auth: "public", response: wireCoinBoardSchema },
  { method: "GET", path: "/discover/search", status: 200, auth: "public", response: wireDiscoverSearchSchema },
  { method: "GET", path: "/admin/kols", status: 200, auth: "kols.manage", response: z.array(wireKolSchema) },
  { method: "POST", path: "/admin/kols", status: 201, auth: "kols.manage", response: wireKolSchema },
  { method: "POST", path: "/admin/kols/import/preview", status: 200, auth: "kols.manage", response: kolPreviewSchema },
  { method: "POST", path: "/admin/kols/import", status: 201, auth: "kols.manage", response: s.kolImportResponseSchema },
  { method: "PATCH", path: "/admin/kols/:address", status: 200, auth: "kols.manage", response: wireKolSchema },
  { method: "DELETE", path: "/admin/kols/:address", status: 204, auth: "kols.manage", response: z.undefined() },
  { method: "GET", path: "/discover/cards", status: 200, auth: "public", response: wireTraderCardsSchema },
  { method: "GET", path: "/me/copy", status: 200, auth: "user", response: wireCopyOverviewSchema },
  { method: "GET", path: "/me/copy/live", status: 200, auth: "user (owner); local testnet mandate state", response: liveCopyOverviewSchema },
  { method: "GET", path: "/me/referral", status: 200, auth: "user (owner); confirmed entitlement only", response: referralOverviewSchema },
  { method: "POST", path: "/me/referral/code", status: 200, auth: "user (owner)", response: referralCodeSchema },
  { method: "POST", path: "/me/referral/bind", status: 200, auth: "user (owner); first eligible attribution only", response: referralBindSchema },
  { method: "GET", path: "/me/referral/friends", status: 200, auth: "user (owner); anonymized referrals", response: referralFriendsSchema },
  { method: "GET", path: "/me/referral/claims", status: 200, auth: "user (owner)", response: referralClaimsSchema },
  { method: "GET", path: "/me/referral/claims/:id", status: 200, auth: "user (owner); original immutable request", response: referralClaimSchema },
  { method: "GET", path: "/me/referral/claims/by-key/:key", status: 200, auth: "user (owner); original read-only request recovery", response: referralClaimSchema },
  { method: "POST", path: "/me/referral/claims", status: 200, auth: "user (owner); existing request recovery; new payout unavailable", response: referralClaimSchema },
  { method: "GET", path: "/referral/check/:code", status: 200, auth: "public; code validity only", response: referralCheckSchema },
  { method: "POST", path: "/me/copy/live/mandates/:id/pause", status: 200, auth: "user (owner); local new-risk barrier", response: liveCopyMandateSchema, errors: ["live_stop_in_progress"] },
  { method: "POST", path: "/me/copy/live/mandates/:id/resume", status: 200, auth: "user (owner); no signature within the generation's lifetime", response: liveCopyMandateSchema, errors: ["live_stop_in_progress", "copy_paused"] },
  { method: "POST", path: "/me/copy/live/mandates/:id/revoke", status: 200, auth: "user (owner); local consent revocation preserves liabilities", response: liveCopyMandateSchema, errors: ["live_stop_in_progress"] },
  { method: 'POST', path: '/me/copy/live/mandates/:id/stop', status: 200, auth: 'user (owner); durable local risk barrier; no financial execution', response: liveCopyStopSchema },
  { method: 'POST', path: '/me/copy/live/execution-wallets/:id/positions/close', status: 200, auth: 'user (owner); one position of a running testnet copy; executed by the worker', response: liveManualCloseSchema },
  { method: 'GET', path: '/me/copy/live/execution-wallets/:id/closes', status: 200, auth: 'user (owner); read only', response: liveManualClosesSchema },
  { method: "POST", path: "/me/copy/live/setups", status: 200, auth: "user (owner); deployment network; prepares strategy, wallet, agent and deposit, no exchange call; one consent challenge", response: liveCopySetupSchema, errors: [...liveStrategyErrors, "setup_unavailable", "setup_wallet_conflict", "funding_pending"] },
  { method: "GET", path: "/me/copy/live/setups", status: 200, auth: "user (owner); read only", response: liveCopySetupsSchema },
  { method: "GET", path: "/me/copy/live/setups/by-key/:key", status: 200, auth: "user (owner); read-only original request recovery on this deployment network", response: liveCopySetupSchema },
  { method: "GET", path: "/me/copy/live/setups/:id", status: 200, auth: "user (owner); read only", response: liveCopySetupSchema },
  { method: "GET", path: "/me/copy/live/setups/:id/abort", status: 200, auth: "user (owner); deployment capability; read-only original setup abort progress", response: liveCopySetupAbortSchema },
  { method: "POST", path: "/me/copy/live/setups/:id/abort", status: 200, auth: "user (owner); deployment capability; durable original setup barrier and proof-bound return, no client amount, destination or signature", response: liveCopySetupAbortSchema, errors: ["setup_abort_unavailable", "setup_abort_key_conflict", "setup_abort_wallet_conflict", "setup_abort_generation_conflict", "setup_already_applied"] },
  { method: "POST", path: "/me/copy/live/setups/:id/confirm", status: 200, auth: "user (owner); the worker signer the browser added, the setup consent, the deposit signature and a fresh session; one deposit attempt", response: liveCopySetupSchema, errors: ["consent_expired", "invalid_consent", "worker_signer_missing", "setup_unavailable", "setup_wallet_conflict", "setup_builder_rejected", "insufficient_main_balance"] },
  { method: "POST", path: "/me/copy/live/setups/:id/advance", status: 200, auth: "user (owner); drives the setup now, signed by the worker; no body; attempted steps are only reconciled", response: liveCopySetupSchema },
  { method: "POST", path: "/me/copy/live/setups/:id/cancel", status: 200, auth: "user (owner); before the consent, or once the setup failed or expired", response: liveCopySetupSchema, errors: ["funding_pending"] },
  { method: "PATCH", path: "/me/copy/live/strategies/:id", status: 200, auth: "user (owner); a new generation under one setup consent", response: liveCopySetupSchema, errors: ["setup_unavailable", "live_stop_in_progress", "below_min_allocation", "above_max_allocation", "leverage_above_limit", "copy_not_open"] },
  { method: "POST", path: "/me/copy/live/strategies/:id/renew", status: 200, auth: "user (owner); refused for now (renewal_unavailable)", response: liveCopySetupSchema, errors: ["renewal_unavailable"] },
  { method: 'GET', path: '/me/copy/live/portfolio', status: 200, auth: 'user (owner); testnet copies with their funding and stop stage; read only', response: liveCopyPortfolioSchema },
  { method: 'GET', path: '/me/copy/live/stops', status: 200, auth: 'user (owner); bounded durable stop history; read only', response: liveCopyStopsSchema },
  { method: 'GET', path: '/me/copy/live/stops/by-key/:key', status: 200, auth: 'user (owner); exact original stop recovery; read only', response: liveCopyStopSchema },
  { method: "POST", path: "/me/copy/strategies", status: 201, auth: "user; 403 copy_not_open (`general.copyTradingEnabled` off); 409 already_copying / insufficient_balance / copy_paused", response: wireCopyStrategySchema },
  { method: "PATCH", path: "/me/copy/strategies/:id", status: 200, auth: "user (owner)", response: wireCopyStrategySchema },
  { method: "POST", path: "/me/copy/strategies/:id/funds", status: 200, auth: "user (owner)", response: wireCopyStrategySchema },
  { method: "POST", path: "/me/copy/strategies/:id/commands", status: 200, auth: "user (owner)", response: wireCopyStrategySchema },
  { method: "GET", path: "/me/copy/strategies/:id/ledger", status: 200, auth: "user (owner)", response: wireCopyLedgerSchema },
  { method: "GET", path: "/me/copy/strategies/:id/fills", status: 200, auth: "user (owner)", response: wireCopyFillsSchema },
  { method: "GET", path: "/me/copy/strategies/:id/orders", status: 200, auth: "user (owner)", response: wireCopyOrdersSchema },
  { method: "POST", path: "/me/copy/strategies/:id/withdraw-funds", status: 200, auth: "user (owner)", response: wireCopyStrategySchema },
  { method: "GET", path: "/me/copy/strategies/:id/performance", status: 200, auth: "user (owner)", response: wireCopyPerformanceSchema },
  { method: "GET", path: "/me/copy/events", status: 200, auth: "user", response: wireCopyEventsSchema },
  { method: "GET", path: "/me/copy/stream", status: 200, auth: "user (own events); SSE", response: z.never(),
    stream: { contentType: "text/event-stream", events: copyStreamEventSchemas } },
  { method: "GET", path: "/me/funds/history", status: 200, auth: "user (own flows)", response: wireFundsHistorySchema },
  { method: "GET", path: "/me/copy/portfolio", status: 200, auth: "user (own copies)", response: wireCopyPortfolioSchema },
  { method: "GET", path: "/me/copy/trades", status: 200, auth: "user (own copies)", response: wireCopyTradesSchema },
  { method: "GET", path: "/me/copy/execution-wallets", status: 200, auth: "user (owner)", response: copyExecutionWalletsSchema },
  { method: "GET", path: "/me/copy/agents", status: 200, auth: "user (owner)", response: copyAgentOverviewSchema },
  { method: "GET", path: "/me/copy/account-modes", status: 200, auth: "user (owner)", response: copyAccountModeOverviewSchema },
  { method: "GET", path: "/me/copy/account-modes/by-key/:key", status: 200, auth: "user (owner); original idempotency key", response: copyAccountModeOperationSchema },
  { method: "POST", path: "/me/copy/execution-wallets/:id/mode", status: 200, auth: "user (owner); ready dedicated testnet master", response: copyAccountModeOperationSchema },
  { method: "POST", path: "/me/copy/account-modes/:id/reconcile", status: 200, auth: "user (owner); read-only original mode operation", response: copyAccountModeOperationSchema },
  { method: "GET", path: "/me/copy/execution-wallets/:id/statement", status: 200, auth: "user (owner)", response: copyFollowerStatementSchema },
  { method: "GET", path: "/me/copy/execution-wallets/:id/activity", status: 200, auth: "user (owner); booked actual receipts; before-only pagination", response: copyFollowerActivitySchema },
  { method: "GET", path: "/me/copy/execution-wallets/:id/snapshot", status: 200, auth: "user (owner); cached actual testnet observation", response: copyFollowerSnapshotReadSchema },
  { method: "POST", path: "/me/copy/execution-wallets/:id/agent", status: 200, auth: "user (owner); configured testnet agent provider", response: copyAgentSetupSchema },
  { method: "POST", path: "/me/copy/agents/:id/reconcile", status: 200, auth: "user (owner)", response: copyAgentSetupSchema },
  { method: "GET", path: "/me/copy/funding", status: 200, auth: "user (owner)", response: copyFundingOverviewSchema },
  { method: "POST", path: "/me/copy/execution-wallets/:id/funding", status: 200, auth: "user (owner); testnet; verified execution account", response: copyFundingSchema, errors: ["funding_pending"] },
  { method: "POST", path: "/me/copy/funding/:id/broadcast", status: 200, auth: "user (owner); one permission", response: copyFundingClaimSchema },
  { method: "POST", path: "/me/copy/funding/:id/submit", status: 200, auth: "user (owner); exact source signature; one attempt", response: copyFundingSchema, errors: ["insufficient_main_balance"] },
  { method: "POST", path: "/me/copy/funding/:id/cancel", status: 200, auth: "user (owner); unattempted intent only", response: copyFundingSchema },
  { method: "POST", path: "/me/copy/funding/:id/reconcile", status: 200, auth: "user (owner); positive transaction and recipient evidence", response: copyFundingSchema },
  { method: "POST", path: "/me/copy/live/execution-wallets/:id/returns", status: 200, auth: "user (owner); testnet; return to the main wallet, prepared only", response: copyReturnChallengeSchema },
  { method: "POST", path: "/me/copy/live/returns/:id/approve", status: 200, auth: "user (owner); signed by the worker under the owner's policy; no body; one attempt", response: copyFundingSchema, errors: ["worker_signer_missing", "setup_wallet_conflict", "consent_expired"] },
  { method: "POST", path: "/me/copy/live/builder-approvals/:id/reconcile", status: 200, auth: "user (owner); read only", response: copyBuilderApprovalSchema },
  { method: "POST", path: "/me/copy/strategies/:id/execution-wallet", status: 200, auth: "user (owner); configured wallet provider; deployment network only", response: copyExecutionAccountSchema },
  { method: "POST", path: "/me/copy/execution-wallets/:id/reconcile", status: 200, auth: "user (owner)", response: copyExecutionAccountSchema },
  { method: "POST", path: "/me/copy/execution-wallets/:id/automatic-return", status: 200, auth: "user (owner); testnet; fresh session adds the policy-bound worker signer", response: copyExecutionAccountSchema, errors: ["setup_unavailable", "setup_wallet_conflict"] },
  { method: "POST", path: "/me/copy/wallet-authorizations/:id/revoke", status: 200, auth: "user (owner)", response: copyWalletGrantSchema },
  { method: "GET", path: "/admin/copy/overview", status: 200, auth: "copy.read", response: wireAdminCopyOverviewSchema },
  { method: "GET", path: "/admin/copy/strategies", status: 200, auth: "copy.read", response: wireAdminCopyStrategiesSchema },
  { method: "GET", path: "/admin/copy/strategies/:id", status: 200, auth: "copy.read", response: wireAdminCopyStrategyDetailSchema },
  { method: "GET", path: "/admin/copy/orders", status: 200, auth: "copy.read", response: wireAdminCopyOrdersSchema },
  { method: "GET", path: "/admin/copy/exposure", status: 200, auth: "copy.read", response: wireAdminCopyExposureSchema },
  { method: "GET", path: "/admin/copy/risk", status: 200, auth: "copy.read", response: wireAdminCopyRiskSchema },
  { method: "POST", path: "/admin/copy/controls", status: 201, auth: "copy.read + execution.pause (resume: execution.resume); 409 stale_revision", response: wireAdminCopyControlSchema },
  { method: "PUT", path: "/admin/copy/risk", status: 200, auth: "risk.manage; 409 stale_version", response: wireAdminCopyRiskSchema },
  { method: "GET", path: "/admin/copy/live/accounts", status: 200, auth: "copy.read", response: adminLiveAccountsSchema },
  { method: "GET", path: "/admin/copy/live/transfers", status: 200, auth: "copy.read", response: adminLiveTransfersSchema },
  { method: "GET", path: "/admin/copy/live/orders", status: 200, auth: "copy.read", response: adminLiveOrdersSchema },
  { method: "GET", path: "/admin/copy/live/latency", status: 200, auth: "copy.read", response: adminLiveLatencySchema },
  { method: "POST", path: "/admin/copy/live/grants/:id/revoke", status: 200, auth: "copy.read + execution.pause; audited copy.grant.revoke", response: adminRevokedLiveGrantSchema },
  { method: "GET", path: "/kols/:address/avatar", status: 200, auth: "public; image bytes, 304 on If-None-Match", response: z.never(),
    binary: { contentTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] } },
];
export function findHttpContract(method: string, path: string) {
  const clean = (path.split("?")[0] ?? "").replace(/\/$/, "");
  return httpRouteContracts.find((route) => route.method === method &&
    new RegExp(`^${route.path.replace(/:[^/]+/g, "[^/]+")}$`).test(clean));
}

export type WireAction = z.infer<typeof wireActionSchema>;
export type WireFill = z.infer<typeof wireFillSchema>;
export type WireAlert = z.infer<typeof wireAlertSchema>;
export type WireRoundTrip = z.infer<typeof wireRoundTripSchema>;
export type WireTraderAnalytics = z.infer<typeof wireTraderAnalyticsSchema>;
export type WireTraderTrades = z.infer<typeof wireTraderTradesSchema>;
export type WireTraderOrders = z.infer<typeof wireTraderOrdersSchema>;
export type WireTraderTwaps = z.infer<typeof wireTraderTwapsSchema>;
export type WireTraderTransfers = z.infer<typeof wireTraderTransfersSchema>;
export type WireBoardTrader = z.infer<typeof wireBoardTraderSchema>;
export type WireBoard = z.infer<typeof wireBoardSchema>;
export type WireHomeBoards = z.infer<typeof wireHomeBoardsSchema>;
export type WireKol = z.infer<typeof wireKolSchema>;
export type WireCoinIndex = z.infer<typeof wireCoinIndexSchema>;
export type WireCoinBoard = z.infer<typeof wireCoinBoardSchema>;
export type WireDiscoverSearch = z.infer<typeof wireDiscoverSearchSchema>;
export type WireCopyScore = z.infer<typeof wireCopyScoreSchema>;
export type WireTraderCard = z.infer<typeof wireTraderCardSchema>;
export type WireTraderCards = z.infer<typeof wireTraderCardsSchema>;
export type WireCohortDetail = z.infer<typeof wireCohortDetailSchema>;
export type WireCohortHistory = z.infer<typeof wireCohortHistorySchema>;
export type WireWallet = z.infer<typeof wireWalletSchema>;
export type WireWalletHistory = z.infer<typeof wireWalletHistorySchema>;
export type WireCopyOverview = z.infer<typeof wireCopyOverviewSchema>;
export type WireCopyStrategy = z.infer<typeof wireCopyStrategySchema>;
export type WireCopyOrder = z.infer<typeof wireCopyOrderSchema>;
export type WireCopyOrders = z.infer<typeof wireCopyOrdersSchema>;
export type WireCopyPerformance = z.infer<typeof wireCopyPerformanceSchema>;
export type WireCopyEvents = z.infer<typeof wireCopyEventsSchema>;
export type WireCopyPortfolio = z.infer<typeof wireCopyPortfolioSchema>;
export type WireChartSnapshots = z.infer<typeof wireChartSnapshotsSchema>;
export type WireFundsHistory = z.infer<typeof wireFundsHistorySchema>;
export type WireCopyTrades = z.infer<typeof wireCopyTradesSchema>;
export type WireAdminCopyOverview = z.infer<typeof wireAdminCopyOverviewSchema>;
export type WireAdminCopyStrategies = z.infer<typeof wireAdminCopyStrategiesSchema>;
export type WireAdminCopyStrategyDetail = z.infer<typeof wireAdminCopyStrategyDetailSchema>;
export type WireAdminCopyOrders = z.infer<typeof wireAdminCopyOrdersSchema>;
export type WireAdminCopyExposure = z.infer<typeof wireAdminCopyExposureSchema>;
export type WireAdminCopyRisk = z.infer<typeof wireAdminCopyRiskSchema>;
export type WireAdminCopyControl = z.infer<typeof wireAdminCopyControlSchema>;
