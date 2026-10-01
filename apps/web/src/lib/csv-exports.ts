import type { TraderFill } from "@/lib/contracts";
import { downloadCsv, toCsv } from "@/lib/csv";

/** A trader's fills as CSV (競品分析 §3.10: your data, portable). CopyDog
 * has no export, so the button lives on the /dev extras screen only. */
export function exportFills(address: string, rows: TraderFill[]) {
  downloadCsv(
    `${address}-fills.csv`,
    toCsv(
      ["time_utc", "tid", "coin", "side", "dir", "px", "sz", "notional_usd", "fee", "closed_pnl", "start_position", "liquidation", "twap_id"],
      rows.map((f) => [
        new Date(f.ts).toISOString(),
        f.tid,
        f.coin,
        f.side,
        f.dir,
        f.px,
        f.sz,
        f.notionalUsd,
        f.fee,
        f.closedPnl,
        f.startPosition ?? null,
        f.liquidation ? "true" : "false",
        f.twapId ?? null,
      ]),
    ),
  );
}
