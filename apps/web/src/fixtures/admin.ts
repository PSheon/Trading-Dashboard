/**
 * Fixtures for the site settings, crowd view and admin endpoints. Seeded
 * and synthetic (there's no real sample for these), shaped by the zod
 * contracts in packages/shared.
 */
import {
  adminSettingsSchema,
  type AdminSettingsSnapshot,
  type AdminOverview,
  type AdminRevenueResponse,
  type AdminSettings,
  type AdminUser,
  type CrowdResponse,
  type PublicSettings,
} from "@trading-dashboard/shared/contracts";

import { TIME_ZONE } from "@/i18n/config";
import { LOW_SAMPLE_THRESHOLD, profileFor, traderStats } from "./data";

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.now();
const DAY = 86400_000;

// --- settings ------------------------------------------------------------------

/** Starts from the schema defaults, then the values a demo admin would set. */
export let adminSettings: AdminSettings = adminSettingsSchema.parse({
  general: {
    // The demo admin has opened copying (off by default; see the copy panel).
    copyTradingEnabled: true,
    announcement: {
      enabled: true,
      text: {
        "zh-TW": "Orbie 公開測試中：跟單下單功能即將推出，現在就能收藏交易員並接收即時警報。",
        en: "Orbie is in open beta: copy trading is coming soon. Star traders now to get live alerts.",
      },
    },
  },
  discovery: {
    featuredAddresses: [5, 7, 0, 10, 11, 4, 16, 8].map((i) => traderStats[i].address),
    homeMarkets: ["BTC", "ETH", "SOL", "HYPE", "xyz:TSLA", "xyz:NVDA", "xyz:GOLD", "DOGE"],
    lowSampleThreshold: LOW_SAMPLE_THRESHOLD,
  },
  notifications: {},
  revenue: {
    builderAddress: "0x7a3c9e5f1b2d4a6c8e0f1a2b3c4d5e6f7a8b9c0d",
    builderFeeTenthsBps: 25,
    referralCode: "ORBIE",
  },
});

const revisions = { general: 0, discovery: 0, notifications: 0, revenue: 0 };
export function adminSettingsSnapshot(): AdminSettingsSnapshot {
  return { ...adminSettings, invalidSections: [], revisions: Object.fromEntries(
    Object.entries(revisions).map(([key, value]) => [key, value.toString(16).padStart(64, "0")]),
  ) as AdminSettingsSnapshot["revisions"] };
}
export function setAdminSettings(next: AdminSettings, sections: (keyof AdminSettings)[]) {
  for (const section of sections) revisions[section]++;
  adminSettings = next;
}

export function publicSettings(): PublicSettings {
  const { general, discovery, notifications, revenue } = adminSettings;
  return {
    announcement: general.announcement,
    signupsOpen: general.signupsOpen,
    copyTradingEnabled: general.copyTradingEnabled,
    maintenance: general.maintenance,
    featuredAddresses: discovery.featuredAddresses,
    homeMarkets: discovery.homeMarkets,
    hideVaults: discovery.hideVaults,
    lowSampleThreshold: discovery.lowSampleThreshold,
    defaultActiveWithin: discovery.defaultActiveWithin,
    maxAlertTraders: notifications.maxAlertTraders,
    referralCode: revenue.referralCode,
  };
}

// --- crowd ------------------------------------------------------------------------

export function crowd(): CrowdResponse {
  const tracked = traderStats.slice(0, 60);
  const byCoin = new Map<
    string,
    { long: number; short: number; longTraders: number; shortTraders: number }
  >();
  for (const trader of tracked) {
    for (const p of profileFor(trader.address, false).positions) {
      const entry = byCoin.get(p.coin) ?? { long: 0, short: 0, longTraders: 0, shortTraders: 0 };
      if (p.side === "long") {
        entry.long += p.positionValue;
        entry.longTraders += 1;
      } else {
        entry.short += p.positionValue;
        entry.shortTraders += 1;
      }
      byCoin.set(p.coin, entry);
    }
  }
  const random = rng(42);
  const coins = [...byCoin.entries()]
    .map(([coin, e]) => {
      const net = e.long - e.short;
      const total = e.long + e.short;
      return {
        coin,
        longNotional: e.long,
        shortNotional: e.short,
        longTraders: e.longTraders,
        shortTraders: e.shortTraders,
        netBias: total > 0 ? net / total : 0,
        netNotional24hAgo: random() < 0.1 ? null : net - total * (random() - 0.45) * 0.35,
      };
    })
    .sort((a, b) => b.longNotional + b.shortNotional - (a.longNotional + a.shortNotional));
  return { trackedTraders: tracked.length, coins, updatedAt: new Date(NOW - 3 * 60_000) };
}

// --- users ------------------------------------------------------------------------

const NAMES = [
  "Demo", "whalewatcher", "阿哲", "Mina", "0xLeo", "Kaito", "小安", "degen_sam", "Ruby", "Tsai",
  null, "Hank", "Yuki", null, "PerpPanda", "林董", "Ivy", "orbitfan", null, "Chen",
  "Nora", "Jules", null, "麥可", "Otto", "Pia", "Quinn", null, "Sora", "Tao",
  "Uma", "Vic", "Wen", null, "Yara", "Zed", "Abe",
];

export let adminUsers: AdminUser[] = NAMES.map((name, i) => {
  const random = rng(1000 + i);
  const created = NOW - (i === 0 ? 40 : Math.floor(random() * 60)) * DAY - Math.floor(random() * DAY);
  const wallet = random() < 0.55;
  return {
    id: i + 1,
    email: i === 0 ? "demo@example.com" : wallet ? null : `user${i + 1}@example.com`,
    walletAddress: wallet || i === 0
      ? `0x${Math.floor(random() * 2 ** 52).toString(16).padStart(13, "0")}${"0".repeat(27)}`
      : null,
    displayName: name,
    role: i === 0 || i === 3 ? "admin" : i === 5 ? "operator" : "user",
    locale: random() < 0.75 ? "zh-TW" : "en",
    favorites: Math.floor(random() ** 2 * 18),
    telegramEnabled: random() < 0.45,
    disabled: i === 12 || i === 29,
    createdAt: new Date(created),
    lastLoginAt: new Date(Math.min(NOW - 60_000, created + random() * (NOW - created))),
  };
});

export function setAdminUsers(next: AdminUser[]) {
  adminUsers = next;
}

// --- revenue ----------------------------------------------------------------------

const dayKey = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

/** 60 days of small, slowly growing daily amounts. */
const revenueDays = Array.from({ length: 60 }, (_, i) => {
  const random = rng(500 + i);
  const age = 59 - i;
  const growth = 1 + i / 30;
  return {
    day: dayKey(NOW - age * DAY),
    builder: Math.round((i < 18 ? 0 : random() * 26 * growth) * 100) / 100,
    referral: Math.round((6 + random() * 48 * growth) * 100) / 100,
  };
});

export function revenue(range: "7d" | "30d" | "90d" | "all"): AdminRevenueResponse {
  const { builderAddress, builderFeeTenthsBps, referralCode } = adminSettings.revenue;
  const n = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : revenueDays.length;
  const daily = builderAddress ? revenueDays.slice(-n) : [];
  const builderTotal = revenueDays.reduce((s, d) => s + d.builder, 0);
  const referralTotal = revenueDays.reduce((s, d) => s + d.referral, 0);
  const claimed = Math.round(referralTotal * 0.62 * 100) / 100;
  return {
    address: builderAddress,
    builderFeeTenthsBps,
    referralCode,
    totals: builderAddress
      ? {
          builderUsd: builderTotal,
          referralUsd: referralTotal,
          claimedUsd: claimed,
          unclaimedUsd: builderTotal + referralTotal - claimed,
          referredUsers: 143,
          referredVolumeUsd: 18_420_000,
        }
      : { builderUsd: 0, referralUsd: 0, claimedUsd: 0, unclaimedUsd: 0, referredUsers: 0, referredVolumeUsd: 0 },
    rangeUsd: {
      builder: daily.reduce((s, d) => s + d.builder, 0),
      referral: daily.reduce((s, d) => s + d.referral, 0),
    },
    daily,
    lastSnapshotAt: builderAddress ? new Date(NOW - 17 * 60_000) : null,
  };
}

// --- overview ---------------------------------------------------------------------

export function overview(favoritedTraders: number): AdminOverview {
  const last30 = revenueDays.slice(-30);
  return {
    users: {
      total: adminUsers.length,
      new7d: adminUsers.filter((u) => new Date(u.createdAt).getTime() > NOW - 7 * DAY).length,
      active7d: adminUsers.filter((u) => new Date(u.lastLoginAt).getTime() > NOW - 7 * DAY).length,
    },
    trackedTraders: { total: 100 + favoritedTraders, imported: 100, favorited: favoritedTraders },
    alerts24h: { sent: 0, failed: 1, dryRun: 57 },
    revenue30dUsd: adminSettings.revenue.builderAddress
      ? last30.reduce((s, d) => s + d.builder + d.referral, 0)
      : 0,
    generatedAt: new Date(),
  };
}

/** Synthetic monitoring; never represents a live service probe. */
export function systemOverview() {
  const now = new Date().toISOString();
  const budget = { requestsLastMinute: 12, weightLastMinute: 180, effectiveBudgetPerMin: 240,
    configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 60, lastRateLimitedAt: null, queued: { live: 0, background: 2 } };
  const switches = { copyTradingMode: "paper", hyperliquidNetwork: "testnet", telegramDryRun: true, archiveEnabled: true, archiveMaxDailyUsd: 2, maxFavoritesPerUserDefault: 100 };
  return { sampledAt: now, api: { state: "active", role: "api", uptimeSeconds: 7200, budget, switches: { ...switches, appRole: "api", archiveEnabled: false } },
    worker: { state: "standby", sample: { state: "standby", instanceId: "fixture-worker", sampledAt: now, uptimeSeconds: 15, budget: null, heartbeat: null, switches: { ...switches, appRole: "worker" } } },
    database: { state: "available", latencyMs: 7 },
    data: { leaderboardCount: 25000, leaderboardUpdatedAt: now, watched: 12, candidates: 1000, portfolios: 824, trades: 618, errors: 3,
      oldestPortfolioAt: new Date(Date.now() - 7200_000).toISOString(), newestPortfolioAt: now },
    outbox: ["evaluations", "deliveries"].map(kind => ({ kind, pending: 2, processing: 1, failed: 0, due: 1, expiredLeases: 0, oldestDueAt: now })) };
}
