import path from "node:path";

import { describe, expect, it } from "vitest";

import { DuneClient } from "../src/lib/dune";
import { markDirty } from "../src/lib/snapshots";
import { Warehouse } from "../src/lib/store";
import { syncTokens, TOKEN_SOURCE, tokenCandidates, type TokenRow, toTokenRows } from "../src/lib/tokens";
import { tmpDir } from "./helpers";

const DAY = 86_400;
const NOW = 1_800_000_000;

const row = (mint: string, over: Partial<TokenRow> = {}): TokenRow => ({
  mint, created_at: NOW - 30 * DAY, creator_address: null, create_tx_sig: null, create_slot: null,
  graduated_at: null, migration_venue: null, source: TOKEN_SOURCE, checked_at: NOW - 2 * DAY, ...over,
});

describe("token table", () => {
  it("asks about new mints and young ungraduated ones, not settled ones", () => {
    const known = new Map([
      ["old", row("old")],
      ["young", row("young", { created_at: NOW - 3 * DAY })],
      ["young_fresh", row("young_fresh", { created_at: NOW - 3 * DAY, checked_at: NOW - 60 })],
      ["graduated", row("graduated", { created_at: NOW - 3 * DAY, graduated_at: NOW - DAY })],
    ]);
    expect(tokenCandidates(["new", "old", "young", "young_fresh", "graduated"], known, NOW)).toEqual(["new", "young"]);
  });

  it("treats a creation at the window's edge as unknown and records misses", () => {
    const rows = toTokenRows(
      ["a", "edge", "missing"],
      [
        { mint: "a", created_at: NOW - 10 * DAY, graduated_at: NOW - 9 * DAY },
        { mint: "edge", created_at: NOW - 200 * DAY + 60, graduated_at: null },
      ],
      { now: NOW, lookbackDays: 200 },
    );
    expect(rows.map((r) => [r.mint, r.created_at, r.graduated_at, r.migration_venue, r.source])).toEqual([
      ["a", NOW - 10 * DAY, NOW - 9 * DAY, "pumpswap", TOKEN_SOURCE],
      ["edge", null, null, null, TOKEN_SOURCE],
      ["missing", null, null, null, `${TOKEN_SOURCE}:not-found`],
    ]);
  });

  it("syncs from Dune and marks the affected wallets' snapshots stale", async () => {
    const wh = new Warehouse(path.join(tmpDir(), "warehouse"));
    await wh.replaceWallets("trades", ["W"], [
      { tx_sig: "t", wallet: "W", mint: "M1", side: "buy", token_amount_raw: 1n, slot: 1, block_time: NOW - 5 * DAY },
    ]);
    await markDirty(wh, new Map());
    const sqls: string[] = [];
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.endsWith("/sql/execute")) {
        sqls.push(JSON.parse(String(init?.body)).sql);
        return new Response(JSON.stringify({ execution_id: "e" }));
      }
      if (url.includes("/status")) return new Response(JSON.stringify({ state: "QUERY_STATE_COMPLETED" }));
      return new Response(JSON.stringify({ result: { rows: [{ mint: "M1", created_at: NOW - 6 * DAY, graduated_at: NOW - 4 * DAY }] } }));
    }) as typeof fetch;
    const r = await syncTokens(wh, new DuneClient("k", { fetch: fetchImpl, pollMs: 0 }), { now: NOW });
    expect(r).toEqual({ asked: 1, found: 1, changed: 1 });
    expect(sqls[0]).toContain("'M1'");
    const [t] = await wh.read<TokenRow>("tokens");
    expect([t.created_at, t.graduated_at]).toEqual([NOW - 6 * DAY, NOW - 4 * DAY]);
    expect(await wh.read("snapshot_dirty")).toEqual([{ wallet: "W", changed_from: NOW - 5 * DAY }]);
    // Settled now: nothing more to ask.
    expect(await syncTokens(wh, new DuneClient("k", { fetch: fetchImpl, pollMs: 0 }), { now: NOW + 60 })).toEqual({ asked: 0, found: 0, changed: 0 });
  });
});
