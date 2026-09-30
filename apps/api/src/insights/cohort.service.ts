import { Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { cohortTierSchema, type CohortDetailResponse, type CohortHistoryResponse, type CohortTier, type CohortWindow } from "@trading-dashboard/shared/contracts";

import { pnlTier } from "../analytics/trade-metrics.js";
import { AppConfig } from "../config/app-config.js";
import { kolAvatarPath } from "../discovery/kol-avatar.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK, UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { COHORT_TIERS, aggregate, candleInterval, dexOf, downsample, positionsFrom, WINDOW_MS, type MemberSnapshot } from "./cohorts.js";
import { CohortRepository, type CohortCandidate, type CohortMemberRow } from "./cohort.repository.js";

/** Weight of one `clearinghouseState` (per dex). */
const WEIGHT_STATE = 2;
/** Every dex of a member is swept this often; in between only the main
 * dex and the dexes it holds or has traded are queried. */
export const SWEEP_MS = 24 * 3_600_000;
/** A tick spends at most this long, so ticks never overlap. */
const TICK_WORK_MS = 50_000;
/** The job may save up at most this many minutes of its allowance. */
const MAX_SAVED_MINUTES = 2;
/** Detail responses are rebuilt at most this often per tier. */
export const DETAIL_TTL_MS = 30_000;
/** BTC candles are fetched at most this often per window. */
export const CANDLES_TTL_MS = 10 * 60_000;
/** Chart points per history response. */
const MAX_POINTS = 400;
/** Behind page loads, level with other background work (like the pool). */
const COHORT_RANK = UNRANKED_BASE;
/** The perp dex list changes rarely. */
const DEX_LIST_TTL_MS = 60 * 60_000;

/** One refresh's cost, kept for the docs and the admin view. */
export interface CohortRefreshLog {
  address: string;
  tier: string;
  weight: number;
  calls: number;
  swept: boolean;
  ms: number;
  ok: boolean;
  at: Date;
}

/**
 * 洞察 cohorts (Stage 3 §3, CopyDog's /hyperliquid/cohorts): the discovery
 * pool's traders grouped by all-time perp PnL tier (topped up from the
 * leaderboard where the pool is short), up to `discovery.cohortMembersPerTier`
 * each by account value. A cron tick (every minute) spends at most
 * `discovery.cohortWeightPerMinute` Hyperliquid weight reading members'
 * positions — `clearinghouseState` on the main dex plus the dexes they hold
 * or traded (2 weight each), every dex once a day — oldest first, so each
 * member is refreshed about every `cohortRefreshMinutes` when the budget
 * allows. After each tick a tier whose last history row is that old gets a
 * new one. Calls rank behind page loads.
 */
@Injectable()
export class CohortService {
  private readonly logger = new Logger(CohortService.name);
  private running: Promise<void> | undefined;
  private builtAt = 0;
  private tokens = 0;
  private tokensAt = Date.now();
  private lastSnapshot: Map<string, Date> | null = null;
  readonly log: CohortRefreshLog[] = [];
  readonly detailCache = new TtlCache<CohortDetailResponse>(DETAIL_TTL_MS);
  readonly candleCache = new TtlCache<Array<[number, number]>>(CANDLES_TTL_MS);
  private readonly dexCache = new TtlCache<string[]>(DEX_LIST_TTL_MS, 1);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: CohortRepository,
    private readonly info: HyperliquidInfoClient,
    private readonly settings: SettingsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  /** Cron entry point: one tick at a time, never in tests. */
  onTick(): Promise<void> {
    if (this.config.value.app.nodeEnv === "test" || this.jobs.stopping) return Promise.resolve();
    this.running ??= this.jobs
      .run(() => this.tick())
      .catch((error: Error) => this.logger.error(`Cohort tick failed: ${error.message}`))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Rebuilds membership when due, refreshes members within the
   * allowance, then writes the history rows that are due. */
  async tick(now = Date.now()): Promise<void> {
    const discovery = await this.settings.get("discovery");
    const intervalMs = discovery.cohortRefreshMinutes * 60_000;
    if (this.builtAt === 0 || now - this.builtAt >= intervalMs) {
      await this.build(discovery.cohortMembersPerTier);
      this.builtAt = now;
    }
    const perMinute = discovery.cohortWeightPerMinute;
    if (perMinute > 0) {
      const elapsedMin = Math.max(0, (now - this.tokensAt) / 60_000);
      this.tokens = Math.min(perMinute * MAX_SAVED_MINUTES, this.tokens + perMinute * Math.min(elapsedMin, MAX_SAVED_MINUTES));
      this.tokensAt = now;
      const until = Date.now() + TICK_WORK_MS;
      while (this.tokens > 0 && Date.now() < until && !this.jobs.stopping) {
        const [next] = await this.repository.nextDue(1, new Date(Date.now() - intervalMs));
        if (!next) break;
        this.tokens -= (await this.refreshOne(next)).weight;
      }
    }
    await this.writeSnapshots(intervalMs, new Date(now));
  }

  /**
   * Chooses each tier's members: pool traders by perp PnL tier, largest
   * account value first, up to `perTier`; a short tier is topped up with the
   * leaderboard's largest active accounts in that PnL range.
   */
  async build(perTier: number): Promise<{ total: number; added: number; removed: number }> {
    const pool = await this.repository.poolFigures();
    const byTier = new Map<CohortTier, typeof pool>();
    for (const row of pool) {
      const tier = pnlTier(Number(row.pnlAll));
      if (!tier) continue;
      const list = byTier.get(tier) ?? [];
      list.push(row);
      byTier.set(tier, list);
    }
    const candidates: CohortCandidate[] = [];
    const taken = new Set<string>();
    for (const tier of COHORT_TIERS) {
      const rows = (byTier.get(tier) ?? []).sort((a, b) => Number(b.accountValue ?? 0) - Number(a.accountValue ?? 0)).slice(0, perTier);
      rows.forEach((row, i) => {
        taken.add(row.address);
        const dexes = [...new Set(Object.keys(row.coinStats ?? {}).map(dexOf).filter(Boolean))];
        candidates.push({ address: row.address, tier, source: "pool", rank: i + 1, pnlAll: row.pnlAll, roiAll: row.roiAll, dexes });
      });
      const topUp = await this.repository.leaderboardTopUp(tier, perTier - rows.length, [...taken, ...pool.map((p) => p.address)]);
      topUp.forEach((row, i) => {
        taken.add(row.address);
        // No coin history: start with the main dex and the busiest HIP-3 one.
        candidates.push({ address: row.address, tier, source: "leaderboard", rank: rows.length + i + 1, pnlAll: row.pnlAll, roiAll: row.roiAll, dexes: ["xyz"] });
      });
    }
    const result = await this.repository.sync(candidates);
    if (result.added > 0 || result.removed > 0) this.logger.log(`Cohorts: ${candidates.length} members (${result.added} added, ${result.removed} removed)`);
    return { total: candidates.length, ...result };
  }

  private perpDexes(): Promise<string[]> {
    return this.dexCache.get("dexes", async () => (await this.info.perpDexs("background", COHORT_RANK)).map((d) => d?.name ?? "").filter(Boolean));
  }

  /**
   * One member's positions: the main dex plus its known dexes, or every
   * dex when its daily sweep is due. Returns the weight spent. A failure
   * keeps the previous snapshot and records the error.
   */
  async refreshOne(member: CohortMemberRow, now = Date.now()): Promise<{ weight: number; ok: boolean }> {
    const started = Date.now();
    let weight = 0;
    let calls = 0;
    let swept = false;
    try {
      const all = await this.perpDexes();
      swept = member.sweptAt !== null && now - member.sweptAt.getTime() >= SWEEP_MS;
      const dexes = swept ? all : member.dexes.filter((d) => all.includes(d));
      const states = await Promise.all(["", ...dexes].map((dex) => {
        weight += WEIGHT_STATE;
        calls += 1;
        return this.info.clearinghouseState(member.address, dex || undefined, "background", COHORT_RANK);
      }));
      const { positions, equity } = positionsFrom(states);
      // Keep querying dexes the member traded; add any it now holds.
      const held = positions.map((p) => dexOf(p.coin)).filter(Boolean);
      const known = [...new Set([...member.dexes, ...held])].filter((d) => all.includes(d));
      await this.repository.saveSnapshot(member.address, {
        positions, perpEquity: equity, dexes: known, fetchedAt: new Date(now),
        ...(swept || member.sweptAt === null ? { sweptAt: new Date(now) } : {}),
      });
      this.record({ address: member.address, tier: member.tier, weight, calls, swept, ms: Date.now() - started, ok: true, at: new Date() });
      return { weight, ok: true };
    } catch (error) {
      await this.repository.saveFailure(member.address, new Date(now), (error as Error).message.slice(0, 300));
      this.record({ address: member.address, tier: member.tier, weight, calls, swept, ms: Date.now() - started, ok: false, at: new Date() });
      this.logger.warn(`Cohort refresh ${member.address} failed: ${(error as Error).message}`);
      return { weight: Math.max(weight, WEIGHT_STATE), ok: false };
    }
  }

  private record(entry: CohortRefreshLog) {
    this.log.push(entry);
    if (this.log.length > 2000) this.log.shift();
  }

  /** Members with a snapshot since this are "fresh" (3 intervals, ≥ 1 h). */
  private freshSince(intervalMs: number, now: Date): Date {
    return new Date(now.getTime() - Math.max(3 * intervalMs, 3_600_000));
  }

  /** One history row per tier whose last row is `intervalMs` old, when it
   * has fresh wallets. */
  async writeSnapshots(intervalMs: number, now = new Date()): Promise<number> {
    this.lastSnapshot ??= await this.repository.lastSnapshotAt();
    let written = 0;
    for (const tier of COHORT_TIERS) {
      const last = this.lastSnapshot.get(tier);
      if (last && now.getTime() - last.getTime() < intervalMs - 30_000) continue;
      const detail = aggregate(tier, await this.snapshots(tier), this.freshSince(intervalMs, now));
      if (detail.walletCount === 0) continue;
      const h = detail.hero;
      await this.repository.insertSnapshot({
        tier, ts: now, memberCount: detail.memberCount, walletCount: detail.walletCount,
        notionalLong: String(h.notionalLong), notionalShort: String(h.notionalShort), longPct: h.longPct === null ? null : String(h.longPct),
        upnlProfit: String(h.upnlProfit), upnlLoss: String(h.upnlLoss), walletsInProfit: h.walletsInProfit, walletsInLoss: h.walletsInLoss,
      });
      this.lastSnapshot.set(tier, now);
      written++;
    }
    return written;
  }

  private async snapshots(tier: CohortTier): Promise<MemberSnapshot[]> {
    const members = await this.repository.membersOf(tier);
    const ids = new Map((await this.repository.identities(members.map((m) => m.address))).map((r) => [r.address, r]));
    const num = (v: string | null) => (v === null ? null : Number(v));
    return members.map((m) => {
      const id = ids.get(m.address);
      const kol = id?.kolVerified !== null && id?.kolVerified !== undefined;
      return {
        address: m.address,
        pnlAll: num(m.pnlAll),
        roiAll: num(m.roiAll),
        perpEquity: num(m.perpEquity),
        positions: m.positions,
        fetchedAt: m.fetchedAt,
        displayName: (kol ? id!.kolName : null) ?? id?.leaderboardName ?? null,
        avatarUrl: kol ? kolAvatarPath(m.address, id!.kolAvatarEtag) : null,
        verified: kol ? Boolean(id!.kolVerified) : false,
        copyScore: id?.copyScore ?? null,
      };
    });
  }

  /** GET /insights/cohorts/:tier (cached `DETAIL_TTL_MS`; no upstream calls).
   * @throws NotFoundException for an unknown tier. */
  async detail(tier: string): Promise<CohortDetailResponse> {
    const parsed = parseTier(tier);
    const discovery = await this.settings.get("discovery");
    return this.detailCache.get(parsed, async () =>
      aggregate(parsed, await this.snapshots(parsed), this.freshSince(discovery.cohortRefreshMinutes * 60_000, new Date())));
  }

  /**
   * GET /insights/cohorts/:tier/history: the stored long share over the
   * window (at most 400 points) and BTC closes over the same span from
   * `candleSnapshot` (20 weight + 1 per 60 candles, cached
   * `CANDLES_TTL_MS`; left empty when Hyperliquid is busy).
   */
  async history(tier: string, window: CohortWindow): Promise<CohortHistoryResponse> {
    const parsed = parseTier(tier);
    const now = Date.now();
    const since = Number.isFinite(WINDOW_MS[window]) ? new Date(now - WINDOW_MS[window]) : null;
    const rows = (await this.repository.history(parsed, since)).filter((r) => r.longPct !== null).map((r) => ({ t: r.ts, pctLong: Number(r.longPct) }));
    const series = downsample(rows, MAX_POINTS);
    let btc: Array<[number, number]> = [];
    if (series.length > 0) {
      const start = since ? since.getTime() : series[0].t.getTime();
      const { interval, ms } = candleInterval(window, now - start);
      const from = Math.floor(start / ms) * ms;
      try {
        btc = await this.candleCache.get(`${interval}:${from}`, async () => {
          const candles = await this.info.candleSnapshot("BTC", interval, from, now, Math.ceil((now - from) / ms) + 1, "background", PAGE_RANK.portfolio);
          return candles.map((c) => [c.t, Number(c.c)] as [number, number]);
        });
      } catch (error) {
        this.logger.warn(`BTC candles unavailable: ${(error as Error).message}`);
      }
    }
    return { tier: parsed, window, series, btc };
  }
}

function parseTier(tier: string): CohortTier {
  const parsed = cohortTierSchema.safeParse(tier);
  if (!parsed.success) throw new NotFoundException("Unknown cohort");
  return parsed.data;
}
