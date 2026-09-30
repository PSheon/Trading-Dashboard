import { ROLE_PERMISSIONS } from "@trading-dashboard/shared/contracts";
/**
 * Fixture data for NEXT_PUBLIC_API_FIXTURES=1, built from real Hyperliquid
 * samples:
 * - leaderboard-top200.json  — the official leaderboard (stats-data), top 200
 * - portfolio-sample.json    — `portfolio` for one account
 * - clearinghouse-sample.json — `clearinghouseState` on the xyz dex
 * - fills-sample.json        — `userFills`
 *
 * The leaderboard rows are used as-is. Everything per-trader (PnL series,
 * positions, analytics, the action feed) is derived from the single-account
 * samples with a seeded generator, so each trader looks different but the
 * output is stable across reloads. Timestamps are shifted to end "now".
 */
import type {
  ActionFeedItem,
  AlertEntry,
  AlertRule,
  Fill,
  HeartbeatResponse,
  LeaderList,
  LivePosition,
  MeResponse,
  TraderActivityResponse,
  TraderFill,
  TraderProfileResponse,
  TraderStats,
  TraderWindow,
} from "@trading-dashboard/shared/contracts";

import clearinghouse from "./clearinghouse-sample.json";
import fillsSample from "./fills-sample.json";
import leaderboard from "./leaderboard-top200.json";
import portfolioSample from "./portfolio-sample.json";

// --- seeded randomness -------------------------------------------------------

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: string) {
  let a = hashString(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- time ---------------------------------------------------------------------

const NOW = Date.now();
const SAMPLE_END = Math.max(
  ...portfolioSample.flatMap(([, v]) => (v as PortfolioWindow).pnlHistory.map(([t]) => t)),
);
const SHIFT = NOW - SAMPLE_END;

// --- leaderboard → trader_stats --------------------------------------------------

const WINDOWS: TraderWindow[] = ["day", "week", "month", "allTime"];

type WindowPerf = { pnl: string; roi: string; vlm: string };

export const leaderboardUpdatedAt = new Date(NOW - 6 * 60_000);

/** Fixture vaults: the billion-dollar "accounts" at the top of the sample
 * behave like vaults (TVL), plus a few seeded ones further down. */
const FIXTURE_VAULT_RANKS = new Set([1, 2, 3, 21, 38, 64, 97]);

export const traderStats: TraderStats[] = leaderboard.leaderboardRows.map((row, i) => {
  const perf = Object.fromEntries(row.windowPerformances as [string, WindowPerf][]);
  const pick = (field: keyof WindowPerf) =>
    Object.fromEntries(WINDOWS.map((w) => [w, Number(perf[w]?.[field] ?? 0)])) as Record<
      TraderWindow,
      number
    >;
  return {
    address: row.ethAddress.toLowerCase(),
    displayName: row.displayName,
    accountValue: Number(row.accountValue),
    pnl: pick("pnl"),
    roi: pick("roi"),
    volume: pick("vlm"),
    isVault: FIXTURE_VAULT_RANKS.has(i),
    activity: activityOf(pick("vlm")),
    updatedAt: leaderboardUpdatedAt,
  };
});

/** Same rule as the api: the shortest window with volume. */
function activityOf(volume: Record<TraderWindow, number>): TraderStats["activity"] {
  if (volume.day > 0) return "day";
  if (volume.week > 0) return "week";
  if (volume.month > 0) return "month";
  return "inactive";
}

const statsByAddress = new Map(traderStats.map((s) => [s.address, s]));

export function findStats(address: string): TraderStats | null {
  return statsByAddress.get(address.toLowerCase()) ?? null;
}

export function rankOf(address: string): number {
  return traderStats.findIndex((s) => s.address === address.toLowerCase());
}

// --- portfolio -------------------------------------------------------------------

type PortfolioWindow = {
  accountValueHistory: [number, string][];
  pnlHistory: [number, string][];
  vlm: string;
};

const portfolioByKey = new Map(
  portfolioSample.map(([key, value]) => [key as string, value as PortfolioWindow]),
);

function sampleWindow(window: TraderWindow, market: "all" | "perp"): PortfolioWindow {
  const key =
    market === "all" ? window : `perp${window.charAt(0).toUpperCase()}${window.slice(1)}`;
  return portfolioByKey.get(key)!;
}

/** A PnL series shaped like the sample but seeded per trader and scaled so
 * it ends at `target`. */
function shapedSeries(
  seed: string,
  base: [number, number][],
  target: number | null,
): [number, number][] {
  if (base.length === 0) return [];
  const random = rng(seed);
  const n = base.length;
  const last = base[n - 1][1];
  const scaleBase = Math.abs(last) > 1 ? Math.abs(last) : 1;
  // Per-trader character: how much of the real sample's shape shows, how
  // noisy the walk is, and whether the gains come early or late.
  const sampleWeight = random() * 0.45;
  const volatility = 0.04 + random() * 0.22;
  const curve = 0.35 + random() * 2.2;
  const jumpAt = random() < 0.4 ? Math.floor(random() * n) : -1;
  let walk = 0;
  const raw = base.map(([t, v], i) => {
    walk += (random() - 0.5) * volatility;
    const progress = i / Math.max(1, n - 1);
    const trend = progress ** curve + (jumpAt >= 0 && i >= jumpAt ? 0.35 : 0);
    return [t, (v / scaleBase) * sampleWeight + trend + walk] as [number, number];
  });
  if (target === null) return base;
  const start = raw[0][1];
  const end = raw[n - 1][1];
  const span = end - start;
  if (Math.abs(span) < 1e-6) {
    return raw.map(([t], i) => [t, (target * i) / Math.max(1, n - 1)]);
  }
  return raw.map(([t, v]) => [t, ((v - start) / span) * target]);
}

export function portfolioFor(address: string, window: TraderWindow, market: "all" | "perp") {
  const sample = sampleWindow(window, market);
  const stats = findStats(address);
  const pnlBase = sample.pnlHistory.map(([t, v]) => [t + SHIFT, Number(v)] as [number, number]);
  const valueBase = sample.accountValueHistory.map(
    ([t, v]) => [t + SHIFT, Number(v)] as [number, number],
  );

  if (!stats) {
    return withRisk({ accountValue: valueBase, pnl: pnlBase, volume: Number(sample.vlm) });
  }

  const target = market === "perp" ? stats.pnl[window] * 0.92 : stats.pnl[window];
  const pnl = shapedSeries(`${address}:${window}:${market}`, pnlBase, target);
  const lastPnl = pnl.at(-1)?.[1] ?? 0;
  const baseValue = stats.accountValue - lastPnl;
  const floor = stats.accountValue * 0.03;
  const accountValue = pnl.map(([t, v]) => [t, Math.max(floor, baseValue + v)] as [number, number]);
  return withRisk({ accountValue, pnl, volume: stats.volume[window] });
}

/** ROI, Sharpe and drawdown, computed the way the contract describes them
 * (CopyDog's definitions; a simplified copy of the api's `returnMetrics`
 * and `riskMetrics`, on the fixture's single series). */
function withRisk(series: {
  accountValue: [number, number][];
  pnl: [number, number][];
  volume: number;
}) {
  const { pnl, accountValue } = series;
  let peakPnl = -Infinity;
  let maxDrawdownUsd = 0;
  for (const [, v] of pnl) {
    peakPnl = Math.max(peakPnl, v);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakPnl - v);
  }
  // ROI: PnL ÷ peak net deposits.
  const capital = Math.max(0, ...pnl.map(([, p], i) => (accountValue[i]?.[1] ?? 0) - p));
  const cumulativeReturn: [number, number][] = pnl.map(([t, p]) => [t, capital > 0 ? p / capital : 0]);
  // Sharpe / drawdown: ΔPnL ÷ peak account value.
  const peakAv = Math.max(0, ...accountValue.map(([, v]) => v));
  const returns: number[] = [];
  const times: number[] = [];
  for (let i = 1; i < pnl.length; i++) {
    if ((accountValue[i - 1]?.[1] ?? 0) <= 0 || peakAv <= 0) continue;
    returns.push((pnl[i][1] - pnl[i - 1][1]) / peakAv);
    times.push(pnl[i][0]);
  }
  let equity = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  for (const r of returns) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak);
  }
  let sharpe: number | null = null;
  if (returns.length > 2) {
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / 86400_000).sort((a, b) => a - b);
    const gap = gaps[Math.floor(gaps.length / 2)];
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1));
    sharpe = std > 0 && gap > 0 ? (mean / std) * Math.sqrt(365 / gap) : null;
  }
  return {
    ...series,
    maxDrawdownUsd,
    maxDrawdownPct: returns.length ? Math.min(1, maxDrawdownPct) : null,
    sharpe,
    roi: pnl.length ? cumulativeReturn.at(-1)![1] : null,
    cumulativeReturn,
  };
}

export function sparklineFor(address: string, window: TraderWindow): [number, number][] {
  const { pnl } = portfolioFor(address, window, "all");
  return pnl;
}

// --- positions & profile -----------------------------------------------------------

type SamplePosition = (typeof clearinghouse.assetPositions)[number]["position"];

const samplePositions: LivePosition[] = clearinghouse.assetPositions.map(({ position }) => {
  const p = position as SamplePosition;
  const szi = Number(p.szi);
  return {
    coin: p.coin,
    szi,
    side: szi >= 0 ? "long" : "short",
    entryPx: p.entryPx === null ? null : Number(p.entryPx),
    positionValue: Number(p.positionValue),
    unrealizedPnl: Number(p.unrealizedPnl),
    leverage: p.leverage?.value ?? null,
    marginMode: p.leverage?.type ?? null,
    liqPx: p.liquidationPx === null ? null : Number(p.liquidationPx),
  };
});

const SAMPLE_ACCOUNT_VALUE = Number(clearinghouse.marginSummary.accountValue);

/** A few crypto perps so not every trader holds only xyz stocks. */
const CRYPTO: { coin: string; px: number }[] = [
  { coin: "BTC", px: 112_450 },
  { coin: "ETH", px: 4_120 },
  { coin: "SOL", px: 208.4 },
  { coin: "HYPE", px: 47.9 },
  { coin: "XRP", px: 2.86 },
  { coin: "DOGE", px: 0.241 },
  { coin: "SUI", px: 3.38 },
];

function positionsFor(address: string, accountValue: number): LivePosition[] {
  const random = rng(`positions:${address}`);
  if (random() < 0.12) return [];
  const scale = (accountValue / SAMPLE_ACCOUNT_VALUE) * (0.15 + random() * 0.9);
  const count = 2 + Math.floor(random() * 6);
  const picked = [...samplePositions].sort(() => random() - 0.5).slice(0, Math.max(0, count - 2));
  const stock = picked.map((p) => ({
    ...p,
    szi: p.szi * scale,
    positionValue: p.positionValue * scale,
    unrealizedPnl: p.unrealizedPnl * scale * (random() < 0.3 ? -1 : 1),
  }));
  const crypto = [...CRYPTO]
    .sort(() => random() - 0.5)
    .slice(0, 2)
    .map(({ coin, px }) => {
      const long = random() < 0.62;
      const value = accountValue * (0.1 + random() * 0.6);
      const sz = value / px;
      const entry = px * (1 + (random() - 0.5) * 0.08);
      const leverage = [3, 5, 10, 20, 25][Math.floor(random() * 5)];
      const unrealized = (px - entry) * sz * (long ? 1 : -1);
      return {
        coin,
        szi: long ? sz : -sz,
        side: long ? "long" : "short",
        entryPx: entry,
        positionValue: value,
        unrealizedPnl: unrealized,
        leverage,
        marginMode: random() < 0.8 ? "cross" : "isolated",
        liqPx: long ? entry * (1 - 0.9 / leverage) : entry * (1 + 0.9 / leverage),
      } satisfies LivePosition;
    });
  return [...crypto, ...stock].sort((a, b) => b.positionValue - a.positionValue);
}

function isTrackedFixture(address: string, favorite: boolean): boolean {
  const rank = rankOf(address);
  return favorite || (rank >= 0 && rank < 60);
}

/** GET /traders/:address/activity: sample size and last trade. */
export function activityFor(
  address: string,
  favorite: boolean,
  lowSampleThreshold: number,
): TraderActivityResponse {
  const sample = sampleFor(address, isTrackedFixture(address, favorite));
  return {
    address: address.toLowerCase(),
    lastTradeAt: lastTradeFor(address),
    sample: { ...sample, lowSample: sample.fills30d < lowSampleThreshold },
    fetchedAt: new Date(NOW),
  };
}

export function profileFor(
  address: string,
  favorite: boolean,
): TraderProfileResponse {
  const stats = findStats(address);
  const accountValue = stats?.accountValue ?? SAMPLE_ACCOUNT_VALUE;
  const positions = stats ? positionsFor(address, accountValue) : samplePositions;
  const longNotional = positions
    .filter((p) => p.side === "long")
    .reduce((sum, p) => sum + p.positionValue, 0);
  const shortNotional = positions
    .filter((p) => p.side === "short")
    .reduce((sum, p) => sum + p.positionValue, 0);
  const marginUsed = positions.reduce(
    (sum, p) => sum + p.positionValue / Math.max(1, p.leverage ?? 1),
    0,
  );
  const tracked = isTrackedFixture(address, favorite);
  const random = rng(`analytics:${address}`);

  const coinPnl = [
    ...positions.map((p) => ({ coin: p.coin, pnl: p.unrealizedPnl })),
    ...CRYPTO.slice(0, 4).map(({ coin }) => ({
      coin,
      pnl: (random() - 0.35) * accountValue * 0.08,
    })),
  ];
  const merged = [...new Map(coinPnl.map((c) => [c.coin, c])).values()];

  // A standard account: most of it perp, some USDC and HYPE in spot.
  const usdc = Math.round(accountValue * 0.08 * 100) / 100;
  const hype = Math.round((accountValue * 0.02) / 47.9);
  const spotBalances = [
    { coin: "USDC", token: 0, total: usdc, px: 1, value: usdc, priceKey: null },
    { coin: "HYPE", token: 150, total: hype, px: 47.9, value: hype * 47.9, priceKey: "@107" },
  ].filter((b) => b.total > 0);
  const spotValue = spotBalances.reduce((sum, b) => sum + b.value, 0);
  const perpEquity = accountValue - spotValue;

  return {
    address: address.toLowerCase(),
    displayName: stats?.displayName ?? null,
    stats,
    accountValue,
    perpEquity,
    spotValue,
    stakedValue: 0,
    accountMode: "standard",
    spotBalances,
    perpDexes: ["", "xyz"],
    marginUsed,
    withdrawable: Math.max(0, perpEquity - marginUsed),
    longNotional,
    shortNotional,
    positions,
    tracked,
    isVault: stats?.isVault ?? false,
    favorite,
    analytics: tracked
      ? {
          winRate30d: 0.42 + random() * 0.4,
          roundTrips30d: 12 + Math.floor(random() * 180),
          realizedPnl30d: (stats?.pnl.month ?? 0) * (0.6 + random() * 0.5),
          avgHoldSeconds: 1800 + random() * 86400 * 3,
          bestCoins: merged
            .filter((c) => c.pnl > 0)
            .sort((a, b) => b.pnl - a.pnl)
            .slice(0, 3),
          worstCoins: merged
            .filter((c) => c.pnl < 0)
            .sort((a, b) => a.pnl - b.pnl)
            .slice(0, 3),
        }
      : null,
    fetchedAt: new Date(NOW),
  };
}

/** 30-day fill count. Roughly one trader in five is under the default
 * low-sample threshold (20); untracked whales can hit the 2,000 cap. */
export const LOW_SAMPLE_THRESHOLD = 20;

/** When the trader last traded, consistent with its leaderboard activity:
 * within the day / week / month, or (a 30-day holder) months back or never
 * as far as the latest fills go. Addresses off the leaderboard traded
 * recently. Seeded, so stable across reloads. */
function lastTradeFor(address: string): Date | null {
  const random = rng(`last-trade:${address}`);
  const activity = findStats(address)?.activity ?? "day";
  const HOUR = 3_600_000;
  const between = (fromH: number, toH: number) => new Date(NOW - (fromH + random() * (toH - fromH)) * HOUR);
  switch (activity) {
    case "day":
      return between(0.1, 23);
    case "week":
      return between(25, 7 * 24 - 1);
    case "month":
      return between(7 * 24 + 1, 30 * 24 - 1);
    case "inactive":
      return random() < 0.3 ? null : between(31 * 24, 300 * 24);
  }
}

function sampleFor(address: string, tracked: boolean) {
  // No volume in 30 days → no fills in 30 days.
  if (findStats(address)?.activity === "inactive") return { fills30d: 0, capped: false, lowSample: true };
  const random = rng(`sample:${address}`);
  const roll = random();
  const fills30d =
    roll < 0.2 ? Math.floor(random() * 19) : roll < 0.9 ? 20 + Math.floor(random() ** 2 * 1400) : 2000;
  const capped = !tracked && fills30d >= 2000;
  return { fills30d, capped, lowSample: fills30d < LOW_SAMPLE_THRESHOLD };
}

// --- fills ------------------------------------------------------------------------------

/** A run of the sample's fills stands in for TWAP slices, so the fills tab
 * shows its "TWAP" tag in fixture mode. */
const FIXTURE_TWAP = { id: 2_256_941, from: 4, to: 10 };

export function traderFills(limit: number): TraderFill[] {
  return fillsSample.slice(0, limit).map((f, i) => ({
    tid: String(f.tid),
    coin: f.coin,
    side: f.side === "B" ? "buy" : "sell",
    dir: f.dir,
    px: Number(f.px),
    sz: Number(f.sz),
    notionalUsd: Number(f.px) * Number(f.sz),
    closedPnl: f.closedPnl === null ? null : Number(f.closedPnl),
    fee: f.fee === null ? null : Number(f.fee),
    ts: new Date(f.time + SHIFT),
    twapId: i >= FIXTURE_TWAP.from && i < FIXTURE_TWAP.to ? FIXTURE_TWAP.id : null,
  }));
}

// --- action feed (synthesized over the top of the leaderboard) -------------------------------

const FEED_COINS: { coin: string; px: number }[] = [
  ...CRYPTO,
  { coin: "xyz:TSLA", px: 368.4 },
  { coin: "xyz:NVDA", px: 228.2 },
  { coin: "xyz:GOLD", px: 3_812 },
  { coin: "xyz:SP500", px: 6_655 },
];
const KINDS = ["open", "add", "reduce", "close", "flip", "open", "add", "close"] as const;
const TIERS = ["A", "B", "C"] as const;

interface FeedEntry {
  action: ActionFeedItem;
  fills: Fill[];
}

const feed: FeedEntry[] = (() => {
  const random = rng("feed");
  const entries: FeedEntry[] = [];
  let ts = NOW - 25_000;
  for (let i = 0; i < 160; i++) {
    const trader = traderStats[Math.floor(random() ** 1.6 * 48)];
    const { coin, px } = FEED_COINS[Math.floor(random() * FEED_COINS.length)];
    const kind = random() < 0.015 ? "liquidation" : KINDS[Math.floor(random() * KINDS.length)];
    const side = random() < 0.58 ? "long" : "short";
    const notional = Math.round(50_000 + random() ** 3 * 12_000_000);
    const avgPx = px * (1 + (random() - 0.5) * 0.01);
    const id = String(90_000 + 160 - i);
    const fillCount = 1 + Math.floor(random() * 4);
    const fills: Fill[] = Array.from({ length: fillCount }, (_, j) => {
      const sz = notional / avgPx / fillCount;
      const opening = kind === "open" || kind === "add";
      return {
        chain: "hyperliquid",
        tid: String(hashString(`${id}:${j}`)),
        address: trader.address,
        coin,
        side: (side === "long") === opening ? "B" : "A",
        dir: `${opening ? "Open" : "Close"} ${side === "long" ? "Long" : "Short"}`,
        px: (avgPx * (1 + (random() - 0.5) * 0.0008)).toFixed(4),
        sz: sz.toFixed(4),
        fee: (notional * 0.00035 / fillCount).toFixed(4),
        closedPnl: opening ? "0" : ((random() - 0.35) * notional * 0.05).toFixed(2),
        hash: `0x${hashString(`${id}:${j}:h`).toString(16).padStart(8, "0")}`,
        ts: new Date(ts - j * 900),
        raw: {},
      };
    });
    entries.push({
      action: {
        id,
        chain: "hyperliquid",
        address: trader.address,
        coin,
        kind,
        side,
        notionalUsd: String(notional),
        avgPx: avgPx.toFixed(4),
        leverage: String([2, 3, 5, 10, 20][Math.floor(random() * 5)]),
        fillIds: fills.map((f) => String(f.tid)),
        ts: new Date(ts),
        leaderLabel: trader.displayName,
        leaderTier: TIERS[Math.min(2, Math.floor(rankOf(trader.address) / 16))],
      },
      fills,
    });
    ts -= Math.floor(15_000 + random() ** 2 * 900_000);
  }
  return entries;
})();

export function actionsFeed(): ActionFeedItem[] {
  return feed.map((e) => e.action);
}

export function actionFills(id: string): Fill[] {
  return feed.find((e) => String(e.action.id) === id)?.fills ?? [];
}

// --- alerts, rules, lists, health, me ------------------------------------------------------------

export function alertsFor(address: string | undefined): AlertEntry[] {
  return feed
    .filter((e) => !address || e.action.address === address.toLowerCase())
    .filter((e) => Number(e.action.notionalUsd) > 800_000)
    .slice(0, 20)
    .map((e, i) => ({
      id: String(5000 + i),
      ruleId: e.action.kind === "open" ? 1 : 2,
      userId: 1,
      chain: "hyperliquid",
      address: e.action.address,
      coin: e.action.coin,
      actionId: e.action.id,
      payloadJson: { version: 1, values: { actionKind: e.action.kind, notionalUsd: String(e.action.notionalUsd) } },
      sentAt: new Date(new Date(e.action.ts).getTime() + 2_400),
      sendStatus: "dry_run",
      pxAtSend: e.action.avgPx,
      px1h: null,
      px4h: null,
      px24h: null,
    }));
}

/** The default rules (no owner) the admin edits. */
export const alertRules: AlertRule[] = [
  {
    id: 1,
    userId: null,
    scope: "address",
    kind: "R1",
    paramsJson: { flatThresholdUsd: 1_000_000, pctThreshold: 0.1 },
    cooldownS: 600,
    quietHours: null,
    tiers: ["A", "B"],
    enabled: true,
  },
  {
    id: 2,
    userId: null,
    scope: "address",
    kind: "R2",
    paramsJson: {},
    cooldownS: 300,
    quietHours: null,
    tiers: ["A", "B", "C"],
    enabled: true,
  },
  {
    id: 3,
    userId: null,
    scope: "address",
    kind: "R3",
    paramsJson: { flatThresholdUsd: 500_000, pctThreshold: 0.05 },
    cooldownS: 900,
    quietHours: null,
    tiers: ["A"],
    enabled: false,
  },
];

export const leaderLists: LeaderList[] = [
  { id: 3, source: "copydog", importedAt: new Date(NOW - 2 * 86400_000), fileName: "copydog-top100-2026-09-27.csv" },
  { id: 2, source: "copydog", importedAt: new Date(NOW - 9 * 86400_000), fileName: "copydog-top100-2026-09-20.csv" },
  { id: 1, source: "copydog", importedAt: new Date(NOW - 23 * 86400_000), fileName: "copydog-top100-2026-09-06.json" },
];

export function health(): HeartbeatResponse {
  const now = Date.now();
  return {
    feedConnected: true,
    feedSocketsOpen: 4,
    feedSocketsTotal: 4,
    marketsSubscribed: 231,
    feedDisconnectedSince: null,
    lastTradeAt: new Date(now - 800),
    lastFillAt: new Date(now - 42_000),
    lastSnapshotAt: new Date(now - 140_000),
    lastSweepAt: new Date(now - 31 * 60_000),
    requestsLastMinute: 38,
    weightLastMinute: 412,
    queuedRequests: { live: 0, background: 3 },
    fillsUnavailable: [],
    dryRun: true,
    now: new Date(now),
  };
}

export function fixtureMe(locale: MeResponse["locale"]): MeResponse {
  return {
    id: 1,
    privyUserId: "did:privy:fixture-demo-user",
    permissions: [...ROLE_PERMISSIONS.admin],
    email: "demo@example.com",
    walletAddress: "0x0000000000000000000000000000000000000000",
    displayName: "Demo",
    role: "admin",
    locale,
    createdAt: new Date(NOW - 12 * 86400_000),
  };
}

/** Starting favorites for the demo user. */
export const initialFavorites = [5, 7, 0, 11, 16].map((i) => traderStats[i].address);
