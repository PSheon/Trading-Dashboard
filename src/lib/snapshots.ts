// wallet_metrics_daily as an incrementally maintained view.
//
// A day's snapshot is a pure function of rows with block_time before that day,
// so a stored file is only a cache and must always equal a recompute. Anything
// that changes a wallet's past rows (a repair, a late transaction, a dormant
// wallet fetched a week later, a new wallet's backfill, a token's graduation
// learned later) records the earliest affected block time in snapshot_dirty;
// maintenance recomputes exactly those wallets on exactly the days after it.

import { lit } from "./db";
import { bound, compute, type Metrics } from "./metrics";
import type { Warehouse } from "./store";
import { loadWallets } from "./wallets";

const DAY = 86_400;

export const dayOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const nextDay = (day: string) => dayOf(bound(day) + DAY);

export function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = nextDay(d)) out.push(d);
  return out;
}

interface DirtyRow {
  wallet: string;
  changed_from: number;
}

/** Merge {wallet: earliest changed block time} into snapshot_dirty. */
export function markDirty(wh: Warehouse, changes: ReadonlyMap<string, number>): Promise<void> {
  if (!changes.size) return Promise.resolve();
  return wh.locked(async () => {
    const merged = new Map((await wh.read<DirtyRow>("snapshot_dirty")).map((r) => [r.wallet, r.changed_from]));
    for (const [wallet, t] of changes) merged.set(wallet, Math.min(merged.get(wallet) ?? t, t));
    await wh.write(
      "snapshot_dirty",
      [...merged].map(([wallet, changed_from]) => ({ wallet, changed_from })),
    );
  });
}

/**
 * Per wallet, the earliest block time among rows that differ between `before`
 * and `after` (compared as multisets of `signature`). Rows only in one side
 * count, so additions, removals and edits all show up.
 */
export function changedFrom<T extends { wallet: string; block_time: number }>(
  before: readonly T[],
  after: readonly T[],
  signature: (row: T) => string,
): Map<string, number> {
  const counts = new Map<string, { n: number; row: T }>();
  for (const r of before) {
    const k = signature(r);
    const c = counts.get(k);
    counts.set(k, { n: (c?.n ?? 0) + 1, row: r });
  }
  for (const r of after) {
    const k = signature(r);
    const c = counts.get(k);
    counts.set(k, { n: (c?.n ?? 0) - 1, row: r });
  }
  const out = new Map<string, number>();
  for (const { n, row } of counts.values()) {
    if (n === 0) continue;
    out.set(row.wallet, Math.min(out.get(row.wallet) ?? row.block_time, row.block_time));
  }
  return out;
}

function inputs(wh: Warehouse, wallets?: readonly string[]) {
  return {
    trades: wh.relation("trades"),
    positions: wh.relation("positions"),
    tokens: wh.files("tokens").length ? wh.relation("tokens") : null,
    wallets,
  };
}

/** Recompute one whole day and store it. */
export async function snapshotDay(wh: Warehouse, day: string): Promise<number> {
  return wh.locked(async () => {
    const rows = await compute(day, inputs(wh));
    await wh.writeDay("wallet_metrics_daily", day, rows as unknown as Record<string, unknown>[]);
    return rows.length;
  });
}

/**
 * Bring every stored day up to date and fill every missing day, from the day
 * after the earliest history through `today`. Missing days are computed
 * whole; stored days recompute only their stale wallets.
 */
export function maintainSnapshots(wh: Warehouse, today: string) {
  return wh.locked(async () => {
    const stored = wh.days("wallet_metrics_daily").sort();
    // Every day from the one after the earliest history through today should
    // exist; a new wallet with older history widens that range backwards.
    const froms = (await loadWallets(wh)).map((w) => w.history_from).filter((t): t is number => t !== null);
    const first = froms.length ? nextDay(dayOf(Math.min(...froms))) : today;
    const have = new Set(stored);
    const missing = (first <= today ? dayRange(first, today) : []).filter((d) => !have.has(d));
    for (const day of missing) {
      const rows = await compute(day, inputs(wh));
      await wh.writeDay("wallet_metrics_daily", day, rows as unknown as Record<string, unknown>[]);
    }

    const dirty = await wh.read<DirtyRow>("snapshot_dirty");
    let updated = 0;
    for (const day of stored) {
      const stale = dirty.filter((d) => d.changed_from < bound(day)).map((d) => d.wallet);
      if (!stale.length) continue;
      const rows = await compute(day, inputs(wh, stale));
      await wh.replaceWalletsInDay("wallet_metrics_daily", day, stale, rows as unknown as Record<string, unknown>[]);
      updated += 1;
    }
    if (dirty.length) await wh.write("snapshot_dirty", []);
    return { filled_days: missing.length, updated_days: updated, stale_wallets: dirty.length };
  });
}

/** Recompute a stored day from scratch and list the wallets whose rows differ. */
export async function verifyDay(wh: Warehouse, day: string) {
  bound(day); // validates the date
  const stored = await wh.read<Metrics>("wallet_metrics_daily", `as_of_date = DATE ${lit(day)}`);
  const fresh = await compute(day, inputs(wh));
  const key = (m: Metrics) => JSON.stringify(m);
  const a = new Map(stored.map((m) => [m.wallet, key(m)]));
  const b = new Map(fresh.map((m) => [m.wallet, key(m)]));
  const wallets = new Set([...a.keys(), ...b.keys()]);
  const mismatched = [...wallets].filter((w) => a.get(w) !== b.get(w)).sort();
  return { day, stored: stored.length, recomputed: fresh.length, mismatched };
}
