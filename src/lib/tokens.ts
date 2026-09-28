// The token table, approximated from Dune's dex_solana.trades.
//
// created_at   = the first bonding-curve trade (the dev buy shares the create
//                transaction; without one it is seconds late)
// graduated_at = the first PumpSwap trade at or after the last curve trade,
//                if it comes within MIGRATION_SECONDS of it (migration opens the
//                pool at once; a pool opened later on an abandoned curve is not
//                a graduation)
//
// A first curve trade within a day of the query window's start may be the
// window cutting it off, so that creation time is recorded as unknown.

import { litList, queryRows } from "./db";
import { MIGRATION_SECONDS } from "./funnel";
import type { DuneClient } from "./dune";
import { markDirty } from "./snapshots";
import type { Warehouse } from "./store";

const DAY = 86_400;
export const TOKEN_SOURCE = "dune:dex_solana.trades";

export interface TokenRow {
  mint: string;
  created_at: number | null;
  creator_address: string | null;
  create_tx_sig: string | null;
  create_slot: number | null;
  graduated_at: number | null;
  migration_venue: string | null;
  source: string;
  checked_at: number;
}

export function tokenSql(mints: readonly string[], lookbackDays: number): string {
  const list = litList(mints);
  const since = `now() - interval '${Math.floor(lookbackDays)}' day`;
  return `
WITH legs AS (
  SELECT token_bought_mint_address AS mint, project, block_time FROM dex_solana.trades
  WHERE block_time >= ${since} AND project IN ('pumpdotfun', 'pumpswap') AND token_bought_mint_address IN (${list})
  UNION ALL
  SELECT token_sold_mint_address AS mint, project, block_time FROM dex_solana.trades
  WHERE block_time >= ${since} AND project IN ('pumpdotfun', 'pumpswap') AND token_sold_mint_address IN (${list})
),
curve AS (
  SELECT mint, min(block_time) AS first_curve, max(block_time) AS last_curve
  FROM legs WHERE project = 'pumpdotfun' GROUP BY mint
)
SELECT c.mint,
       to_unixtime(c.first_curve) AS created_at,
       to_unixtime(min(l.block_time)) AS graduated_at
FROM curve c
LEFT JOIN legs l ON l.mint = c.mint AND l.project = 'pumpswap' AND l.block_time >= c.last_curve
                 AND l.block_time <= c.last_curve + interval '${MIGRATION_SECONDS}' second
GROUP BY c.mint, c.first_curve`;
}

/** Which mints to ask about: never asked, or young and not yet graduated. */
export function tokenCandidates(mints: readonly string[], known: ReadonlyMap<string, TokenRow>, now: number): string[] {
  return mints.filter((m) => {
    const t = known.get(m);
    if (!t) return true;
    const young = t.created_at !== null && t.created_at > now - 14 * DAY;
    return young && t.graduated_at === null && t.checked_at < now - DAY;
  });
}

export function toTokenRows(
  asked: readonly string[],
  found: readonly Record<string, unknown>[],
  opts: { now: number; lookbackDays: number },
): TokenRow[] {
  const windowStart = opts.now - opts.lookbackDays * DAY;
  const byMint = new Map(found.map((r) => [String(r.mint), r]));
  return asked.map((mint) => {
    const r = byMint.get(mint);
    const created = r?.created_at == null ? null : Math.floor(Number(r.created_at));
    const graduated = r?.graduated_at == null ? null : Math.floor(Number(r.graduated_at));
    const truncated = created !== null && created < windowStart + DAY;
    return {
      mint,
      created_at: truncated ? null : created,
      creator_address: null,
      create_tx_sig: null,
      create_slot: null,
      graduated_at: truncated ? null : graduated,
      migration_venue: graduated !== null && !truncated ? "pumpswap" : null,
      source: r ? TOKEN_SOURCE : `${TOKEN_SOURCE}:not-found`,
      checked_at: opts.now,
    };
  });
}

/** Ask Dune about new (and young, ungraduated) mints; mark affected snapshots stale. */
export async function syncTokens(
  wh: Warehouse,
  dune: DuneClient,
  opts: { now: number; lookbackDays?: number; batchSize?: number; maxBatches?: number },
) {
  const lookbackDays = opts.lookbackDays ?? 200;
  const batchSize = opts.batchSize ?? 500;
  const known = new Map((await wh.read<TokenRow>("tokens")).map((t) => [t.mint, t]));
  const mints = (
    await queryRows(
      `SELECT DISTINCT mint FROM (SELECT mint FROM ${wh.relation("trades")} UNION ALL SELECT mint FROM ${wh.relation("token_transfers")}) ORDER BY mint`,
    )
  ).map((r) => String(r.mint));
  const candidates = tokenCandidates(mints, known, opts.now).slice(0, batchSize * (opts.maxBatches ?? 4));
  const fetched: TokenRow[] = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const { rows } = await dune.run(tokenSql(batch, lookbackDays));
    fetched.push(...toTokenRows(batch, rows, { now: opts.now, lookbackDays }));
  }
  if (!fetched.length) return { asked: 0, found: 0, changed: 0 };

  const changed = await wh.locked(async () => {
    const current = new Map((await wh.read<TokenRow>("tokens")).map((t) => [t.mint, t]));
    const moved = fetched
      .filter((t) => {
        const c = current.get(t.mint);
        return !c || c.created_at !== t.created_at || c.graduated_at !== t.graduated_at;
      })
      .map((t) => t.mint);
    for (const t of fetched) current.set(t.mint, t);
    await wh.write("tokens", [...current.values()] as unknown as Record<string, unknown>[]);
    if (moved.length) {
      // Entry age and pre-graduation share of these wallets' past days change.
      const affected = await queryRows(
        `SELECT wallet, min(block_time) AS t FROM (
           SELECT wallet, mint, block_time FROM ${wh.relation("trades")}
           UNION ALL SELECT wallet, mint, block_time FROM ${wh.relation("token_transfers")}
         ) WHERE mint IN (${litList(moved)}) GROUP BY wallet`,
      );
      await markDirty(wh, new Map(affected.map((r) => [String(r.wallet), Number(r.t)])));
    }
    return moved.length;
  });
  return { asked: fetched.length, found: fetched.filter((t) => t.source === TOKEN_SOURCE).length, changed };
}
