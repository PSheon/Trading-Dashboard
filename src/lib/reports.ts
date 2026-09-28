// P1 acceptance (c): per-token realized PnL for a few wallets, laid out to be
// compared by hand with GMGN's wallet page (GMGN has no public API).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { litList, queryRows } from "./db";
import type { Warehouse } from "./store";

export async function pnlSheet(wh: Warehouse, wallets: readonly string[], file: string, perWallet = 10) {
  const rows = await queryRows(`
    SELECT wallet, mint,
           count(*) FILTER (WHERE complete) AS round_trips,
           count(*) FILTER (WHERE closed_at IS NOT NULL AND NOT complete) AS incomplete,
           sum(realized_pnl_lamports) FILTER (WHERE complete) / 1e9 AS pnl_sol,
           sum(cost_lamports) FILTER (WHERE complete) / 1e9 AS cost_sol,
           max(closed_at) AS last_closed
    FROM ${wh.relation("positions")}
    WHERE wallet IN (${litList(wallets)}) AND closed_at IS NOT NULL
    GROUP BY wallet, mint
    QUALIFY row_number() OVER (PARTITION BY wallet ORDER BY abs(coalesce(sum(realized_pnl_lamports) FILTER (WHERE complete), 0)) DESC, mint) <= ${perWallet}
    ORDER BY wallet, abs(coalesce(pnl_sol, 0)) DESC`);
  const lines = [
    "# P1 PnL check against GMGN",
    "",
    "Written for: whoever confirms P1 acceptance (c) by hand.",
    "",
    "For each wallet, the tokens with the largest realized PnL here. Open the GMGN link, find the token in the",
    "wallet's token list and compare its realized profit. Pass: within 10%, or the difference is explained (GMGN may",
    "count unrealized PnL, a different time window, or fees differently). `incomplete` round trips (tokens received",
    "by transfer, stablecoin-quoted) are left out of our number.",
    "",
  ];
  for (const w of wallets) {
    lines.push(`## [${w}](https://gmgn.ai/sol/address/${w})`, "", "| ✓ | Token | Round trips | Incomplete | Cost (SOL) | Realized PnL (SOL) | GMGN | Last closed (UTC) |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of rows.filter((x) => x.wallet === w)) {
      const mint = String(r.mint);
      const f = (v: unknown) => (v == null ? "–" : Number(v).toFixed(4));
      lines.push(
        `| [ ] | [${mint.slice(0, 6)}…](https://gmgn.ai/sol/token/${mint}) | ${r.round_trips} | ${r.incomplete} | ${f(r.cost_sol)} | ${f(r.pnl_sol)} |  | ${new Date(Number(r.last_closed) * 1000).toISOString().slice(0, 16).replace("T", " ")} |`,
      );
    }
    lines.push("");
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  return { wallets: wallets.length, rows: rows.length, file };
}
