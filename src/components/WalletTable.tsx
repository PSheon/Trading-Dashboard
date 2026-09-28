"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";

import { saveNote } from "@/app/actions";
import { ago, dur, int, links, num, pct, short, signClass, sol, time } from "@/lib/format";
import { NOTE_MAX_CHARS } from "@/lib/universe";
import type { WalletListRow } from "@/lib/views";

const LOW_SAMPLE = 30;

interface Column {
  key: keyof WalletListRow;
  label: string;
  left?: boolean;
  metric?: boolean;
  sortable?: boolean;
  className?: (r: WalletListRow) => string;
  render: (r: WalletListRow, now: number) => ReactNode;
}

const COLUMNS: Column[] = [
  {
    key: "address", label: "Wallet", left: true,
    render: (r) => (
      <span>
        <Link href={`/wallet/${r.address}`} className="mono">{short(r.address)}</Link>{" "}
        {r.discovered_later && <span className="muted" title="Discovered after this snapshot">(later) </span>}
        <a href={links.gmgn(r.address)} target="_blank" rel="noreferrer" className="muted" title="GMGN">↗</a>
      </span>
    ),
  },
  { key: "discovered_via", label: "Source", left: true, render: (r) => r.discovered_via },
  { key: "first_seen_at", label: "First seen", render: (r) => time(r.first_seen_at) },
  { key: "trade_count", label: "Trades", metric: true, render: (r) => int(r.trade_count) },
  { key: "token_count", label: "Tokens", metric: true, render: (r) => int(r.token_count) },
  { key: "realized_pnl_sol", label: "PnL (SOL)", metric: true, className: (r) => signClass(r.realized_pnl_sol), render: (r) => sol(r.realized_pnl_sol) },
  { key: "win_rate", label: "Win rate", metric: true, render: (r) => pct(r.win_rate) },
  { key: "pnl_concentration", label: "Top win share", metric: true, render: (r) => pct(r.pnl_concentration) },
  { key: "median_hold_seconds", label: "Median hold", metric: true, render: (r) => dur(r.median_hold_seconds) },
  { key: "median_entry_age_seconds", label: "Entry age", metric: true, render: (r) => dur(r.median_entry_age_seconds) },
  { key: "pre_graduation_ratio", label: "Pre-grad", metric: true, render: (r) => pct(r.pre_graduation_ratio) },
  { key: "tx_per_active_hour", label: "Tx / active h", metric: true, render: (r) => num(r.tx_per_active_hour, 1) },
  { key: "max_drawdown_sol", label: "Max DD (SOL)", metric: true, render: (r) => num(r.max_drawdown_sol) },
  { key: "fees_sol", label: "Fees (SOL)", metric: true, render: (r) => num(r.fees_sol) },
  { key: "unknown_cost_ratio", label: "Unknown cost", metric: true, render: (r) => pct(r.unknown_cost_ratio) },
  { key: "last_active_at", label: "Last active", render: (r, now) => ago(r.last_active_at, now) },
  { key: "note", label: "Note", left: true, sortable: false, render: (r) => <NoteCell row={r} /> },
];

function NoteCell({ row }: { row: WalletListRow }) {
  const [status, setStatus] = useState<"" | "saved" | "failed">("");
  const [title, setTitle] = useState<string>();
  const [saved, setSaved] = useState(row.note);
  return (
    <input
      className={`note ${status}`}
      defaultValue={row.note}
      placeholder="…"
      maxLength={NOTE_MAX_CHARS}
      title={title}
      onChange={() => setStatus("")}
      onBlur={async (e) => {
        if (e.target.value.trim() === saved) return;
        const res = await saveNote(row.address, e.target.value);
        if ("error" in res) {
          setStatus("failed");
          setTitle(res.error);
        } else {
          setSaved(res.note);
          setStatus("saved");
        }
      }}
    />
  );
}

export function WalletTable({ rows, now, dates, asOfDate }: { rows: WalletListRow[]; now: number; dates: string[]; asOfDate: string | null }) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: keyof WalletListRow; dir: 1 | -1 }>({ key: "realized_pnl_sol", dir: -1 });
  const [q, setQ] = useState("");
  const [via, setVia] = useState("");
  const [minTrades, setMinTrades] = useState(0);
  const [activeDays, setActiveDays] = useState(0);
  const [showLater, setShowLater] = useState(false);
  const laterCount = rows.filter((r) => r.discovered_later).length;

  const visible = useMemo(() => {
    const query = q.trim().toLowerCase();
    const cutoff = now - activeDays * 86400;
    return rows
      .filter((r) => !query || r.address.toLowerCase().includes(query) || r.note.toLowerCase().includes(query))
      .filter((r) => !via || r.discovered_via === via)
      .filter((r) => (r.trade_count ?? 0) >= minTrades)
      .filter((r) => !activeDays || (r.last_active_at ?? 0) >= cutoff)
      .filter((r) => showLater || !r.discovered_later)
      .sort((a, b) => {
        const va = a[sort.key] as number | string | null | undefined;
        const vb = b[sort.key] as number | string | null | undefined;
        if (va == null && vb == null) return 0;
        if (va == null) return 1; // missing values always last
        if (vb == null) return -1;
        return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
      });
  }, [rows, q, via, minTrades, activeDays, showLater, sort, now]);

  return (
    <>
      <div className="controls">
        <label className="field">Snapshot
          <select value={asOfDate ?? ""} onChange={(e) => router.push(`/?as_of=${e.target.value}`)}>
            {dates.length ? dates.map((d) => <option key={d} value={d}>{d}</option>) : <option value="">no snapshots</option>}
          </select>
        </label>
        <input type="search" placeholder="Search address or note" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="field">Source
          <select value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="">All</option>
            <option value="token_funnel">token_funnel</option>
            <option value="public_leaderboard">public_leaderboard</option>
            <option value="manual">manual</option>
          </select>
        </label>
        <label className="field">Min trades
          <input type="number" min={0} value={minTrades} style={{ width: 72 }} onChange={(e) => setMinTrades(Number(e.target.value) || 0)} />
        </label>
        <label className="field">Active within
          <select value={activeDays} onChange={(e) => setActiveDays(Number(e.target.value))}>
            <option value={0}>Any time</option>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        {laterCount > 0 && (
          <label className="field" title="Wallets discovered after this snapshot were not known on that day">
            <input type="checkbox" checked={showLater} onChange={(e) => setShowLater(e.target.checked)} />
            Show {laterCount} discovered later
          </label>
        )}
        <span className="status">{visible.length} of {rows.length} wallets</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const sorted = sort.key === c.key;
                const sortable = c.sortable !== false;
                return (
                  <th
                    key={c.key}
                    className={[c.left && "left", sortable && "sortable", sorted && "sorted"].filter(Boolean).join(" ")}
                    data-dir={sorted ? (sort.dir > 0 ? "▲" : "▼") : undefined}
                    onClick={sortable ? () => setSort({ key: c.key, dir: sorted ? (-sort.dir as 1 | -1) : c.left ? 1 : -1 }) : undefined}
                  >
                    {c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.address} className={(r.trade_count ?? 0) < LOW_SAMPLE ? "low-sample" : undefined}>
                {COLUMNS.map((c) => (
                  <td key={c.key} className={[c.left && "left", c.metric && "metric", c.className?.(r)].filter(Boolean).join(" ")}>
                    {c.render(r, now)}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={COLUMNS.length} className="left muted">No wallets yet. Add some below, then run the daily job.</td>
              </tr>
            )}
            {rows.length > 0 && !visible.length && (
              <tr>
                <td colSpan={COLUMNS.length} className="left muted">
                  No wallets match
                  {!showLater && laterCount > 0 ? `; ${laterCount} discovered after this snapshot are hidden` : ""}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="status">Rows with fewer than {LOW_SAMPLE} closed round trips are greyed out: too few to trust.</p>
    </>
  );
}
