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
export const wireTraderTradesSchema = s.traderTradesResponseSchema.extend({ items: z.array(wireRoundTripSchema), coverage: wireTradeCoverageSchema, computedAt: iso });
export const wireAdminUserSchema = s.adminUserSchema.extend({ createdAt: iso, lastLoginAt: iso });
export const wireMeSchema = s.meResponseSchema.extend({ createdAt: iso });
export const wireFavoriteSchema = s.favoriteSchema.extend({ createdAt: iso, stats: wireTraderStatsSchema.nullable() });
export const wireHeartbeatSchema = s.heartbeatResponseSchema.extend({
  feedDisconnectedSince: iso.nullable(), lastTradeAt: iso.nullable(), lastFillAt: iso.nullable(), lastSnapshotAt: iso.nullable(),
  lastSnapshotAttemptAt: iso.nullable().optional(), lastSnapshotFailureAt: iso.nullable().optional(), lastSweepAt: iso.nullable(), now: iso,
  fillsUnavailable: z.array(z.object({ address: z.string(), missedTrades: z.number().int(), since: iso })),
});
const outboxCounts = z.array(z.object({ status: z.string(), count: z.number().int().nonnegative() }));
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
}
/** One registry drives server output validation, browser validation and route docs. */
export const httpRouteContracts: HttpRouteContract[] = [
  { method: "GET", path: "/health", status: 200, auth: "public; raw", response: wireHeartbeatSchema },
  { method: "GET", path: "/health/ready", status: 200, auth: "public; raw", response: z.object({ ready: z.literal(true) }) },
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
  { method: "GET", path: "/traders", status: 200, auth: "public", response: wireTradersSchema },
  { method: "GET", path: "/traders/sparklines", status: 200, auth: "public", response: s.sparklinesResponseSchema },
  { method: "GET", path: "/traders/:address", status: 200, auth: "public", response: wireTraderProfileSchema },
  { method: "GET", path: "/traders/:address/portfolio", status: 200, auth: "public", response: s.portfolioResponseSchema },
  { method: "GET", path: "/traders/:address/activity", status: 200, auth: "public", response: wireTraderActivitySchema },
  { method: "GET", path: "/traders/:address/fills", status: 200, auth: "public", response: z.array(s.traderFillSchema.extend({ ts: iso })) },
  { method: "GET", path: "/traders/:address/analytics", status: 200, auth: "public; 503 busy while a cold address computes", response: wireTraderAnalyticsSchema },
  { method: "GET", path: "/traders/:address/trades", status: 200, auth: "public; 503 busy while a cold address computes", response: wireTraderTradesSchema },
  { method: "GET", path: "/me", status: 200, auth: "user", response: wireMeSchema },
  { method: "PATCH", path: "/me", status: 200, auth: "user", response: wireMeSchema },
  { method: "GET", path: "/me/favorites", status: 200, auth: "user", response: z.array(wireFavoriteSchema) },
  { method: "PUT", path: "/me/favorites/:address", status: 200, auth: "user", response: wireFavoriteSchema },
  { method: "DELETE", path: "/me/favorites/:address", status: 204, auth: "user", response: z.undefined() },
  { method: "PATCH", path: "/me/favorites/:address/alert", status: 200, auth: "user", response: wireFavoriteSchema },
  { method: "GET", path: "/me/telegram", status: 200, auth: "user", response: s.telegramStatusSchema.extend({ linkedAt: iso.nullable() }) },
  { method: "POST", path: "/me/telegram/link", status: 200, auth: "user", response: s.telegramLinkResponseSchema.extend({ expiresAt: iso }) },
  { method: "POST", path: "/me/telegram/test", status: 200, auth: "user", response: s.telegramTestResponseSchema },
  { method: "DELETE", path: "/me/telegram", status: 204, auth: "user", response: z.undefined() },
  { method: "GET", path: "/insights/crowd", status: 200, auth: "public", response: s.crowdResponseSchema.extend({ updatedAt: iso.nullable() }) },
  { method: "GET", path: "/settings", status: 200, auth: "public", response: s.publicSettingsSchema },
  { method: "GET", path: "/admin/settings", status: 200, auth: "settings.read", response: s.adminSettingsSnapshotSchema },
  { method: "PATCH", path: "/admin/settings", status: 200, auth: "settings.write", response: s.adminSettingsSnapshotSchema },
  { method: "GET", path: "/admin/users", status: 200, auth: "users.read", response: s.adminUsersResponseSchema.extend({ items: z.array(wireAdminUserSchema) }) },
  { method: "PATCH", path: "/admin/users/:id", status: 200, auth: "users.manage", response: wireAdminUserSchema },
  { method: "GET", path: "/admin/overview", status: 200, auth: "overview.read", response: s.adminOverviewSchema.extend({ generatedAt: iso }) },
  { method: "GET", path: "/admin/revenue", status: 200, auth: "revenue.read", response: s.adminRevenueResponseSchema.extend({ lastSnapshotAt: iso.nullable() }) },
  { method: "GET", path: "/admin/outbox", status: 200, auth: "admin.access", response: z.object({ evaluations: outboxCounts, deliveries: outboxCounts }) },
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
