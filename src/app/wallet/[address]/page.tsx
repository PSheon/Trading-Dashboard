import Link from "next/link";
import { notFound } from "next/navigation";

import { NoteEditor } from "@/components/NoteEditor";
import { TradesTable } from "@/components/TradesTable";
import { WalletCharts } from "@/components/WalletCharts";
import { DASH, dur, int, links, num, pct, short, signClass, sol, time } from "@/lib/format";
import type { Metrics } from "@/lib/metrics";
import { walletDetail } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return { title: `Wallet ${short(address)}` };
}

function Tiles({ latest }: { latest: Metrics | undefined }) {
  const tile = (k: string, v: string, cls = "") => (
    <div className="tile" key={k}>
      <div className="k">{k}</div>
      <div className={`v ${cls}`}>{v}</div>
    </div>
  );
  if (!latest) return <div className="tiles">{tile("Snapshot", "none yet")}</div>;
  return (
    <div className="tiles">
      {tile("Realized PnL (SOL)", sol(latest.realized_pnl_sol), signClass(latest.realized_pnl_sol))}
      {tile("Round trips", int(latest.trade_count))}
      {tile("Win rate", pct(latest.win_rate))}
      {tile("Median hold", dur(latest.median_hold_seconds))}
      {tile("Top win share", pct(latest.pnl_concentration))}
      {tile("Unknown cost", pct(latest.unknown_cost_ratio))}
      {tile("As of", latest.as_of_date)}
    </div>
  );
}

export default async function WalletPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const d = await walletDetail(address);
  if (!d) notFound();
  return (
    <>
      <header className="bar">
        <Link href="/">← Wallets</Link>
        <h1 className="mono">{address}</h1>
        <span>
          <a href={links.solscanAccount(address)} target="_blank" rel="noreferrer">Solscan ↗</a>{" "}
          <a href={links.gmgn(address)} target="_blank" rel="noreferrer">GMGN ↗</a>
        </span>
        <span className="spacer" />
        <span className="status">
          Found via {d.wallet.discovered_via} · first seen {time(d.wallet.first_seen_at)} UTC
        </span>
      </header>
      <main>
        <div className="card">
          <h2>Note</h2>
          <NoteEditor address={address} initial={d.note} />
        </div>
        <Tiles latest={d.metrics.at(-1)} />
        <WalletCharts trades={d.trades} metrics={d.metrics} />
        <div className="card">
          <h2>Round trips <span className="muted">({int(d.positions.length)})</span></h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">Token</th><th>Opened</th><th>Closed</th><th>Hold</th>
                  <th>Cost (SOL)</th><th>Proceeds (SOL)</th><th>PnL (SOL)</th><th className="left">Status</th>
                </tr>
              </thead>
              <tbody>
                {d.positions.map((p) => (
                  <tr key={`${p.mint}-${p.position_seq}`}>
                    <td className="left">
                      <a href={links.solscanToken(p.mint)} target="_blank" rel="noreferrer" className="mono">{short(p.mint)}</a>
                    </td>
                    <td>{time(p.opened_at)}</td>
                    <td>{p.closed_at == null ? DASH : time(p.closed_at)}</td>
                    <td>{p.closed_at == null ? DASH : dur(p.closed_at - p.opened_at)}</td>
                    <td>{num(p.cost_sol)}</td>
                    <td>{p.closed_at == null ? DASH : num(p.proceeds_sol)}</td>
                    <td className={signClass(p.pnl_sol)}>{sol(p.pnl_sol)}</td>
                    <td className={`left ${p.status === "complete" ? "" : "muted"}`}>{p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h2>Trades <span className="muted">({int(d.trades.length)})</span></h2>
          <TradesTable trades={d.trades} />
        </div>
      </main>
    </>
  );
}
