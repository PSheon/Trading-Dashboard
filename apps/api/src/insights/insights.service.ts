import { Injectable } from "@nestjs/common";
import { type CrowdCoin, type CrowdResponse } from "@trading-dashboard/shared/contracts";

import { InsightsRepository } from "./insights.repository.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { DAY_MS } from '../config/constants/time.js';
import { CROWD_TTL_MS, INSIGHTS_SNAPSHOT_MAX_AGE_MS } from '../config/constants/cache-ttls.js';


/** |szi| × mark at snapshot time, from szi × entry + uPnL (no separate price
 * source); null when any input is unavailable. */
export function snapshotNotional(szi: number, entryPx: number | null, unrealizedPnl: number | null): number | null {
  if (entryPx === null || unrealizedPnl === null || ![szi, entryPx, unrealizedPnl].every(Number.isFinite)) return null;
  const value = Math.abs(szi * entryPx + unrealizedPnl);
  return Number.isFinite(value) ? value : null;
}

const numOrNull = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The crowd view (§10, 競品分析 §3.4): what the tracked traders hold, per
 * coin, from position snapshots.
 */
@Injectable()
export class InsightsService {
  readonly cache = new TtlCache<CrowdResponse>(CROWD_TTL_MS, 1);

  constructor(private readonly repository: InsightsRepository) {}

  crowd(): Promise<CrowdResponse> {
    return this.cache.get("crowd", () => this.computeCrowd(new Date()));
  }

  /**
   * Current and 24 h-ago snapshot sets (within `INSIGHTS_SNAPSHOT_MAX_AGE_MS`).
   * An address is in a set through its `equity_snapshots` row (written even when
   * flat); its positions are the `position_snapshots` rows with the same `ts`.
   * Exposure change uses only addresses in both sets (missing is not flat) and
   * includes price movement; the legacy prior total only for identical cohorts.
   */
  async computeCrowd(now: Date): Promise<CrowdResponse> {
    const [current, past] = await Promise.all([
      this.repository.snapshotSet(now, now.getTime() - INSIGHTS_SNAPSHOT_MAX_AGE_MS, now.getTime()),
      this.repository.snapshotSet(
        new Date(now.getTime() - DAY_MS),
        now.getTime() - DAY_MS - INSIGHTS_SNAPSHOT_MAX_AGE_MS,
        now.getTime() - DAY_MS + INSIGHTS_SNAPSHOT_MAX_AGE_MS,
      ),
    ]);

    const coins = new Map<
      string,
      { longNotional: number | null; shortNotional: number | null; long: Set<string>; short: Set<string> }
    >();
    for (const row of current.rows) {
      const szi = numOrNull(row.szi);
      if (row.coin === null || szi === null || szi === 0) continue;
      const notional = snapshotNotional(szi, numOrNull(row.entry_px), numOrNull(row.unrealized_pnl));
      let agg = coins.get(row.coin);
      if (!agg) coins.set(row.coin, (agg = { longNotional: 0, shortNotional: 0, long: new Set(), short: new Set() }));
      if (szi > 0) {
        agg.longNotional = agg.longNotional === null || notional === null ? null : agg.longNotional + notional;
        agg.long.add(row.address);
      } else {
        agg.shortNotional = agg.shortNotional === null || notional === null ? null : agg.shortNotional + notional;
        agg.short.add(row.address);
      }
    }

    const currentAddresses = new Set(current.rows.map(row => row.address));
    const pastAddresses = new Set(past.rows.map(row => row.address));
    const matched = new Set([...currentAddresses].filter(address => pastAddresses.has(address)));
    const sameCohort = matched.size > 0 && matched.size === currentAddresses.size && matched.size === pastAddresses.size;
    const unpriced = new Set<string>();
    const currentMatched = new Map<string, number>();
    const pastMatched = new Map<string, number>();
    for (const row of current.rows) {
      if (!matched.has(row.address) || row.coin === null) continue;
      const szi = numOrNull(row.szi);
      if (szi === null) { unpriced.add(row.coin); continue; }
      if (szi === 0) continue;
      const notional = snapshotNotional(szi, numOrNull(row.entry_px), numOrNull(row.unrealized_pnl));
      if (notional === null) unpriced.add(row.coin);
      else currentMatched.set(row.coin, (currentMatched.get(row.coin) ?? 0) + Math.sign(szi) * notional);
    }
    const pastNet = new Map<string, number>();
    for (const row of past.rows) {
      const szi = numOrNull(row.szi);
      if (row.coin === null || szi === 0) continue;
      const notional = szi === null ? null : snapshotNotional(szi, numOrNull(row.entry_px), numOrNull(row.unrealized_pnl));
      if (notional === null || szi === null) {
        if (matched.has(row.address)) unpriced.add(row.coin);
        continue;
      }
      pastNet.set(row.coin, (pastNet.get(row.coin) ?? 0) + Math.sign(szi) * notional);
      if (matched.has(row.address)) pastMatched.set(row.coin, (pastMatched.get(row.coin) ?? 0) + Math.sign(szi) * notional);
      // Retain yesterday's positions even when every observed owner is now flat.
      if (!coins.has(row.coin)) coins.set(row.coin, { longNotional: 0, shortNotional: 0, long: new Set(), short: new Set() });
    }

    const out: CrowdCoin[] = [...coins].map(([coin, a]) => {
      const gross = (a.longNotional ?? 0) + (a.shortNotional ?? 0);
      return {
        coin,
        longNotional: a.longNotional,
        shortNotional: a.shortNotional,
        longTraders: a.long.size,
        shortTraders: a.short.size,
        netBias: a.longNotional === null || a.shortNotional === null ? null : gross > 0 ? (a.longNotional - a.shortNotional) / gross : 0,
        netNotional24hAgo: sameCohort && !unpriced.has(coin) ? (pastNet.get(coin) ?? 0) : null,
        netNotionalChange24h: !unpriced.has(coin) && (currentMatched.has(coin) || pastMatched.has(coin))
          ? (currentMatched.get(coin) ?? 0) - (pastMatched.get(coin) ?? 0) : null,
      };
    });
    out.sort(
      (x, y) => (y.longNotional ?? 0) + (y.shortNotional ?? 0) - ((x.longNotional ?? 0) + (x.shortNotional ?? 0)) || x.coin.localeCompare(y.coin),
    );

    return { trackedTraders: current.addresses, coins: out, updatedAt: current.latestTs,
      comparison: { currentTraders: currentAddresses.size, pastTraders: pastAddresses.size, matchedTraders: matched.size } };
  }

}
