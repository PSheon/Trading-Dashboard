import { Injectable } from "@nestjs/common";
import { chartSnapshotsQuerySchema, type ChartSnapshotsResponse, type TraderWindow } from "@trading-dashboard/shared/contracts";

import { parseOr400 } from "../common/http/validation.js";
import { ChartSnapshotsRepository } from "./chart-snapshots.repository.js";

export const MAX_CHART_SNAPSHOTS = 60;
export const MAX_SNAPSHOT_POSITIONS = 20;
const SPAN_MS: Record<Exclude<TraderWindow, "allTime">, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * CopyDog's `chart-snapshots` (GET /api/hyperliquid/traders/:a/chart-snapshots,
 * read 2026-10-04: `{window, kind, coverageStartMs, snapshots: [{t, n, upnl,
 * positions: [{coin, szi, entryPx, markPx, notional, upnl}]}]}`), from the
 * snapshots the worker takes of watched traders every five minutes: a
 * database read, no Hyperliquid call.
 */
@Injectable()
export class ChartSnapshotsService {
  constructor(private readonly repository: ChartSnapshotsRepository) {}

  async read(address: string, query: unknown, now = new Date()): Promise<ChartSnapshotsResponse> {
    const { window, kind } = parseOr400(chartSnapshotsQuerySchema, query);
    const a = address.toLowerCase();
    const coverageStart = await this.repository.coverageStart(a);
    if (!coverageStart) return { address: a, window, kind, coverageStart: null, snapshots: [] };
    const from = new Date(Math.max(coverageStart.getTime(), window === "allTime" ? 0 : now.getTime() - SPAN_MS[window]));
    const bucketMs = Math.max(60_000, Math.ceil((now.getTime() - from.getTime()) / MAX_CHART_SNAPSHOTS));
    const rows = await this.repository.positionsByBucket(a, from, now, bucketMs);
    const byTime = new Map<number, ChartSnapshotsResponse["snapshots"][number]["positions"]>();
    for (const r of rows) {
      const t = r.ts.getTime();
      const list = byTime.get(t) ?? [];
      byTime.set(t, list);
      if (r.coin === null) continue;
      const szi = num(r.szi) ?? 0;
      const entryPx = num(r.entryPx);
      const upnl = num(r.upnl);
      const markPx = entryPx !== null && upnl !== null && szi !== 0 ? entryPx + upnl / szi : null;
      list.push({ coin: r.coin, szi, entryPx, markPx, notional: markPx === null ? null : Math.abs(szi) * markPx, upnl });
    }
    const snapshots = [...byTime.entries()].map(([t, positions]) => {
      const sorted = positions.sort((x, y) => (y.notional ?? -1) - (x.notional ?? -1));
      const upnl = positions.every((p) => p.upnl !== null) ? positions.reduce((s, p) => s + p.upnl!, 0) : null;
      return { t, n: positions.length, upnl, positions: sorted.slice(0, MAX_SNAPSHOT_POSITIONS) };
    });
    return { address: a, window, kind, coverageStart, snapshots };
  }
}
