import { recordAdminAudit, type AuditActor } from "../../common/audit/admin-audit.js";
import { UnitOfWork } from "../../db/unit-of-work.js";
import { Injectable, NotFoundException } from "@nestjs/common";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import type {
  CoinDistributionEntry,
  EquityInterval,
  EquityPoint,
  Leader,
  LeaderDetailResponse,
  LeaderSummary,
  LeadersQuery,
  PublicLeader,
  PublicLeaderSummary,
  PatchLeaderRequest,
  PositionRow,
} from "@trading-dashboard/shared/contracts";
import { LeadersRepository } from "./leaders.repository.js";
import { RoundTripService } from "../../analytics/round-trip.service.js";
import type { AlertsScope } from "../../common/auth/alerts-scope.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const EQUITY_CURVE_WINDOW_DAYS = 30;

/** D2 Leaders table + D3 Leader detail + A3 manual leader management. */
@Injectable()
export class LeadersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: LeadersRepository,
    private readonly roundTrip: RoundTripService,
  ) {}

  /** `view: "admin"` (callers with `leaders.manage`) lists every leader
   * with notes and source; `"public"` only imported ones, projected. */
  findAll(query: LeadersQuery, view: "admin"): Promise<LeaderSummary[]>;
  findAll(query: LeadersQuery, view?: "public"): Promise<PublicLeaderSummary[]>;
  findAll(query: LeadersQuery, view?: "public" | "admin"): Promise<LeaderSummary[] | PublicLeaderSummary[]>;
  async findAll(query: LeadersQuery, view: "public" | "admin" = "public"): Promise<LeaderSummary[] | PublicLeaderSummary[]> {
    const rows = view === "admin" ? await this.repository.findListed(query) : await this.repository.findListedPublic(query);

    const result: Array<LeaderSummary | PublicLeaderSummary> = [];
    const now = Date.now();
    // Bound bind parameters and per-batch working sets; no concurrent per-leader fanout.
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200);
      const addresses = batch.map(row => row.address);
      const [metadata, trips] = await Promise.all([
        this.repository.summaryMetadata(addresses),
        this.roundTrip.reconstructRoundTripsMany(addresses),
      ]);
      const byAddress = new Map<string, typeof trips>();
      for (const trip of trips) {
        const list = byAddress.get(trip.address) ?? [];
        list.push(trip); byAddress.set(trip.address, list);
      }
      for (const leader of batch) {
        const all = byAddress.get(leader.address) ?? [];
        const month = all.filter(trip => trip.closeTs.getTime() >= now - 30 * DAY_MS);
        result.push({
          ...leader,
          chain: CHAIN_DEFAULT,
          ...(metadata.get(leader.address) ?? { rank: null, openPositionCount: 0, lastActionAt: null }),
          pnl7d: month.filter(trip => trip.closeTs.getTime() >= now - 7 * DAY_MS).reduce((sum, trip) => sum + trip.pnl, 0),
          pnl30d: month.reduce((sum, trip) => sum + trip.pnl, 0),
          winRate: month.length ? month.filter(trip => trip.pnl > 0).length / month.length : null,
          avgHoldTimeSeconds: all.length ? all.reduce((sum, trip) => sum + trip.holdTimeSeconds, 0) / all.length : null,
        });
      }
    }
    return result as LeaderSummary[] | PublicLeaderSummary[];
  }

  /** D3: current positions, fill history, self-stored equity curve, coin
   * distribution, and this address's alert history. */
  async findDetail(
    chain: string,
    address: string,
    equityInterval: EquityInterval,
    alertsScope: AlertsScope = "all",
    view: "public" | "admin" = "public",
  ): Promise<LeaderDetailResponse> {
    const row = await this.repository.findOne(chain, address);
    // A favorite-only leader is as unknown to the public as any address.
    if (!row || (view === "public" && row.source !== "import")) {
      throw new NotFoundException(`No leader ${chain}/${address}`);
    }
    const leader: Leader | PublicLeader = view === "admin" ? (row as unknown as Leader) : {
      chain: row.chain as PublicLeader["chain"], address: row.address, label: row.label, tier: row.tier as PublicLeader["tier"],
      active: row.active, firstSeenAt: row.firstSeenAt,
    };

    const [rank, positions, fillsHistory, equityCurve, alertsHistory, winRate] = await Promise.all([
      this.repository.latestRank(address),
      this.repository.currentPositions(chain, address),
      this.repository.fillsHistory(chain, address),
      this.equityCurve(chain, address, equityInterval),
      this.repository.alertsHistory(address, alertsScope),
      this.roundTrip.winRate(address, undefined, new Date(Date.now() - 30 * DAY_MS)),
    ]);

    const coinDistribution = this.coinDistributionFrom(positions);

    return {
      leader,
      rank,
      positions,
      fills: fillsHistory,
      equityCurve,
      coinDistribution,
      alerts: alertsHistory,
      winRate,
    };
  }

  private coinDistributionFrom(positions: PositionRow[]): CoinDistributionEntry[] {
    const notionalByCoin = new Map<string, number>();
    let total = 0;
    for (const p of positions) {
      if (p.entryPx === null) continue;
      const notional = Math.abs(Number(p.szi)) * Number(p.entryPx);
      notionalByCoin.set(p.coin, (notionalByCoin.get(p.coin) ?? 0) + notional);
      total += notional;
    }
    return [...notionalByCoin.entries()].map(([coin, notionalUsd]) => ({
      coin,
      notionalUsd,
      shareOfTotal: total === 0 ? 0 : notionalUsd / total,
    }));
  }

  /** §11 決策紀錄 "權益曲線顯示": stored at a flat 5-minute grain always;
   * the default detail-page view downsamples to one point per hour, with a
   * toggle to the raw 5-minute series — "儲存不降採樣，顯示才降". Downsampling
   * happens here (last snapshot in each hour bucket) rather than as a
   * second stored table, since the raw series stays cheap at this data
   * volume (one address, 30 days, 5-minute grain = ~8,640 rows). */
  private async equityCurve(chain: string, address: string, interval: EquityInterval): Promise<EquityPoint[]> {
    const since = new Date(Date.now() - EQUITY_CURVE_WINDOW_DAYS * DAY_MS);
    const rows = await this.repository.equityRows(chain, address, since);

    const windowed = rows.filter((r) => r.ts >= since);
    if (interval === "5m") return windowed;

    const byHour = new Map<string, (typeof windowed)[number]>();
    for (const row of windowed) {
      const bucket = new Date(row.ts);
      bucket.setUTCMinutes(0, 0, 0);
      byHour.set(bucket.toISOString(), row); // last row wins per bucket
    }
    return [...byHour.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  /** A3: update label/tier/notes/active. `active=false` alone is what
   * stops polling/snapshots — the Watcher re-reads `leaders` fresh every
   * cycle and filters on `active=true` there, so there's nothing else to
   * wire up here for that half of the acceptance criterion. */
  async update(chain: string, address: string, patch: PatchLeaderRequest, actor: AuditActor = null): Promise<Leader> {
    return this.uow.run(async (tx) => {
      const before = await this.repository.lockOne(tx, chain, address);
      if (!before) throw new NotFoundException(`No leader ${chain}/${address}`);
      const updated = await this.repository.update(tx, chain, address, patch);
      await recordAdminAudit(tx, actor, "leader.update", `${chain}/${address}`, before, updated);
      return updated as unknown as Leader;
    });
  }
}
