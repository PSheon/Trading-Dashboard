// SOL/USD by the minute, for trades quoted in a stablecoin.
//
// Source: Dune prices.usd, filtered by the WSOL contract (symbols are not
// unique there: a fake "USDC" trades at 0.0000036). Stablecoins are taken at
// $1; USDC and USDT averaged 0.9999 over the sample checked.

import { litList, queryRows } from "./db";
import type { DuneClient } from "./dune";
import type { Warehouse } from "./store";

export const SOL_PRICE_SOURCE = "dune:prices.usd";
// WSOL's mint as the hex Dune stores in contract_address.
const WSOL_HEX = "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001";
const MAX_GAP_SECONDS = 5 * 60; // use the nearest minute within this if one is missing

export class SolUsd {
  private readonly byMinute: Map<number, number>;
  constructor(rows: readonly { minute: number; price: number }[]) {
    this.byMinute = new Map(rows.map((r) => [r.minute, r.price]));
  }

  get size(): number {
    return this.byMinute.size;
  }

  /** USD per SOL at unix time t, or null when no minute within 5 minutes is known. */
  at(t: number): number | null {
    const m = Math.floor(t / 60) * 60;
    for (let d = 0; d <= MAX_GAP_SECONDS; d += 60) {
      const p = this.byMinute.get(m - d) ?? this.byMinute.get(m + d);
      if (p !== undefined) return p;
    }
    return null;
  }
}

export async function loadSolUsd(wh: Warehouse): Promise<SolUsd> {
  return new SolUsd(await wh.read<{ minute: number; price: number }>("sol_usd"));
}

export function solUsdSql(fromTs: number, toTs: number): string {
  return `SELECT to_unixtime(minute) AS minute, price
FROM prices.usd
WHERE blockchain = 'solana' AND contract_address = from_hex('${WSOL_HEX}')
  AND minute >= from_unixtime(${Math.floor(fromTs)}) AND minute < from_unixtime(${Math.floor(toTs)})`;
}

/**
 * Fetch every minute from the earliest trade we hold to now that is not stored
 * yet (before the stored range, after it, or both).
 */
export async function syncSolUsd(wh: Warehouse, dune: DuneClient, opts: { now: number }) {
  const [{ lo, hi }] = await queryRows(`SELECT min(minute) AS lo, max(minute) AS hi FROM ${wh.relation("sol_usd")}`);
  const [{ first }] = await queryRows(`SELECT min(block_time) AS first FROM ${wh.relation("trades")}`);
  if (first === null || first === undefined) return { fetched: 0, minutes: 0 };
  const want = Math.floor(Number(first) / 60) * 60;
  const ranges: [number, number][] = [];
  if (lo === null || lo === undefined) ranges.push([want, opts.now]);
  else {
    if (want < Number(lo)) ranges.push([want, Number(lo)]);
    ranges.push([Number(hi) + 60, opts.now]);
  }
  const fetched: { minute: number; price: number }[] = [];
  for (const [a, b] of ranges) {
    if (b <= a) continue;
    const { rows } = await dune.run(solUsdSql(a, b));
    for (const r of rows) fetched.push({ minute: Math.floor(Number(r.minute)), price: Number(r.price) });
  }
  if (!fetched.length) return { fetched: 0, minutes: 0 };
  const minutes = await wh.locked(async () => {
    const merged = new Map((await wh.read<{ minute: number; price: number }>("sol_usd")).map((r) => [r.minute, r.price]));
    for (const r of fetched) merged.set(r.minute, r.price);
    await wh.write("sol_usd", [...merged].map(([minute, price]) => ({ minute, price })));
    return merged.size;
  });
  return { fetched: fetched.length, minutes };
}

/** Wallets holding stablecoin-quoted trades that a known price could now convert. */
export async function walletsToConvert(wh: Warehouse, stableMints: readonly string[]): Promise<string[]> {
  if (!wh.files("sol_usd").length) return [];
  const rows = await queryRows(`
    SELECT DISTINCT t.wallet FROM ${wh.relation("trades")} t
    JOIN ${wh.relation("sol_usd")} p ON p.minute = (t.block_time // 60) * 60
    WHERE t.sol_lamports IS NULL AND t.quote_mint IN (${litList(stableMints)})`);
  return rows.map((r) => String(r.wallet)).sort();
}
