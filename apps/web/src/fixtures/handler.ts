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
  patchFavoriteAlertRequestSchema,
  patchMeRequestSchema,
  portfolioQuerySchema,
  portfolioResponseSchema,
  sparklinesQuerySchema,
  sparklinesResponseSchema,
  telegramLinkResponseSchema,
  telegramStatusSchema,
  telegramTestResponseSchema,
  traderActivityResponseSchema,
  traderFillSchema,
  traderProfileResponseSchema,
  tradersQuerySchema,
  tradersResponseSchema,
  upsertAlertRuleRequestSchema,
  type AlertRule,
  type FavoriteAlert,
  type LocaleInput,
  type TelegramStatus,
} from "@trading-dashboard/shared";
import { z, type ZodTypeAny } from "zod";

import { ApiError } from "@/lib/api";
import {
  actionFills,
  actionsFeed,
  activityFor,
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
const NO_ALERT: FavoriteAlert = { enabled: false, sides: "both", minUsd: null };
const FIXTURE_BOT = "orbie_fun_bot";
/** Pretend the user presses Start this long after asking for a link. */
const FIXTURE_LINK_DELAY_MS = 6_000;

/** Two starting favorites already alert (buy ≥ $250K, both sides). */
const favorites = new Map<string, { createdAt: Date; alert: FavoriteAlert }>(
  initialFavorites.map((a, i) => [
    a,
    {
      createdAt: new Date(Date.now() - (i + 1) * 86400_000),
      alert:
        i === 0
          ? { enabled: true, sides: "buy", minUsd: 250_000 }
          : i === 1
            ? { enabled: true, sides: "both", minUsd: null }
            : NO_ALERT,
    },
  ]),
);

// `?tg=linked` in the page URL starts with a linked chat (screenshots and
// quick checks); otherwise the demo account starts unlinked.
const startLinked =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tg") === "linked";
let telegram: Omit<TelegramStatus, "bot"> = startLinked
  ? { linked: true, username: "orbie_demo", enabled: true, linkedAt: new Date(Date.now() - 3 * 86400_000) }
  : { linked: false, username: null, enabled: false, linkedAt: null };
/** Set by POST /me/telegram/link: when the fixture "presses Start". */
let pendingLinkAt: number | null = null;

function telegramStatus(): TelegramStatus {
  if (pendingLinkAt !== null && Date.now() >= pendingLinkAt) {
    telegram = { linked: true, username: "orbie_demo", enabled: true, linkedAt: new Date() };
    pendingLinkAt = null;
  }
  return { bot: FIXTURE_BOT, ...telegram };
}

function favoriteOf(address: string) {
  const entry = favorites.get(address);
  return entry ? { address, createdAt: entry.createdAt, stats: findStats(address), alert: entry.alert } : null;
}

let defaultRules: AlertRule[] = alertRules.map((r) => ({ ...r }));
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
      return wire(traderProfileResponseSchema, profileFor(address, signedIn && favorites.has(address)));
    }
    case "GET /traders/:address/activity": {
      const address = addressSchema.parse(parts[1]).toLowerCase();
      return wire(
        traderActivityResponseSchema,
        activityFor(address, signedIn && favorites.has(address), adminSettings.discovery.lowSampleThreshold),
      );
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
          .sort((a, b) => b[1].createdAt.getTime() - a[1].createdAt.getTime())
          .map(([address]) => favoriteOf(address)),
      );
    case "PUT /me/favorites/:address": {
      requireUser(token);
      const address = addressSchema.parse(parts[2]).toLowerCase();
      if (!favorites.has(address)) favorites.set(address, { createdAt: new Date(), alert: NO_ALERT });
      return wire(favoriteSchema, favoriteOf(address));
    }
    case "PATCH /me/favorites/:address/alert": {
      // Same rules as the api: 404 unless a favorite; switching on needs a
      // linked, enabled chat and room under maxAlertTraders.
      requireUser(token);
      const address = addressSchema.parse(parts[2]).toLowerCase();
      const entry = favorites.get(address);
      if (!entry) throw new ApiError(404, `${address} is not a favorite`);
      const parsed = patchFavoriteAlertRequestSchema.safeParse(body ?? {});
      if (!parsed.success) throw new ApiError(400, parsed.error.message);
      const patch = parsed.data;
      if (patch.enabled === true && !entry.alert.enabled) {
        if (!telegramStatus().linked || !telegram.enabled) {
          throw new ApiError(409, "Link Telegram before turning on alerts", { code: "telegram_not_linked" });
        }
        const limit = adminSettings.notifications.maxAlertTraders;
        const on = [...favorites.values()].filter((f) => f.alert.enabled).length;
        if (on >= limit) {
          throw new ApiError(409, `Alerts are limited to ${limit} traders`, { code: "alert_limit", limit });
        }
      }
      entry.alert = {
        enabled: patch.enabled ?? entry.alert.enabled,
        sides: patch.sides ?? entry.alert.sides,
        minUsd: patch.minUsd === undefined ? entry.alert.minUsd : patch.minUsd,
      };
      return wire(favoriteSchema, favoriteOf(address));
    }
    case "DELETE /me/favorites/:address": {
      requireUser(token);
      favorites.delete(addressSchema.parse(parts[2]).toLowerCase());
      return undefined as T;
    }
    case "GET /me/telegram":
      requireUser(token);
      return wire(telegramStatusSchema, telegramStatus());
    case "POST /me/telegram/link": {
      requireUser(token);
      const tokenPart = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
      pendingLinkAt = Date.now() + FIXTURE_LINK_DELAY_MS;
      return wire(telegramLinkResponseSchema, {
        url: `https://t.me/${FIXTURE_BOT}?start=${tokenPart}`,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
    }
    case "DELETE /me/telegram":
      requireUser(token);
      telegram = { linked: false, username: null, enabled: false, linkedAt: null };
      pendingLinkAt = null;
      return undefined as T;
    case "POST /me/telegram/test":
      requireUser(token);
      if (!telegramStatus().linked || !telegram.enabled) {
        throw new ApiError(409, "No Telegram chat is linked", { code: "telegram_not_linked" });
      }
      // The fixture health reports dry run on.
      return wire(telegramTestResponseSchema, { sent: false, dryRun: true });

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
