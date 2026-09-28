import path from "node:path";

import { describe, expect, it } from "vitest";

import { USDC_MINT } from "../src/lib/constants";
import { DuneClient } from "../src/lib/dune";
import { parseWallet } from "../src/lib/ingest";
import { SolUsd, syncSolUsd, walletsToConvert } from "../src/lib/prices";
import { appendRaw } from "../src/lib/rawStore";
import { Warehouse } from "../src/lib/store";
import { ATA, FEE, MINT, POOL, RENT, SOL, USDC_ACC, W, tb, tx } from "./fixtures";
import { tmpDir } from "./helpers";

const T = 1_790_000_000 - (1_790_000_000 % 60);

describe("SolUsd", () => {
  it("reads the minute, or the nearest one within five minutes", () => {
    const p = new SolUsd([{ minute: T, price: 120 }, { minute: T + 600, price: 130 }]);
    expect(p.at(T + 59)).toBe(120);
    expect(p.at(T + 240)).toBe(120); // 4 minutes on: nearest is T
    expect(p.at(T + 420)).toBe(130); // 3 minutes before T + 600
    expect(p.at(T + 2000)).toBeNull();
  });
});

describe("stablecoin conversion on ingest", () => {
  it("prices a USDC-quoted buy in SOL at that minute", async () => {
    const dir = tmpDir();
    const raw = tx({
      keys: [W, ATA, USDC_ACC, POOL],
      pre: [SOL, RENT, RENT, 0],
      post: [SOL - FEE, RENT, RENT, 0],
      preTok: [tb(1, MINT, W, 0), tb(2, USDC_MINT, W, 50_000_000)],
      postTok: [tb(1, MINT, W, 1000), tb(2, USDC_MINT, W, 26_000_000)],
      blockTime: T + 30,
      sig: "usdc-buy",
    });
    appendRaw(path.join(dir, "helius", "transaction-history", W, "a.jsonl.gz"), {
      source: "t", requestKey: "k", request: {},
      response: { data: [{ signature: "usdc-buy", parsed: { slot: 1, blockTime: T + 30 }, rawTransaction: raw }] },
    });
    const without = await parseWallet(dir, W, 0, null);
    expect([without.trades[0].sol_lamports, without.trades[0].sol_source]).toEqual([null, null]);
    const [t] = (await parseWallet(dir, W, 0, new SolUsd([{ minute: T, price: 120 }]))).trades;
    // 24 USDC at $120 per SOL = 0.2 SOL.
    expect([t.sol_lamports, t.sol_source, t.price_confidence]).toEqual([200_000_000n, "usd", "converted"]);
    expect(t.quote_amount_raw).toBe(24_000_000n);
  });
});

describe("syncSolUsd", () => {
  it("fetches only the minutes it does not hold, and knows whom to convert", async () => {
    const wh = new Warehouse(path.join(tmpDir(), "warehouse"));
    await wh.replaceWallets("trades", ["W"], [
      { tx_sig: "a", wallet: "W", mint: "M", side: "buy", token_amount_raw: 1n, quote_mint: USDC_MINT, quote_amount_raw: 5n, slot: 1, block_time: T + 10 },
    ]);
    const sqls: string[] = [];
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.endsWith("/sql/execute")) {
        sqls.push(JSON.parse(String(init?.body)).sql);
        return new Response(JSON.stringify({ execution_id: "e" }));
      }
      if (url.includes("/status")) return new Response(JSON.stringify({ state: "QUERY_STATE_COMPLETED" }));
      return new Response(JSON.stringify({ result: { rows: [{ minute: T, price: 121.5 }, { minute: T + 60, price: 122 }] } }));
    }) as typeof fetch;
    const dune = new DuneClient("k", { fetch: fetchImpl, pollMs: 0 });
    expect(await syncSolUsd(wh, dune, { now: T + 120 })).toEqual({ fetched: 2, minutes: 2 });
    expect(sqls[0]).toContain(`from_unixtime(${T})`);
    expect(sqls[0]).toContain("from_hex('069b8857");
    expect(await walletsToConvert(wh, [USDC_MINT])).toEqual(["W"]);
    // Next time only what came after the stored range is asked for.
    await syncSolUsd(wh, dune, { now: T + 600 });
    expect(sqls[1]).toContain(`from_unixtime(${T + 120})`);
  });
});
