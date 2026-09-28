import { AddWallets } from "@/components/AddWallets";
import { AppBar } from "@/components/AppBar";
import { JobControl } from "@/components/JobControl";
import { WalletTable } from "@/components/WalletTable";
import { int, pct } from "@/lib/format";
import { server } from "@/lib/server";
import { listDates, walletList, type WalletListRow } from "@/lib/views";

// Reads the warehouse on every request; nothing here is prerendered.
export const dynamic = "force-dynamic";

const LOW_SAMPLE = 30;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function Kpis({ rows }: { rows: WalletListRow[] }) {
  const known = rows.filter((r) => !r.discovered_later);
  const scored = known.filter((r) => (r.trade_count ?? 0) >= LOW_SAMPLE);
  const profitable = scored.filter((r) => (r.realized_pnl_sol ?? 0) > 0);
  const funnel = known.filter((r) => r.discovered_via === "token_funnel").length;
  const kpi = (k: string, v: string, h: string) => (
    <div className="kpi" key={k}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="h">{h}</div>
    </div>
  );
  return (
    <section className="kpis" aria-label="Summary">
      {kpi("Wallets", int(known.length), `${int(funnel)} from the funnel`)}
      {kpi("Scored", int(scored.length), `≥ ${LOW_SAMPLE} closed round trips`)}
      {kpi("Profitable", int(profitable.length), scored.length ? `${pct(profitable.length / scored.length)} of scored` : "none scored yet")}
      {kpi("Median win rate", pct(median(scored.map((r) => r.win_rate ?? 0))), "across scored wallets")}
    </section>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ as_of?: string }> }) {
  const { as_of } = await searchParams;
  const { asOfDate, rows, now, dataUpdatedAt } = await walletList(as_of);
  const dates = listDates();
  return (
    <>
      <AppBar>
        <JobControl initial={{ ...server().runner.state }} now={now} dataUpdatedAt={dataUpdatedAt} />
      </AppBar>
      <main>
        <div className="page-head">
          <div>
            <h1>Wallets</h1>
            <div className="sub">
              {asOfDate
                ? `Snapshot as of ${asOfDate} 00:00 UTC · every metric uses only data before then`
                : "No snapshots yet"}
            </div>
          </div>
        </div>
        <Kpis rows={rows} />
        <WalletTable rows={rows} now={now} dates={dates} asOfDate={asOfDate} />
        <AddWallets />
      </main>
    </>
  );
}
