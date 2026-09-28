import path from "node:path";

import { describe, expect, it } from "vitest";

import { DuneClient } from "../src/lib/dune";
import { DEFAULT_FUNNEL, funnelSql, parseFunnel, runFunnel } from "../src/lib/funnel";
import { Warehouse } from "../src/lib/store";
import { loadWallets } from "../src/lib/wallets";
import { tmpDir } from "./helpers";

const ROWS = [
  { kind: "stats", count_a: 100, count_b: 7, value_a: 600, value_b: 9000 },
  { kind: "token", mint: "T1", created_at: 10.5, graduated_at: 20.2, peak_at: 30, value_a: 5000 },
  { kind: "token", mint: "T2", created_at: 11, graduated_at: 21, peak_at: 31, value_a: 8000 },
  { kind: "wallet", wallet: "WB", count_a: 3, count_b: 40, value_a: 2.5, first_token: "T1" },
  { kind: "wallet", wallet: "WA", count_a: 5, count_b: 90, value_a: 9.0, first_token: "T2" },
];

function fakeDune(rows: unknown[]) {
  const fetchImpl = (async (u: string | URL | Request) => {
    const url = String(u);
    if (url.endsWith("/sql/execute")) return new Response(JSON.stringify({ execution_id: "e1" }));
    if (url.includes("/status")) return new Response(JSON.stringify({ state: "QUERY_STATE_COMPLETED" }));
    return new Response(JSON.stringify({ result: { rows } }));
  }) as typeof fetch;
  return new DuneClient("k", { fetch: fetchImpl, pollMs: 0 });
}

describe("funnel", () => {
  it("puts every parameter into the query", () => {
    const sql = funnelSql({ ...DEFAULT_FUNNEL, lookbackDays: 7, minPeakMcapSol: 1234, minWins: 4, maxWallets: 9, maxTradesPerDay: 10, minHourVolumeSol: 3 });
    expect(sql).toContain("interval '7' day");
    expect(sql).toContain("interval '37' day"); // curve trades read 30 days further back
    expect(sql).toContain(">= 1234");
    expect(sql).toContain(">= 4");
    expect(sql).toContain("LIMIT 9");
    expect(sql).toContain("<= 70"); // 10 trades a day over 7 days
    expect(sql).toContain(">= 3");
    expect(sql).toContain("token_sold_amount_raw"); // not Dune's decimal-adjusted amount
  });

  it("parses stats, tokens and ranked wallets", () => {
    const r = parseFunnel(ROWS);
    expect(r.stats).toEqual({ graduated: 100, winners: 7, peak_p50_sol: 600, peak_p90_sol: 9000 });
    expect(r.tokens.map((t) => [t.mint, t.created_at, t.peak_mcap_sol])).toEqual([["T2", 11, 8000], ["T1", 10, 5000]]);
    expect(r.wallets.map((w) => [w.rank, w.wallet, w.wins, w.pnl_sol])).toEqual([[1, "WA", 5, 9], [2, "WB", 3, 2.5]]);
  });

  it("records the run and registers its wallets; a dry run touches nothing", async () => {
    const wh = new Warehouse(path.join(tmpDir(), "warehouse"));
    const dry = await runFunnel(wh, fakeDune(ROWS), { now: 1_800_000_000, dryRun: true });
    expect([dry.run_id, dry.added, (await loadWallets(wh)).length]).toEqual([null, [], 0]);

    const r = await runFunnel(wh, fakeDune(ROWS), { now: 1_800_000_000 });
    expect(r.added).toEqual(["WA", "WB"]);
    const reg = await loadWallets(wh);
    expect(reg.map((w) => [w.address, w.discovered_via, w.discovered_from_token, w.funnel_run_id])).toEqual([
      ["WA", "token_funnel", "T2", r.run_id],
      ["WB", "token_funnel", "T1", r.run_id],
    ]);
    expect(await wh.read("funnel_tokens")).toHaveLength(2);
    const [run] = await wh.read<{ execution_id: string; wallets: number }>("funnel_runs");
    expect([run.execution_id, run.wallets]).toEqual(["e1", 2]);
    // A second run keeps each wallet's original discovery.
    const again = await runFunnel(wh, fakeDune(ROWS), { now: 1_800_086_400 });
    expect(again.added).toEqual([]);
    expect((await loadWallets(wh))[0].funnel_run_id).toBe(r.run_id);
  });
});
