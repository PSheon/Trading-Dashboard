import { createHash } from "node:crypto";
import { Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { CHAIN_DEFAULT, cohortHeadlineReady, cohortTierSchema, type CohortDetailResponse, type CohortHistoryResponse, type CohortTier, type CohortWindow } from "@trading-dashboard/shared/contracts";

import { pnlTier } from "../analytics/trade-metrics.js";
import { DiscoveryService } from "../discovery/discovery.service.js";
import { AppConfig } from "../config/app-config.js";
import { kolAvatarPath } from "../discovery/kol-avatar.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { BudgetWaitError, ESSENTIAL_RANK, PAGE_RANK, pacedWeightPerMinute, RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { sharedCapacityWait, SHARED_CAPACITY_RETRY_MS } from "../hyperliquid/hyperliquid-budget-wait.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { COHORT_TIERS, aggregate, candleInterval, cohortEligible, cohortHistoryReady, dexOf, positionsFrom, WINDOW_MS, type MemberSnapshot } from "./cohorts.js";
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
const COHORT_RANK = ESSENTIAL_RANK.cohort;
/** The perp dex list changes rarely. */
const DEX_LIST_TTL_MS = 60 * 60_000;
/** Provider/account failures retry slowly; capacity refuses the whole job
 * until the shared REST accounting window has cleared. */
const FAILURE_RETRY_MS = 5 * 60_000;

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
 * pool's traders grouped by all-time perp PnL tier: every eligible one is a
 * member, as on CopyDog (whose 極度盈利 members are its pool's tier, 352 on
 * 2026-10-04, no round cap), largest perp equity first, with
 * `DISCOVERY_COHORT_MEMBERS_PER_TIER` only as a safety cap; a tier the pool
 * leaves short is topped up from the leaderboard up to that cap. A cron tick (every minute) spends at most
 * `HYPERLIQUID_COHORT_WEIGHT_PER_MIN` Hyperliquid weight reading members'
 * positions — `clearinghouseState` on the main dex plus the dexes they hold
 * or traded (2 weight each); every dex on the first read and once a day
 * after (22 with 11 dexes) — oldest first, so each
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
  private capacityRetryAt = 0;
  private lastSnapshot: Map<string, Date> | null = null;
  readonly log: CohortRefreshLog[] = [];
  readonly detailCache = new TtlCache<CohortDetailResponse>(DETAIL_TTL_MS);
  readonly candleCache = new TtlCache<Array<[number, number]>>(CANDLES_TTL_MS);
  private readonly dexCache = new TtlCache<string[]>(DEX_LIST_TTL_MS, 1);
  /** The last BTC closes read per candle size, served while Hyperliquid is busy. */
  private readonly lastBtc = new Map<string, Array<[number, number]>>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: CohortRepository,
    private readonly info: HyperliquidInfoClient,
    private readonly settings: SettingsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() private readonly discovery?: DiscoveryService,
    @Optional() private readonly budgeter?: RequestBudgeterService,
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
    const { discovery, weights } = this.config.value.tuning;
    const intervalMs = discovery.cohortRefreshMinutes * 60_000;
    if (this.builtAt === 0 || now - this.builtAt >= intervalMs) {
      await this.build(discovery.cohortMembersPerTier);
      this.builtAt = now;
    }
    const perMinute = pacedWeightPerMinute(this.budgeter, "cohort", weights.cohort);
    if (perMinute > 0 && now >= this.capacityRetryAt) {
      const elapsedMin = Math.max(0, (now - this.tokensAt) / 60_000);
      this.tokens = Math.min(perMinute * MAX_SAVED_MINUTES, this.tokens + perMinute * Math.min(elapsedMin, MAX_SAVED_MINUTES));
      this.tokensAt = now;
      const until = Date.now() + TICK_WORK_MS;
      while (this.tokens > 0 && Date.now() < until && !this.jobs.stopping) {
        const at = Date.now();
        const [next] = await this.repository.nextDue(1, new Date(at - intervalMs), {
          failureBefore: new Date(at - FAILURE_RETRY_MS), capacityBefore: new Date(at - SHARED_CAPACITY_RETRY_MS),
        });
        if (!next) break;
        const result = await this.refreshOne(next);
        this.tokens -= result.weight;
        if (result.capacityLimited) {
          this.capacityRetryAt = Date.now() + SHARED_CAPACITY_RETRY_MS;
          break;
        }
      }
    }
    await this.writeSnapshots(intervalMs, new Date(now));
  }

  /**
   * Chooses each tier's members: eligible pool traders (`cohortEligible`:
   * no vaults, no wallet above the perp-equity ceiling) by perp PnL tier,
   * largest perp equity first (traders whose perp equity is not known yet
   * after every known one: never ranked by the whole account's value), up
   * to `perTier`; a short
   * tier is topped up with the leaderboard's largest active accounts in that
   * PnL range.
   */
  async build(perTier: number): Promise<{ total: number; added: number; removed: number }> {
    const pool = await this.repository.poolFigures();
    const byTier = new Map<CohortTier, typeof pool>();
    const num = (v: string | null) => (v === null ? null : Number(v));
    const size = (row: (typeof pool)[number]) => num(row.perpEquity) ?? -Infinity;
    for (const row of pool) {
      const tier = pnlTier(Number(row.pnlAll));
      if (!tier) continue;
      if (!cohortEligible({ isVault: row.isVault, perpEquity: num(row.perpEquity) })) continue;
      const list = byTier.get(tier) ?? [];
      list.push(row);
      byTier.set(tier, list);
    }
    const candidates: CohortCandidate[] = [];
    const taken = new Set<string>();
    for (const tier of COHORT_TIERS) {
      const rows = (byTier.get(tier) ?? []).sort((a, b) => (size(b) === size(a) ? 0 : size(b) > size(a) ? 1 : -1) || a.address.localeCompare(b.address)).slice(0, perTier);
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
  async refreshOne(member: CohortMemberRow, now = Date.now()): Promise<{ weight: number; ok: boolean; capacityLimited?: boolean }> {
    const started = Date.now();
    let weight = 0;
    let calls = 0;
    let swept = false;
    try {
      const all = await this.perpDexes();
      // The first read and then one a day cover every dex; in between only
      // the dexes it holds or traded (HIP-3 positions elsewhere show up
      // within a day).
      swept = member.sweptAt === null || now - member.sweptAt.getTime() >= SWEEP_MS;
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
        ...(swept ? { sweptAt: new Date(now) } : {}),
      });
      this.record({ address: member.address, tier: member.tier, weight, calls, swept, ms: Date.now() - started, ok: true, at: new Date() });
      return { weight, ok: true };
    } catch (error) {
      const capacityLimited = Boolean(sharedCapacityWait(error)) || error instanceof BudgetWaitError
        || error instanceof Error && error.message === "Hyperliquid queue is full";
      const message = (error as Error).message;
      await this.repository.saveFailure(member.address, new Date(now), `${capacityLimited ? "capacity: " : ""}${message}`.slice(0, 300));
      this.record({ address: member.address, tier: member.tier, weight, calls, swept, ms: Date.now() - started, ok: false, at: new Date() });
      this.logger.warn(`Cohort refresh ${member.address} failed: ${(error as Error).message}`);
      return { weight: Math.max(weight, WEIGHT_STATE), ok: false, ...(capacityLimited ? { capacityLimited: true } : {}) };
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

  /** One history row per tier whose last row is `intervalMs` old, once
   * enough of the tier is fresh for the figure to be the tier's
   * (`cohortHistoryReady`: 95 % of the members and of their perp equity). A
   * point from part of the members would stay on the 倉位傾向 chart for good;
   * one missing whale moved it by 30 points. */
  async writeSnapshots(intervalMs: number, now = new Date()): Promise<number> {
    this.lastSnapshot ??= await this.repository.lastSnapshotAt();
    let written = 0;
    for (const tier of COHORT_TIERS) {
      const last = this.lastSnapshot.get(tier);
      if (last && now.getTime() - last.getTime() < intervalMs - 30_000) continue;
      const members = await this.snapshots(tier);
      const freshSince = this.freshSince(intervalMs, now);
      const detail = aggregate(tier, members, freshSince);
      if (!cohortHeadlineReady(detail.walletCount, detail.memberCount) || !cohortHistoryReady(members, freshSince)) continue;
      const h = detail.hero;
      // Use the exact selected set aggregated above, not a later mutable membership read.
      // Coverage still describes the fresh subset; identity alone does not imply identical contributors.
      const memberAddresses = members.map(member => member.address.toLowerCase()).sort();
      const membershipVersion = createHash("sha256").update(JSON.stringify([CHAIN_DEFAULT, tier, memberAddresses])).digest("hex");
      await this.repository.insertSnapshot({
        membershipVersion, memberAddresses,
        tier, ts: now, memberCount: detail.memberCount, walletCount: detail.walletCount,
        notionalLong: String(h.notionalLong), notionalShort: String(h.notionalShort), longPct: h.longPct === null ? null : String(h.longPct),
        upnlProfit: String(h.upnlProfit), upnlLoss: String(h.upnlLoss), walletsInProfit: h.walletsInProfit, walletsInLoss: h.walletsInLoss,
      });
      this.lastSnapshot.set(tier, now);
      written++;
    }
    return written;
  }

  /** The tier's members as the aggregation reads them. With `scores`, each
   * carries the copy score the trader page and every board show (the pool
   * snapshot's percentile); without, none (history rows do not use it). */
  private async snapshots(tier: CohortTier, scores?: ReadonlyMap<string, number>): Promise<MemberSnapshot[]> {
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
        copyScore: scores?.get(m.address) ?? null,
      };
    });
  }

  /** GET /insights/cohorts/:tier (cached `DETAIL_TTL_MS`; no upstream calls).
   * @throws NotFoundException for an unknown tier. */
  async detail(tier: string): Promise<CohortDetailResponse> {
    const parsed = parseTier(tier);
    const { discovery } = this.config.value.tuning;
    return this.detailCache.get(parsed, async () => {
      const scores = await this.copyScores();
      return aggregate(parsed, await this.snapshots(parsed, scores), this.freshSince(discovery.cohortRefreshMinutes * 60_000, new Date()));
    });
  }

  /** The pool snapshot's copy scores; empty when unavailable, so a failing
   * score read never takes the tier down. */
  private async copyScores(): Promise<ReadonlyMap<string, number>> {
    if (!this.discovery) return new Map();
    try {
      return await this.discovery.copyScoreMap();
    } catch (error) {
      this.logger.warn(`Cohort copy scores unavailable: ${(error as Error).message}`);
      return new Map();
    }
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
    const history = await this.repository.history(parsed, since);
    let segment = 0;
    const rows = history.map((row, index) => {
      if (index > 0 && row.membershipVersion !== history[index - 1].membershipVersion) segment++;
      return { t: row.ts, pctLong: row.longPct === null ? null : Number(row.longPct), membershipVersion: row.membershipVersion, segment };
    }).filter((row): row is typeof row & { pctLong: number } => row.pctLong !== null);
    // Retain real observations, never average across different member sets. Segment
    // numbers preserve even a short A→B→A change skipped by the point budget.
    const count = Math.min(rows.length, MAX_POINTS);
    const sampled = Array.from({ length: count }, (_, i) => rows[count < 2 ? 0 : Math.floor(i * (rows.length - 1) / (count - 1))]);
    const series = sampled.map((row, index) => ({ t: row.t, pctLong: row.pctLong, membershipVersion: row.membershipVersion,
      membershipChanged: index > 0 && row.segment !== sampled[index - 1].segment }));
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
        if (btc.length > 0) this.lastBtc.set(interval, btc);
      } catch (error) {
        // Hyperliquid busy (the shared per-IP budget): draw the last candles
        // read at this size, cut to the window, instead of no BTC line.
        btc = (this.lastBtc.get(interval) ?? []).filter(([t]) => t >= from);
        this.logger.warn(`BTC candles unavailable${btc.length > 0 ? " (serving the last read)" : ""}: ${(error as Error).message}`);
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
