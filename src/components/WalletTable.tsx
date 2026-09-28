"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";

import { saveNote } from "@/app/actions";
import { ago, dur, int, links, num, pct, short, signClass, sol, time } from "@/lib/format";
import { NOTE_MAX_CHARS } from "@/lib/universe";
import type { WalletListRow } from "@/lib/views";

import { Icon } from "./Icon";

const LOW_SAMPLE = 30;

const SOURCE: Record<string, string> = { token_funnel: "Funnel", public_leaderboard: "Leaderboard", manual: "Manual" };

interface Column {
  key: keyof WalletListRow;
  label: string;
  text?: boolean; // left-aligned prose rather than a number
  metric?: boolean; // greyed out on too small a sample
  sortable?: boolean;
  className?: (r: WalletListRow) => string;
  render: (r: WalletListRow, now: number) => ReactNode;
}

const COLUMNS: Column[] = [
  {
    key: "address", label: "Wallet", text: true,
    render: (r) => (
      <span className="wallet-cell">
        <Link href={`/wallet/${r.address}`} className="mono">{short(r.address)}</Link>
        <a href={links.gmgn(r.address)} target="_blank" rel="noreferrer" className="muted" aria-label={`${r.address} on GMGN`} title="GMGN">
          <Icon name="external" size={13} />
        </a>
        {r.discovered_later && <span className="badge warn" title="Discovered after this snapshot">later</span>}
      </span>
    ),
  },
  { key: "discovered_via", label: "Source", text: true, render: (r) => <span className="badge">{SOURCE[r.discovered_via] ?? r.discovered_via}</span> },
  {
    key: "trade_count", label: "Round trips", metric: true,
    render: (r) => (
      <span className="num-cell">
        {(r.trade_count ?? 0) < LOW_SAMPLE && <span className="badge" title={`Fewer than ${LOW_SAMPLE} closed round trips`}>n&lt;{LOW_SAMPLE}</span>}
        {int(r.trade_count)}
      </span>
    ),
  },
  { key: "realized_pnl_sol", label: "PnL SOL", metric: true, className: (r) => signClass(r.realized_pnl_sol), render: (r) => sol(r.realized_pnl_sol) },
  { key: "win_rate", label: "Win rate", metric: true, render: (r) => pct(r.win_rate) },
  { key: "pnl_concentration", label: "Top win", metric: true, render: (r) => pct(r.pnl_concentration) },
  { key: "max_drawdown_sol", label: "Max DD", metric: true, render: (r) => num(r.max_drawdown_sol) },
  { key: "median_hold_seconds", label: "Hold", metric: true, render: (r) => dur(r.median_hold_seconds) },
  { key: "median_entry_age_seconds", label: "Entry age", metric: true, render: (r) => dur(r.median_entry_age_seconds) },
  { key: "pre_graduation_ratio", label: "Pre-grad", metric: true, render: (r) => pct(r.pre_graduation_ratio) },
  { key: "token_count", label: "Tokens", metric: true, render: (r) => int(r.token_count) },
  { key: "tx_per_active_hour", label: "Tx/h", metric: true, render: (r) => num(r.tx_per_active_hour, 1) },
  { key: "fees_sol", label: "Fees", metric: true, render: (r) => num(r.fees_sol) },
  { key: "unknown_cost_ratio", label: "Unknown", metric: true, render: (r) => pct(r.unknown_cost_ratio) },
  { key: "last_active_at", label: "Last active", render: (r, now) => ago(r.last_active_at, now) },
  { key: "first_seen_at", label: "Found", render: (r) => time(r.first_seen_at).slice(0, 10) },
  { key: "note", label: "Note", text: true, sortable: false, render: (r) => <NoteCell row={r} /> },
];

function NoteCell({ row }: { row: WalletListRow }) {
  const [status, setStatus] = useState<"" | "saved" | "failed">("");
  const [title, setTitle] = useState<string>();
  const [saved, setSaved] = useState(row.note);
  return (
    <input
      className={`note ${status}`}
      defaultValue={row.note}
      placeholder="Add a note…"
      aria-label={`Note for ${row.address}`}
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
      <div className="toolbar">
        <label className="field">
          <span>Snapshot</span>
          <select value={asOfDate ?? ""} onChange={(e) => router.push(`/?as_of=${e.target.value}`)}>
            {dates.length ? dates.map((d, i) => <option key={d} value={d}>{d}{i === 0 ? " (latest)" : ""}</option>) : <option value="">no snapshots</option>}
          </select>
        </label>
        <label className="field grow">
          <span>Search</span>
          <span className="search">
            <Icon name="search" />
            <input type="search" placeholder="Address or note" value={q} onChange={(e) => setQ(e.target.value)} />
          </span>
        </label>
        <label className="field">
          <span>Source</span>
          <select value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="">All sources</option>
            {Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Min round trips</span>
          <input type="number" min={0} value={minTrades} style={{ width: 110 }} onChange={(e) => setMinTrades(Number(e.target.value) || 0)} />
        </label>
        <label className="field">
          <span>Active within</span>
          <select value={activeDays} onChange={(e) => setActiveDays(Number(e.target.value))}>
            <option value={0}>Any time</option>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        {laterCount > 0 && (
          <label className="check" title="Wallets discovered after this snapshot were not known on that day">
            <input type="checkbox" checked={showLater} onChange={(e) => setShowLater(e.target.checked)} />
            Show {laterCount} found later
          </label>
        )}
        <span className="count">{visible.length} of {rows.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((c, i) => {
                const sorted = sort.key === c.key;
                const sortable = c.sortable !== false;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={[c.text && "text", sortable && "sortable", sorted && "sorted", i === 0 && "pin"].filter(Boolean).join(" ")}
                    aria-sort={sorted ? (sort.dir > 0 ? "ascending" : "descending") : undefined}
                    onClick={sortable ? () => setSort({ key: c.key, dir: sorted ? (-sort.dir as 1 | -1) : c.text ? 1 : -1 }) : undefined}
                  >
                    <span className="th-inner">
                      {c.label}
                      {sorted && <Icon name={sort.dir > 0 ? "up" : "down"} size={12} />}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.address}
                className={[(r.trade_count ?? 0) < LOW_SAMPLE && "low-sample", r.discovered_later && "later"].filter(Boolean).join(" ") || undefined}
              >
                {COLUMNS.map((c, i) => (
                  <td key={c.key} className={[c.text && "text", c.metric && "metric", i === 0 && "pin", c.className?.(r)].filter(Boolean).join(" ")}>
                    {c.render(r, now)}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty">No wallets yet. Add some below, then run the daily job.</td>
              </tr>
            )}
            {rows.length > 0 && !visible.length && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty">
                  No wallets match
                  {!showLater && laterCount > 0 ? `; ${laterCount} discovered after this snapshot are hidden` : ""}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="footnote">
        Greyed metrics: fewer than {LOW_SAMPLE} closed round trips, too few to trust. PnL counts only round trips whose
        cost and proceeds are both known.
      </p>
    </>
  );
}
