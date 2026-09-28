// Balance reconciliation: what our rows say a wallet holds vs what the chain says.
//
// A mismatch means rows are missing, whether a venue we did not parse or a
// transfer we did not see. It only proves anything for tokens whose whole life
// falls inside the fetched window; for older tokens the wallet may have held a
// balance before our history starts, so those rows are flagged, not trusted.
//
// Run it right after a fetch: a trade landing in between shows up as a diff.

import { QUOTE_MINTS } from "./constants";

export interface ReconciliationRow {
  wallet: string;
  mint: string;
  checked_at: number;
  derived_balance_raw: bigint;
  onchain_balance_raw: bigint;
  diff_raw: bigint;
  token_created_in_window: boolean | null;
}

/** {wallet: {mint: balance}} from every trade and transfer we hold. */
export function derivedBalances(
  trades: readonly { wallet: string; mint: string; side: string; token_amount_raw: bigint }[],
  transfers: readonly { wallet: string; mint: string; direction: string; token_amount_raw: bigint }[],
): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>();
  const add = (wallet: string, mint: string, amount: bigint) => {
    let m = out.get(wallet);
    if (!m) out.set(wallet, (m = new Map()));
    m.set(mint, (m.get(mint) ?? 0n) + amount);
  };
  for (const t of trades) add(t.wallet, t.mint, t.side === "buy" ? t.token_amount_raw : -t.token_amount_raw);
  for (const x of transfers) add(x.wallet, x.mint, x.direction === "in" ? x.token_amount_raw : -x.token_amount_raw);
  return out;
}

/** One row per non-quote mint seen on either side. */
export function compareBalances(
  wallet: string,
  derived: Map<string, Map<string, bigint>>,
  onchain: Map<string, bigint>,
  opts: { checkedAt: number; windowStart: number; tokens?: ReadonlyMap<string, number | null> },
): ReconciliationRow[] {
  const ours = derived.get(wallet) ?? new Map<string, bigint>();
  const mints = new Set<string>([...ours.keys()]);
  // Empty token accounts for mints we never saw traded are noise.
  for (const [m, v] of onchain) if (v !== 0n) mints.add(m);
  return [...mints]
    .filter((m) => !QUOTE_MINTS.has(m))
    .sort()
    .map((mint) => {
      const d = ours.get(mint) ?? 0n;
      const o = onchain.get(mint) ?? 0n;
      const created = opts.tokens?.get(mint);
      return {
        wallet,
        mint,
        checked_at: opts.checkedAt,
        derived_balance_raw: d,
        onchain_balance_raw: o,
        diff_raw: d - o,
        token_created_in_window:
          opts.tokens === undefined || created === undefined || created === null ? null : created >= opts.windowStart,
      };
    });
}

/** Share of (wallet, mint) that match, over all rows and over trusted ones. */
export function summarize(rows: readonly ReconciliationRow[]) {
  const share = (rs: readonly ReconciliationRow[]) =>
    rs.length ? rs.filter((r) => r.diff_raw === 0n).length / rs.length : null;
  const trusted = rows.filter((r) => r.token_created_in_window === true);
  return {
    rows: rows.length,
    match_rate: share(rows),
    trusted_rows: trusted.length,
    trusted_match_rate: share(trusted),
  };
}
