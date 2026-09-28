"use client";

import { useMemo, useState } from "react";

import { dur, int, links, num, pct, price, short, time } from "@/lib/format";
import type { Metrics } from "@/lib/metrics";
import type { TradeView } from "@/lib/views";

import { Chart } from "./Chart";

const METRICS: Record<string, { label: string; fmt: (v: number) => string }> = {
  realized_pnl_sol: { label: "Realized PnL (SOL)", fmt: (v) => num(v) },
  win_rate: { label: "Win rate", fmt: pct },
  trade_count: { label: "Closed round trips", fmt: int },
  median_hold_seconds: { label: "Median hold", fmt: dur },
  max_drawdown_sol: { label: "Max drawdown (SOL)", fmt: (v) => num(v) },
  unknown_cost_ratio: { label: "Unknown cost share", fmt: pct },
  tx_per_active_hour: { label: "Tx per active hour", fmt: (v) => num(v, 1) },
};

export function WalletCharts({ trades, metrics }: { trades: TradeView[]; metrics: Metrics[] }) {
  // Tokens ordered by how often this wallet traded them.
  const mints = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of trades) counts.set(t.mint, (counts.get(t.mint) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [trades]);
  const [mint, setMint] = useState(mints[0]?.[0] ?? "");
  const [metric, setMetric] = useState("realized_pnl_sol");

  const priceOpts = useMemo(() => {
    const pick = trades.filter((t) => t.mint === mint && t.price_sol != null);
    const point = (t: TradeView) => ({
      x: t.block_time,
      y: t.price_sol,
      tip: `${int(Math.round(t.tokens))} tokens for ${num(t.sol)} SOL`,
    });
    return {
      series: [
        { name: "Buy", color: "var(--series-1)", points: pick.filter((t) => t.side === "buy").map(point) },
        { name: "Sell", color: "var(--series-2)", points: pick.filter((t) => t.side === "sell").map(point) },
      ],
      log: true,
      xFormat: (v: number, full: boolean, step: number) =>
        full ? `${time(v)} UTC` : step >= 86400 ? time(v).slice(5, 10) : time(v).slice(5, 16),
      yFormat: (v: number) => price(v),
      empty: "No SOL-priced trades on this token",
    };
  }, [trades, mint]);

  const metricOpts = useMemo(() => {
    const m = METRICS[metric];
    return {
      series: [{
        name: m.label,
        color: "var(--series-1)",
        line: true,
        points: metrics.map((r) => ({
          x: Date.parse(`${r.as_of_date}T00:00:00Z`) / 1000,
          y: r[metric as keyof Metrics] as number | null,
        })),
      }],
      xFormat: (v: number) => new Date(v * 1000).toISOString().slice(0, 10),
      yFormat: (v: number) => m.fmt(v),
      minStep: 86400,
      empty: "No snapshots yet",
    };
  }, [metrics, metric]);

  return (
    <div className="row">
      <div className="card">
        <h2>Trades on one token</h2>
        <div className="controls">
          <label className="field">Token
            <select value={mint} onChange={(e) => setMint(e.target.value)}>
              {mints.map(([m, n]) => <option key={m} value={m}>{short(m)} · {n} trades</option>)}
            </select>
          </label>
          {mint && <a href={links.solscanToken(mint)} target="_blank" rel="noreferrer" className="status">Solscan ↗</a>}
        </div>
        <Chart options={priceOpts} />
        <p className="status">
          Price in SOL per token at each of this wallet&apos;s trades, log scale. It is the wallet&apos;s own fill
          prices, not the token&apos;s full price history.
        </p>
      </div>
      <div className="card">
        <h2>Metric over time</h2>
        <div className="controls">
          <label className="field">Metric
            <select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {Object.entries(METRICS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          </label>
        </div>
        <Chart options={metricOpts} />
        <p className="status">One point per daily snapshot, each computed only from data before that day.</p>
      </div>
    </div>
  );
}
