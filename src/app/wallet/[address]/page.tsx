import Link from "next/link";
import { notFound } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/Icon";
import { NoteEditor } from "@/components/NoteEditor";
import { TradesTable } from "@/components/TradesTable";
import { WalletCharts } from "@/components/WalletCharts";
import { DASH, dur, int, links, num, pct, short, signClass, sol, time } from "@/lib/format";
import type { Metrics } from "@/lib/metrics";
import type { PositionView } from "@/lib/views";
import { walletDetail } from "@/lib/views";

export const dynamic = "force-dynamic";

const SOURCE: Record<string, string> = { token_funnel: "Funnel", public_leaderboard: "Leaderboard", manual: "Manual" };
const STATUS: Record<PositionView["status"], string> = {
  complete: "up",
  open: "",
  "transferred out": "warn",
  "unknown cost": "warn",
};

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return { title: `Wallet ${short(address)}` };
}

function Tiles({ latest }: { latest: Metrics | undefined }) {
  const tile = (k: string, v: string, h: string, cls = "") => (
    <div className="tile" key={k}>
      <div className="k">{k}</div>
      <div className={`v ${cls}`}>{v}</div>
      <div className="h">{h}</div>
    </div>
  );
  if (!latest) return <div className="tiles">{tile("Snapshot", "none yet", "run the daily job")}</div>;
  return (
    <section className="tiles" aria-label="Latest metrics">
      {tile("Realized PnL", sol(latest.realized_pnl_sol), "SOL, complete round trips", signClass(latest.realized_pnl_sol))}
      {tile("Round trips", int(latest.trade_count), latest.trade_count < 30 ? "under 30: too few to trust" : "closed and complete")}
      {tile("Win rate", pct(latest.win_rate), "round trips in profit")}
      {tile("Max drawdown", num(latest.max_drawdown_sol), "SOL, realized curve")}
      {tile("Median hold", dur(latest.median_hold_seconds), "first buy to exit")}
      {tile("Entry age", dur(latest.median_entry_age_seconds), "after token creation")}
      {tile("Top win share", pct(latest.pnl_concentration), "largest win / all wins")}
      {tile("Unknown cost", pct(latest.unknown_cost_ratio), "of closed round trips")}
    </section>
  );
}

export default async function WalletPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const d = await walletDetail(address);
  if (!d) notFound();
  const latest = d.metrics.at(-1);
  return (
    <>
      <AppBar>
        <Link href="/" className="pill">
          <Icon name="back" size={14} />
          All wallets
        </Link>
      </AppBar>
      <main>
        <div className="detail-head">
          <span className="addr">{address}</span>
          <CopyButton value={address} label="Copy address" />
          <span className="badge">{SOURCE[d.wallet.discovered_via] ?? d.wallet.discovered_via}</span>
          <span className="links">
            <a href={links.solscanAccount(address)} target="_blank" rel="noreferrer">
              Solscan <Icon name="external" size={12} />
            </a>
            <a href={links.gmgn(address)} target="_blank" rel="noreferrer">
              GMGN <Icon name="external" size={12} />
            </a>
          </span>
          <span className="status">
            First seen {time(d.wallet.first_seen_at)} UTC
            {latest ? ` · snapshot ${latest.as_of_date}` : ""}
          </span>
        </div>

        <div className="card">
          <h2>Note</h2>
          <NoteEditor address={address} initial={d.note} />
        </div>

        <Tiles latest={latest} />
        <WalletCharts trades={d.trades} metrics={d.metrics} />

        <div className="card">
          <h2>
            Round trips <span className="muted">{int(d.positions.length)}</span>
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="text">Token</th>
                  <th>Opened (UTC)</th>
                  <th>Closed (UTC)</th>
                  <th>Hold</th>
                  <th>Cost SOL</th>
                  <th>Proceeds SOL</th>
                  <th>PnL SOL</th>
                  <th className="text">Status</th>
                </tr>
              </thead>
              <tbody>
                {d.positions.map((p) => (
                  <tr key={`${p.mint}-${p.position_seq}`}>
                    <td className="text">
                      <a href={links.solscanToken(p.mint)} target="_blank" rel="noreferrer" className="mono">{short(p.mint)}</a>
                    </td>
                    <td>{time(p.opened_at)}</td>
                    <td>{p.closed_at == null ? DASH : time(p.closed_at)}</td>
                    <td>{p.closed_at == null ? DASH : dur(p.closed_at - p.opened_at)}</td>
                    <td>{num(p.cost_sol)}</td>
                    <td>{p.closed_at == null ? DASH : num(p.proceeds_sol)}</td>
                    <td className={signClass(p.pnl_sol)}>{sol(p.pnl_sol)}</td>
                    <td className="text">
                      <span className={`badge ${STATUS[p.status]}`}>{p.status}</span>
                    </td>
                  </tr>
                ))}
                {!d.positions.length && (
                  <tr>
                    <td colSpan={8} className="empty">No round trips yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>
            Trades <span className="muted">{int(d.trades.length)}</span>
          </h2>
          <TradesTable trades={d.trades} />
        </div>
      </main>
    </>
  );
}
