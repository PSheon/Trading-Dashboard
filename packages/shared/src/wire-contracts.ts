import { z } from "zod";
import * as s from "./schema/zod.js";

const iso = z.string().datetime({ offset: true });
const id = z.string().regex(/^\d+$/);
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const wireActionSchema = s.actionFeedItemSchema.extend({ id, ts: iso, fillIds: z.array(id), notionalUsd: decimal, avgPx: decimal, leverage: decimal.nullable().optional() });
export const wireFillSchema = s.fillSchema.extend({ tid: id, ts: iso, px: decimal, sz: decimal, fee: decimal, closedPnl: decimal.nullable().optional() });
export const wireAlertSchema = s.alertSchema.extend({ id, actionId: id.nullable().optional(), sentAt: iso.nullable().optional(),
  pxAtSend: decimal.nullable().optional(), px1h: decimal.nullable().optional(), px4h: decimal.nullable().optional(), px24h: decimal.nullable().optional() });
export const wireLeaderSchema = s.leaderSchema.extend({ firstSeenAt: iso });
export const wireLeaderSummarySchema = s.leaderSummarySchema.extend({ firstSeenAt: iso, lastActionAt: iso.nullable() });
export const wireLeaderDetailSchema = s.leaderDetailResponseSchema.extend({ leader: wireLeaderSchema, fills: z.array(wireFillSchema),
  positions: z.array(s.positionRowSchema.extend({ ts: iso })), equityCurve: z.array(s.equityPointSchema.extend({ ts: iso })), alerts: z.array(wireAlertSchema) });
export const wireTraderStatsSchema = s.traderStatsSchema.extend({ updatedAt: iso });
export const wireTradersSchema = s.tradersResponseSchema.extend({ updatedAt: iso.nullable(), items: z.array(wireTraderStatsSchema.extend({ favorite: z.boolean() })) });
export const wireTraderProfileSchema = s.traderProfileResponseSchema.extend({ stats: wireTraderStatsSchema.nullable(), lastTradeAt: iso.nullable().optional(), fetchedAt: iso });
export const wireTraderActivitySchema = s.traderActivityResponseSchema.extend({ lastTradeAt: iso.nullable(), fetchedAt: iso });
export const wireRoundTripSchema = s.roundTripSchema.extend({ id: z.string().regex(/^-?\d+$/), entryTime: iso, exitTime: iso.nullable() });
export const wireTradeCoverageSchema = s.tradeCoverageSchema.extend({ from: iso.nullable(), fundingFrom: iso.nullable(), fundingThrough: iso.nullable() });
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
});
export const wireBoardTraderSchema = s.boardTraderSchema.extend({ lastTradeAt: iso.nullable() });
export const wireBoardSchema = s.boardResponseSchema.extend({ items: z.array(wireBoardTraderSchema), updatedAt: iso.nullable() });
export const wireHomeBoardsSchema = s.homeBoardsResponseSchema.extend({
  featured: z.array(wireBoardTraderSchema), crypto: z.array(wireBoardTraderSchema), stocks: z.array(wireBoardTraderSchema),
  markets: z.array(z.object({ coin: z.string(), market: s.boardMarketSchema, items: z.array(wireBoardTraderSchema) })),
  calculator: z.array(wireBoardTraderSchema), updatedAt: iso.nullable(),
});
export const wireKolSchema = s.kolSchema.extend({ createdAt: iso, updatedAt: iso });
export const wireCoinIndexSchema = s.coinIndexResponseSchema.extend({ updatedAt: iso.nullable() });
export const wireCoinBoardSchema = s.coinBoardResponseSchema.extend({ updatedAt: iso.nullable() });
export const wireTraderSearchSchema = s.traderSearchResponseSchema;
export const wireTraderCardSchema = s.traderCardSchema.extend({ lastTradeAt: iso.nullable() });
export const wireTraderCardsSchema = s.traderCardsResponseSchema.extend({ items: z.array(wireTraderCardSchema) });
export const wireFavoriteGroupSchema = s.favoriteGroupSchema.extend({ createdAt: iso });
export const wireCohortDetailSchema = s.cohortDetailResponseSchema.extend({ updatedAt: iso.nullable() });
export const wireCohortHistorySchema = s.cohortHistoryResponseSchema.extend({ series: z.array(z.object({ t: iso, pctLong: z.number() })) });
export const wireCopyScoreSchema = s.copyScoreResponseSchema;
export const wireWalletSchema = s.walletResponseSchema.extend({ fetchedAt: iso });
export const wireWalletHistorySchema = s.walletHistoryResponseSchema.extend({ transfers: z.array(s.traderTransferSchema.extend({ time: iso })), from: iso, fetchedAt: iso });
const wireCopyPositionSchema = s.copyPositionSchema.extend({ openedAt: iso });
export const wireCopyStrategySchema = s.copyStrategySchema.extend({ positions: z.array(wireCopyPositionSchema), activatedAt: iso, createdAt: iso, stoppedAt: iso.nullable() });
export const wireCopyOverviewSchema = s.copyOverviewResponseSchema.extend({ strategies: z.array(wireCopyStrategySchema), pricedAt: iso.nullable() });
export const wireCopyOrderSchema = s.copyOrderSchema.extend({ signalTime: iso, createdAt: iso, updatedAt: iso });
export const wireCopyOrdersSchema = z.object({ items: z.array(wireCopyOrderSchema) });
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
const outboxCounts =z.array(z.object({ status: z.string(), count: z.number().int().nonnegative() }));
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
export interface HttpRouteContract {
  method: string; path: string; status: number; auth: string;
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
  { method: "GET", path: "/health", status: 200, auth: "public; raw", raw: true, response: wireHeartbeatSchema },
  { method: "GET", path: "/health/ready", status: 200, auth: "public; raw", raw: true, response: z.object({ ready: z.literal(true) }) },
  { method: "GET", path: "/actions", status: 200, auth: "public; favorites requires user", response: z.array(wireActionSchema) },
  { method: "GET", path: "/actions/stream", status: 200, auth: "public; favorites requires user; SSE", response: z.never(),
    stream: { contentType: "text/event-stream", events: actionStreamEventSchemas } },
  { method: "GET", path: "/actions/:id/fills", status: 200, auth: "public", response: z.array(wireFillSchema) },
  { method: "GET", path: "/alerts", status: 200, auth: "user own; alerts.readAll for all", response: z.array(wireAlertSchema) },
  { method: "GET", path: "/leaders", status: 200, auth: "public", response: z.array(wireLeaderSummarySchema) },
  { method: "GET", path: "/leaders/:chain/:address", status: 200, auth: "public; private alerts scoped", response: wireLeaderDetailSchema },
  { method: "PATCH", path: "/leaders/:chain/:address", status: 200, auth: "leaders.manage", response: wireLeaderSchema },
  { method: "GET", path: "/lists", status: 200, auth: "lists.read", response: z.array(s.leaderListSchema.extend({ importedAt: iso })) },
  { method: "GET", path: "/lists/diff", status: 200, auth: "lists.read", response: s.listDiffResponseSchema },
  { method: "POST", path: "/import/lists", status: 201, auth: "leaders.import", response: s.importLeaderListResponseSchema },
  { method: "GET", path: "/alert-rules", status: 200, auth: "rules.read", response: z.array(s.alertRuleSchema) },
  { method: "POST", path: "/alert-rules", status: 201, auth: "rules.manage", response: s.alertRuleSchema },
  { method: "GET", path: "/traders", pagination: { type: "offset", query: s.tradersQuerySchema }, status: 200, auth: "public", response: wireTradersSchema },
  { method: "GET", path: "/traders/sparklines", status: 200, auth: "public", response: s.sparklinesResponseSchema },
  { method: "GET", path: "/traders/:address", status: 200, auth: "public", response: wireTraderProfileSchema },
  { method: "GET", path: "/traders/:address/portfolio", status: 200, auth: "public", response: s.portfolioResponseSchema },
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
  { method: "GET", path: "/me/favorites", status: 200, auth: "user", response: z.array(wireFavoriteSchema) },
  { method: "PUT", path: "/me/favorites/:address", status: 200, auth: "user", response: wireFavoriteSchema },
  { method: "DELETE", path: "/me/favorites/:address", status: 204, auth: "user", response: z.undefined() },
  { method: "PATCH", path: "/me/favorites/:address/alert", status: 200, auth: "user", response: wireFavoriteSchema },
  { method: "GET", path: "/me/telegram", status: 200, auth: "user", response: s.telegramStatusSchema.extend({ linkedAt: iso.nullable() }) },
  { method: "POST", path: "/me/telegram/link", status: 200, auth: "user", response: s.telegramLinkResponseSchema.extend({ expiresAt: iso }) },
  { method: "POST", path: "/me/telegram/test", status: 200, auth: "user", response: s.telegramTestResponseSchema },
  { method: "DELETE", path: "/me/telegram", status: 204, auth: "user", response: z.undefined() },
  { method: "GET", path: "/me/wallet", status: 200, auth: "user; 503 busy", response: wireWalletSchema },
  { method: "GET", path: "/me/wallet/history", status: 200, auth: "user; 503 busy", response: wireWalletHistorySchema },
  { method: "GET", path: "/insights/cohorts/:tier", status: 200, auth: "public", response: wireCohortDetailSchema },
  { method: "GET", path: "/insights/cohorts/:tier/history", status: 200, auth: "public", response: wireCohortHistorySchema },
  { method: "GET", path: "/insights/crowd", status: 200, auth: "public", response: s.crowdResponseSchema.extend({ updatedAt: iso.nullable() }) },
  { method: "GET", path: "/settings", status: 200, auth: "public", response: s.publicSettingsSchema },
  { method: "GET", path: "/admin/settings", status: 200, auth: "settings.read", response: s.adminSettingsSnapshotSchema },
  { method: "PATCH", path: "/admin/settings", status: 200, auth: "settings.write", response: s.adminSettingsSnapshotSchema },
  { method: "GET", path: "/admin/users", pagination: { type: "offset", query: s.adminUsersQuerySchema }, status: 200, auth: "users.read", response: s.adminUsersResponseSchema.extend({ items: z.array(wireAdminUserSchema) }) },
  { method: "PATCH", path: "/admin/users/:id", status: 200, auth: "users.manage", response: wireAdminUserSchema },
  { method: "GET", path: "/admin/overview", status: 200, auth: "overview.read", response: s.adminOverviewSchema.extend({ generatedAt: iso }) },
  { method: "GET", path: "/admin/revenue", status: 200, auth: "revenue.read", response: s.adminRevenueResponseSchema.extend({ lastSnapshotAt: iso.nullable() }) },
  { method: "GET", path: "/admin/outbox", status: 200, auth: "admin.access", response: z.object({ evaluations: outboxCounts, deliveries: outboxCounts }) },
  { method: "GET", path: "/traders/:address/copy-score", status: 200, auth: "public; 503 busy", response: wireCopyScoreSchema },
  { method: "GET", path: "/discover/boards", status: 200, auth: "public", response: wireBoardSchema },
  { method: "GET", path: "/discover/home", status: 200, auth: "public", response: wireHomeBoardsSchema },
  { method: "GET", path: "/discover/coins", status: 200, auth: "public", response: wireCoinIndexSchema },
  { method: "GET", path: "/discover/coins/:coin", status: 200, auth: "public", response: wireCoinBoardSchema },
  { method: "GET", path: "/discover/search", status: 200, auth: "public", response: wireTraderSearchSchema },
  { method: "GET", path: "/admin/kols", status: 200, auth: "kols.manage", response: z.array(wireKolSchema) },
  { method: "POST", path: "/admin/kols", status: 201, auth: "kols.manage", response: wireKolSchema },
  { method: "POST", path: "/admin/kols/import", status: 201, auth: "kols.manage", response: s.kolImportResponseSchema },
  { method: "PATCH", path: "/admin/kols/:address", status: 200, auth: "kols.manage", response: wireKolSchema },
  { method: "DELETE", path: "/admin/kols/:address", status: 204, auth: "kols.manage", response: z.undefined() },
  { method: "GET", path: "/discover/cards", status: 200, auth: "public", response: wireTraderCardsSchema },
  { method: "GET", path: "/me/favorite-groups", status: 200, auth: "user", response: z.array(wireFavoriteGroupSchema) },
  { method: "POST", path: "/me/favorite-groups", status: 201, auth: "user", response: wireFavoriteGroupSchema },
  { method: "PATCH", path: "/me/favorite-groups/:id", status: 200, auth: "user", response: wireFavoriteGroupSchema },
  { method: "DELETE", path: "/me/favorite-groups/:id", status: 204, auth: "user", response: z.undefined() },
  { method: "PUT", path: "/me/favorite-groups/:id/members/:address", status: 200, auth: "user", response: wireFavoriteGroupSchema },
  { method: "DELETE", path: "/me/favorite-groups/:id/members/:address", status: 204, auth: "user", response: z.undefined() },
  { method: "GET", path: "/me/copy", status: 200, auth: "user", response: wireCopyOverviewSchema },
  { method: "POST", path: "/me/copy/strategies", status: 201, auth: "user; 409 already_copying / insufficient_balance / copy_paused", response: wireCopyStrategySchema },
  { method: "PATCH", path: "/me/copy/strategies/:id", status: 200, auth: "user (owner)", response: wireCopyStrategySchema },
  { method: "POST", path: "/me/copy/strategies/:id/funds", status: 200, auth: "user (owner)", response: wireCopyStrategySchema },
  { method: "POST", path: "/me/copy/strategies/:id/commands", status: 200, auth: "user (owner)", response: wireCopyStrategySchema },
  { method: "GET", path: "/me/copy/strategies/:id/orders", status: 200, auth: "user (owner)", response: wireCopyOrdersSchema },
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
export type WireTraderSearch = z.infer<typeof wireTraderSearchSchema>;
export type WireCopyScore = z.infer<typeof wireCopyScoreSchema>;
export type WireTraderCard = z.infer<typeof wireTraderCardSchema>;
export type WireTraderCards = z.infer<typeof wireTraderCardsSchema>;
export type WireFavoriteGroup = z.infer<typeof wireFavoriteGroupSchema>;
export type WireCohortDetail = z.infer<typeof wireCohortDetailSchema>;
export type WireCohortHistory = z.infer<typeof wireCohortHistorySchema>;
export type WireWallet = z.infer<typeof wireWalletSchema>;
export type WireWalletHistory = z.infer<typeof wireWalletHistorySchema>;
export type WireCopyOverview = z.infer<typeof wireCopyOverviewSchema>;
export type WireCopyStrategy = z.infer<typeof wireCopyStrategySchema>;
export type WireCopyOrder = z.infer<typeof wireCopyOrderSchema>;
export type WireCopyOrders = z.infer<typeof wireCopyOrdersSchema>;
export type WireAdminCopyOverview = z.infer<typeof wireAdminCopyOverviewSchema>;
export type WireAdminCopyStrategies = z.infer<typeof wireAdminCopyStrategiesSchema>;
export type WireAdminCopyStrategyDetail = z.infer<typeof wireAdminCopyStrategyDetailSchema>;
export type WireAdminCopyOrders = z.infer<typeof wireAdminCopyOrdersSchema>;
export type WireAdminCopyExposure = z.infer<typeof wireAdminCopyExposureSchema>;
export type WireAdminCopyRisk = z.infer<typeof wireAdminCopyRiskSchema>;
export type WireAdminCopyControl = z.infer<typeof wireAdminCopyControlSchema>;
