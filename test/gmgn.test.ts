import { describe, expect, it } from "vitest";

import { type GmgnActivity, GmgnClient } from "../src/lib/gmgn";
import { compareWallet, summarizeChecks } from "../src/lib/gmgnCheck";
import type { TradeRow } from "../src/lib/ingest";
import { WSOL_MINT } from "../src/lib/constants";

const W = "Wallet1111111111111111111111111111111111111";

const trade = (sig: string, mint: string, side: "buy" | "sell", tokens: bigint, sol: bigint): TradeRow => ({
  tx_sig: sig, wallet: W, mint, side, token_amount_raw: tokens, decimals: 6, quote_mint: WSOL_MINT,
  quote_amount_raw: sol, sol_lamports: sol, sol_source: "swap", fee_lamports: 5000n, rent_lamports: 0n,
  price_sol: null, price_confidence: "normal", programs: [], slot: 1, tx_index: 0, block_time: 2_000, parser_version: 1, ingested_at: 0,
});

const act = (sig: string, mint: string, type: string, tokens: string, sol: string, timestamp = 2_000): GmgnActivity => ({
  tx_hash: sig, timestamp, event_type: type, token: { address: mint }, token_amount: tokens,
  quote_amount: sol, quote_token: { token_address: WSOL_MINT, symbol: "WSOL" }, cost_usd: null, price_usd: null,
});

describe("compareWallet", () => {
  it("matches on (signature, mint) and checks side and token amount", () => {
    const ours = [trade("a", "M1", "buy", 1_000_000n, 1_030_000_000n), trade("b", "M1", "sell", 2_000_000n, 960_000_000n)];
    const gmgn = [
      act("a", "M1", "buy", "1", "1"),
      act("b", "M1", "sell", "2.5", "1"), // token amount disagrees
      act("c", "M2", "sell", "1", "1"), act("c", "M3", "sell", "1", "1"), // a multi-token sell we mark complex
      act("d", "M1", "transferIn", "5", "0"), // not a trade
      act("e", "M1", "buy", "1", "1", 500), // before our history starts
    ];
    const c = compareWallet(W, ours, gmgn, 1_000);
    expect(c).toMatchObject({ ours: 2, gmgn: 4, matched: 2, side_agree: 2, tokens_exact: 1, tokens_fee: 0, gmgn_only: 2, gmgn_only_multi_token: 2 });
    expect(c.sol_median_diff).toBeCloseTo(0.04);
    const s = summarizeChecks([c]);
    expect(s).toMatchObject({ coverage: 1, side: 1, tokens: 0.5, pass: false });
  });

  it("nets GMGN's rows to (signature, token) and explains token-side fees", () => {
    const usdc = { ...trade("s", "M4", "buy", 1_000_000n, 5_000_000n), quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
    const ours = [
      trade("f", "M1", "buy", 990_000n, 1n), // GMGN: 1 token before a 1% fee
      trade("g", "M1", "sell", 1_000_000n, 1n), // GMGN: 0.97 reached the pool
      trade("n", "M2", "buy", 1_000_000n, 1n), // GMGN: bought 1.5, sold 0.5 in the same transaction
      usdc,
    ];
    const gmgn = [
      act("f", "M1", "buy", "1", "1"), act("g", "M1", "sell", "0.97", "1"),
      act("n", "M2", "buy", "1.5", "1"), act("n", "M2", "sell", "0.5", "1"),
    ];
    const c = compareWallet(W, ours, gmgn, 0);
    expect(c).toMatchObject({ ours: 3, ours_stable: 1, matched_stable: 0, gmgn: 3, matched: 3, side_agree: 3, tokens_exact: 1, tokens_fee: 2, gmgn_only: 0 });
  });
});

describe("GmgnClient", () => {
  it("signs each request, pages until older than since, and backs off on 429", async () => {
    const urls: URL[] = [];
    let calls = 0;
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      calls += 1;
      const url = new URL(String(input));
      urls.push(url);
      expect((init?.headers as Record<string, string>)["X-APIKEY"]).toBe("k");
      if (calls === 1) return new Response("slow down", { status: 429 });
      const cursor = url.searchParams.get("cursor");
      const page = cursor === null
        ? { activities: [act("a", "M", "buy", "1", "1", 3_000)], next: "p2" }
        : cursor === "p2"
          ? { activities: [act("b", "M", "buy", "1", "1", 900)], next: "p3" }
          : { activities: [act("c", "M", "buy", "1", "1", 100)], next: "" };
      return Response.json({ code: 0, data: page });
    }) as typeof globalThis.fetch;
    const client = new GmgnClient("k", { fetch, minIntervalMs: 0, backoffMs: 0 });
    const pages = [];
    for await (const p of client.walletActivity(W, { since: 1_000 })) pages.push(p);
    expect(pages.map((p) => p.activities[0].tx_hash)).toEqual(["a", "b"]);
    expect(client.rateLimited).toBe(1);
    expect(urls[1].searchParams.get("client_id")).not.toBe(urls[0].searchParams.get("client_id"));
    expect(urls.every((u) => u.pathname === "/v1/user/wallet_activity" && u.searchParams.get("timestamp"))).toBe(true);
  });

  it("raises GMGN's error codes", async () => {
    const fetch = (async () => Response.json({ code: 40001, msg: "bad key" })) as unknown as typeof globalThis.fetch;
    const client = new GmgnClient("k", { fetch, minIntervalMs: 0 });
    await expect(client.walletActivity(W).next()).rejects.toThrow(/40001/);
  });
});
