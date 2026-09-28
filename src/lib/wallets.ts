// The wallet registry. Wallets are added and never removed.
//
// Dropping dead wallets would put survivorship bias straight into the data, so
// every save checks that no address that was there before has gone missing, and
// that nobody's `first_seen_at` has moved. Every change is a read-modify-write
// under the warehouse write lock, so a wallet added from the page while the
// daily job moves cursors is not overwritten.

import type { Warehouse } from "./store";

const DAY = 86_400;
const ACTIVE_DAYS = 30; // traded this recently → fetched daily
const DORMANT_EVERY_DAYS = 7; // otherwise → fetched weekly
const DAILY_MIN_GAP = 20 * 3600; // "daily" tolerates a cron that runs a bit early

export const VIA = ["token_funnel", "public_leaderboard", "manual"] as const;
export type Via = (typeof VIA)[number];

export interface WalletRow {
  address: string;
  first_seen_at: number;
  discovered_via: string;
  discovered_from_token: string | null;
  funnel_run_id: string | null;
  fetch_cursor_time: number | null;
  last_fetched_at: number | null;
  last_ingested_at: number | null;
  history_from: number | null;
}

export class RegistryError extends Error {}

export function loadWallets(wh: Warehouse): Promise<WalletRow[]> {
  return wh.read<WalletRow>("wallets");
}

/** Write the registry, refusing any change that loses a wallet or moves first_seen_at. */
export async function saveWallets(wh: Warehouse, before: readonly WalletRow[], after: readonly WalletRow[]) {
  const next = new Map(after.map((w) => [w.address, w]));
  const lost = before.filter((w) => !next.has(w.address)).map((w) => w.address);
  if (lost.length) throw new RegistryError(`wallets are never removed; would lose ${lost.slice(0, 5)}`);
  const moved = before.filter((w) => next.get(w.address)!.first_seen_at !== w.first_seen_at);
  if (moved.length) {
    throw new RegistryError(`first_seen_at is fixed; changed for ${moved.slice(0, 5).map((w) => w.address)}`);
  }
  await wh.write("wallets", [...after] as unknown as Record<string, unknown>[]);
}

/** Apply `change` to the registry as read inside the write lock. */
function update(wh: Warehouse, change: (before: WalletRow[]) => WalletRow[]): Promise<void> {
  return wh.locked(async () => {
    const before = await loadWallets(wh);
    await saveWallets(wh, before, change(before));
  });
}

/** Register addresses not yet known. Known ones are left exactly as they are. */
export async function addWallets(
  wh: Warehouse,
  addresses: readonly string[],
  opts: { via: string; now: number; fromToken?: string | null; funnelRunId?: string | null },
): Promise<string[]> {
  let fresh: string[] = [];
  await update(wh, (before) => {
    const known = new Set(before.map((w) => w.address));
    fresh = [...new Set(addresses)].filter((a) => !known.has(a));
    return [
      ...before,
      ...fresh.map((address) => ({
        address,
        first_seen_at: opts.now,
        discovered_via: opts.via,
        discovered_from_token: opts.fromToken ?? null,
        funnel_run_id: opts.funnelRunId ?? null,
        fetch_cursor_time: null,
        last_fetched_at: null,
        last_ingested_at: null,
        history_from: null,
      })),
    ];
  });
  return fresh;
}

const maxN = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
const minN = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** Store {address: [newest block time seen, fetched at, fetched from]}. */
export function recordFetch(
  wh: Warehouse,
  fetched: Record<string, [newest: number | null, fetchedAt: number, from: number | null]>,
): Promise<void> {
  return update(wh, (before) =>
    before.map((w) => {
      const f = fetched[w.address];
      if (!f) return w;
      return {
        ...w,
        // A fetch that saw nothing new keeps the old cursor.
        fetch_cursor_time: maxN(w.fetch_cursor_time, f[0]),
        last_fetched_at: f[1],
        history_from: minN(w.history_from, f[2]),
      };
    }),
  );
}

/** Record that these wallets were ingested by the run whose clock reads `at`. */
export function markIngested(wh: Warehouse, addresses: readonly string[], at: number): Promise<void> {
  const set = new Set(addresses);
  return update(wh, (before) => before.map((w) => (set.has(w.address) ? { ...w, last_ingested_at: at } : w)));
}

/** Wallets with raw data fetched after their last ingest, e.g. a job stopped in between. */
export function pendingIngest(registry: readonly WalletRow[]): string[] {
  return registry
    .filter((w) => w.last_fetched_at !== null && (w.last_ingested_at === null || w.last_fetched_at > w.last_ingested_at))
    .map((w) => w.address);
}

/** Wallets whose next fetch is due: never fetched, active daily, dormant weekly. */
export function dueWallets(registry: readonly WalletRow[], now: number): string[] {
  return registry
    .filter((w) => {
      if (w.last_fetched_at === null) return true;
      const since = now - w.last_fetched_at;
      const active = w.fetch_cursor_time !== null && w.fetch_cursor_time >= now - ACTIVE_DAYS * DAY;
      return active ? since >= DAILY_MIN_GAP : since >= DORMANT_EVERY_DAYS * DAY;
    })
    .map((w) => w.address);
}
