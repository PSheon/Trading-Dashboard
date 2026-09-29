/**
 * In-browser stand-in for apps/api, used only when the build sets
 * NEXT_PUBLIC_API_FIXTURES=1 (see lib/api.ts). It answers the Stage 2
 * endpoints (/traders*, /me*) and, so every page can be exercised without a
 * running api, the existing ones the UI calls (/actions, /alerts, /health,
 * /lists, /import/lists).
 *
 * Every response is parsed with the shared zod contract before it is
 * returned — a fixture that drifts from packages/shared fails loudly — and
 * then JSON round-tripped so the UI sees exactly what it would get over the
 * wire (dates as ISO strings).
 */
import {
  adminOverviewSchema,
  adminRevenueQuerySchema,
  adminRevenueResponseSchema,
  adminSettingsSchema,
  adminUsersQuerySchema,
  adminUsersResponseSchema,
  adminUserSchema,
  crowdResponseSchema,
  patchAdminSettingsRequestSchema,
  patchAdminUserRequestSchema,
  publicSettingsSchema,
  actionFeedItemSchema,
  actionsFeedQuerySchema,
  addressSchema,
  alertRuleSchema,
  alertSchema,
  favoriteSchema,
  fillSchema,
  heartbeatResponseSchema,
  importLeaderListRequestSchema,
  importLeaderListResponseSchema,
  leaderListSchema,
  meResponseSchema,
  notificationChannelSchema,
  patchMeRequestSchema,
  portfolioQuerySchema,
  portfolioResponseSchema,
  putTelegramChannelRequestSchema,
  sparklinesQuerySchema,
  sparklinesResponseSchema,
  traderFillSchema,
  traderProfileResponseSchema,
  tradersQuerySchema,
  tradersResponseSchema,
  upsertAlertRuleRequestSchema,
  type AlertRule,
  type LocaleInput,
  type NotificationChannel,
} from "@trading-dashboard/shared";
import { z, type ZodTypeAny } from "zod";

import { ApiError } from "@/lib/api";
import {
  actionFills,
  actionsFeed,
  alertRules,
  alertsFor,
  findStats,
  fixtureMe,
  health,
  initialFavorites,
  leaderboardUpdatedAt,
  leaderLists,
  portfolioFor,
  profileFor,
  sparklineFor,
  traderFills,
  traderStats,
} from "./data";
import {
  adminSettings,
  adminUsers,
  crowd,
  overview,
  publicSettings,
  revenue,
  setAdminSettings,
  setAdminUsers,
} from "./admin";

// Mutable demo state (per browser tab).
const NO_ALERT = { enabled: false, sides: "both", minUsd: null } as const;

const favorites = new Map<string, Date>(
  initialFavorites.map((a, i) => [a, new Date(Date.now() - (i + 1) * 86400_000)]),
);
let channels: NotificationChannel[] = [];
let rules: AlertRule[] = alertRules.map((r) => ({ ...r }));
let defaultRules: AlertRule[] = alertRules.map((r) => ({ ...r, userId: null }));
// The demo account's saved locale starts as whatever the UI is showing, so
// adopting it at sign-in doesn't flip the language.
let meLocale: LocaleInput =
  typeof document !== "undefined" && /(?:^|; )locale=en(?:;|$)/.test(document.cookie) ? "en" : "zh-TW";
let nextListId = 4;

function wire<T>(schema: ZodTypeAny, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    console.error("[fixtures] response does not match the contract", result.error.issues);
    throw new ApiError(500, `fixture contract mismatch: ${result.error.message}`);
  }
  return JSON.parse(JSON.stringify(result.data)) as T;
}

function query(schema: ZodTypeAny, search: URLSearchParams) {
  const result = schema.safeParse(Object.fromEntries(search.entries()));
  if (!result.success) throw new ApiError(400, result.error.message);
  return result.data;
}

function requireUser(token: string | null) {
  if (!token) throw new ApiError(401, "Login required");
}

/** The fixture user is an admin (id 1). */
function requireAdmin(token: string | null) {
  requireUser(token);
}

function upsertRule(list: AlertRule[], body: unknown, userId: number | null) {
  const req = upsertAlertRuleRequestSchema.parse(body);
  const existing = list.find((r) => r.id === req.id);
  const saved: AlertRule = {
    ...req,
    id: existing?.id ?? Math.max(0, ...list.map((r) => r.id)) + 1,
    userId,
    quietHours: req.quietHours ?? null,
  };
  const next = existing ? list.map((r) => (r.id === saved.id ? saved : r)) : [...list, saved];
  return { saved, next };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fixtureRequest<T>(
  method: string,
  path: string,
  body: unknown,
  token: string | null,
): Promise<T> {
  await delay(60 + Math.random() * 120);
  const url = new URL(path, "http://fixtures.invalid");
  const parts = url.pathname.split("/").filter(Boolean);
  const search = url.searchParams;
  const signedIn = token !== null;
  const route = `${method} /${parts.map((p, i) => (i > 0 && /^0x/i.test(p) ? ":address" : /^\d+$/.test(p) ? ":id" : p)).join("/")}`;

  switch (route) {
    // --- discovery -----------------------------------------------------------
    case "GET /traders": {
      const q = query(tradersQuerySchema, search) as z.infer<typeof tradersQuerySchema>;
      const needle = q.q?.toLowerCase();
      const hideVaults = q.hideVaults ?? adminSettings.discovery.hideVaults;
      const active = q.active ?? adminSettings.discovery.defaultActiveWithin;
      let rows = traderStats.filter(
        (s) =>
          (!hideVaults || !s.isVault) &&
          (active === "any" || s.volume[active] > 0) &&
          (!needle ||
            s.address.startsWith(needle) ||
            (s.displayName ?? "").toLowerCase().includes(needle)) &&
          (q.minAccountValue === undefined || s.accountValue >= q.minAccountValue),
      );
      const value = (s: (typeof rows)[number]) =>
        q.sort === "accountValue" ? s.accountValue : s[q.sort][q.window];
      rows = [...rows].sort((a, b) => (q.order === "desc" ? value(b) - value(a) : value(a) - value(b)));
      return wire(tradersResponseSchema, {
        total: rows.length,
        updatedAt: leaderboardUpdatedAt,
        items: rows
          .slice(q.offset, q.offset + q.limit)
          .map((s) => ({ ...s, favorite: signedIn && favorites.has(s.address) })),
      });
    }
    case "GET /traders/sparklines": {
      const q = query(sparklinesQuerySchema, search) as z.infer<typeof sparklinesQuerySchema>;
      return wire(
        sparklinesResponseSchema,
        Object.fromEntries(q.addresses.map((a: string) => [a, sparklineFor(a, q.window)])),
      );
    }
    case "GET /traders/:address": {
      const address = addressSchema.parse(parts[1]).toLowerCase();
      const profile = profileFor(address, signedIn && favorites.has(address));
      const threshold = adminSettings.discovery.lowSampleThreshold;
      profile.sample.lowSample = profile.sample.fills30d < threshold;
      return wire(traderProfileResponseSchema, profile);
    }
    case "GET /traders/:address/portfolio": {
      const address = addressSchema.parse(parts[1]).toLowerCase();
      const q = query(portfolioQuerySchema, search) as z.infer<typeof portfolioQuerySchema>;
      return wire(portfolioResponseSchema, {
        window: q.window,
        market: q.market,
        ...portfolioFor(address, q.window, q.market),
      });
    }
    case "GET /traders/:address/fills": {
      const limit = Math.min(500, Number(search.get("limit") ?? 100) || 100);
      return wire(z.array(traderFillSchema), traderFills(limit));
    }

    // --- signed-in user --------------------------------------------------------
    case "GET /me":
      requireUser(token);
      return wire(meResponseSchema, fixtureMe(meLocale));
    case "PATCH /me": {
      requireUser(token);
      const patch = patchMeRequestSchema.parse(body);
      if (patch.locale) meLocale = patch.locale;
      return wire(meResponseSchema, fixtureMe(meLocale));
    }
    case "GET /me/favorites":
      requireUser(token);
      return wire(
        z.array(favoriteSchema),
        [...favorites.entries()]
          .sort((a, b) => b[1].getTime() - a[1].getTime())
          .map(([address, createdAt]) => ({ address, createdAt, stats: findStats(address), alert: NO_ALERT })),
      );
    case "PUT /me/favorites/:address": {
      requireUser(token);
      const address = addressSchema.parse(parts[2]).toLowerCase();
      if (!favorites.has(address)) favorites.set(address, new Date());
      return wire(favoriteSchema, {
        address,
        createdAt: favorites.get(address),
        stats: findStats(address),
        alert: NO_ALERT,
      });
    }
    case "DELETE /me/favorites/:address": {
      requireUser(token);
      favorites.delete(addressSchema.parse(parts[2]).toLowerCase());
      return undefined as T;
    }
    case "GET /me/notification-channels":
      requireUser(token);
      return wire(z.array(notificationChannelSchema), channels);
    case "PUT /me/notification-channels/telegram": {
      requireUser(token);
      const req = putTelegramChannelRequestSchema.parse(body);
      const channel: NotificationChannel = { kind: "telegram", target: req.target, enabled: req.enabled };
      channels = [channel];
      return wire(notificationChannelSchema, channel);
    }
    case "GET /me/alert-rules":
      requireUser(token);
      return wire(z.array(alertRuleSchema), rules);
    case "PATCH /me/alert-rules/:id": {
      // The api merges a partial {paramsJson, cooldownS, quietHours, tiers,
      // enabled} into the user's own copy of a rule.
      requireUser(token);
      const current = rules.find((r) => r.id === Number(parts[2]));
      if (!current) throw new ApiError(404, "Rule not found");
      const patch = upsertAlertRuleRequestSchema
        .pick({ paramsJson: true, cooldownS: true, quietHours: true, tiers: true, enabled: true })
        .partial()
        .parse(body);
      const saved: AlertRule = { ...current, ...patch, quietHours: patch.quietHours ?? current.quietHours };
      rules = rules.map((r) => (r.id === saved.id ? saved : r));
      return wire(alertRuleSchema, saved);
    }

    // --- public settings + crowd -----------------------------------------------
    case "GET /settings":
      return wire(publicSettingsSchema, publicSettings());
    case "GET /insights/crowd":
      return wire(crowdResponseSchema, crowd());

    // --- admin ---------------------------------------------------------------------
    case "GET /admin/overview":
      requireAdmin(token);
      return wire(adminOverviewSchema, overview(favorites.size));
    case "GET /admin/revenue": {
      requireAdmin(token);
      const q = query(adminRevenueQuerySchema, search) as z.infer<typeof adminRevenueQuerySchema>;
      return wire(adminRevenueResponseSchema, revenue(q.range));
    }
    case "GET /admin/users": {
      requireAdmin(token);
      const q = query(adminUsersQuerySchema, search) as z.infer<typeof adminUsersQuerySchema>;
      const needle = q.q?.toLowerCase();
      const rows = adminUsers.filter(
        (u) =>
          (!q.role || u.role === q.role) &&
          (!needle ||
            [u.email, u.walletAddress, u.displayName].some((v) => v?.toLowerCase().includes(needle))),
      );
      return wire(adminUsersResponseSchema, {
        total: rows.length,
        items: rows.slice(q.offset, q.offset + q.limit),
      });
    }
    case "PATCH /admin/users/:id": {
      requireAdmin(token);
      const id = Number(parts[2]);
      const patch = patchAdminUserRequestSchema.parse(body);
      if (id === 1) throw new ApiError(400, "You can't change your own role or status");
      const user = adminUsers.find((u) => u.id === id);
      if (!user) throw new ApiError(404, "User not found");
      const updated = {
        ...user,
        ...(patch.role ? { role: patch.role } : {}),
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
      };
      setAdminUsers(adminUsers.map((u) => (u.id === id ? updated : u)));
      return wire(adminUserSchema, updated);
    }
    case "GET /admin/settings":
      requireAdmin(token);
      return wire(adminSettingsSchema, adminSettings);
    case "PATCH /admin/settings": {
      requireAdmin(token);
      const parsed = patchAdminSettingsRequestSchema.safeParse(body);
      if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const patch = parsed.data;
      const merged = adminSettingsSchema.safeParse({
        general: { ...adminSettings.general, ...patch.general },
        discovery: { ...adminSettings.discovery, ...patch.discovery },
        notifications: { ...adminSettings.notifications, ...patch.notifications },
        revenue: { ...adminSettings.revenue, ...patch.revenue },
      });
      if (!merged.success) throw new ApiError(400, merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      setAdminSettings(merged.data);
      return wire(adminSettingsSchema, merged.data);
    }
    case "GET /alert-rules":
      requireAdmin(token);
      return wire(z.array(alertRuleSchema), defaultRules);
    case "POST /alert-rules": {
      requireAdmin(token);
      const { saved, next } = upsertRule(defaultRules, body, null);
      defaultRules = next;
      return wire(alertRuleSchema, saved);
    }

    // --- existing endpoints ------------------------------------------------------
    case "GET /actions": {
      const q = query(actionsFeedQuerySchema, search) as z.infer<typeof actionsFeedQuerySchema>;
      if (q.scope === "favorites") requireUser(token);
      const coin = q.coin?.toUpperCase();
      const rows = actionsFeed().filter(
        (a) =>
          (q.scope !== "favorites" || favorites.has(a.address)) &&
          (!q.address || a.address === q.address.toLowerCase()) &&
          (!coin || a.coin.toUpperCase() === coin || a.coin.toUpperCase().endsWith(`:${coin}`)) &&
          (!q.kind || a.kind === q.kind) &&
          (!q.tier || a.leaderTier === q.tier),
      );
      return wire(z.array(actionFeedItemSchema), rows.slice(0, q.limit));
    }
    case "GET /actions/:id/fills":
      return wire(z.array(fillSchema), actionFills(parts[1]));
    case "GET /alerts":
      requireUser(token);
      return wire(z.array(alertSchema), alertsFor(search.get("address") ?? undefined));
    case "GET /health":
      return wire(heartbeatResponseSchema, health());
    case "GET /lists":
      requireUser(token);
      return wire(z.array(leaderListSchema), leaderLists);
    case "POST /import/lists": {
      requireUser(token);
      const req = importLeaderListRequestSchema.parse(body);
      const listId = nextListId++;
      leaderLists.unshift({ id: listId, source: req.source, importedAt: new Date(), fileName: req.fileName });
      return wire(importLeaderListResponseSchema, {
        listId,
        itemCount: req.rows.length,
        newAddresses: [],
      });
    }
  }

  throw new ApiError(404, `No fixture for ${method} ${url.pathname}`);
}
