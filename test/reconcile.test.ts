import { describe, expect, it } from "vitest";

import { WSOL_MINT } from "../src/lib/constants";
import { compareBalances, derivedBalances, summarize } from "../src/lib/reconcile";

describe("reconciliation", () => {
  it("nets trades and transfers into a derived balance", () => {
    const d = derivedBalances(
      [
        { wallet: "W", mint: "M", side: "buy", token_amount_raw: 100n },
        { wallet: "W", mint: "M", side: "sell", token_amount_raw: 30n },
        { wallet: "W", mint: "N", side: "buy", token_amount_raw: 5n },
      ],
      [{ wallet: "W", mint: "M", direction: "out", token_amount_raw: 20n }],
    );
    expect([...d.get("W")!]).toEqual([["M", 50n], ["N", 5n]]);
  });

  it("flags diffs and trusts only tokens born in the window", () => {
    const derived = new Map([["W", new Map([["M", 50n], ["N", 5n], ["SOLD", 0n]])]]);
    const onchain = new Map([["M", 50n], ["N", 7n], ["OLD", 9n], ["EMPTY", 0n], [WSOL_MINT, 123n]]);
    const tokens = new Map([["M", 200], ["N", 200], ["OLD", 50]]);
    const rows = compareBalances("W", derived, onchain, { checkedAt: 999, windowStart: 100, tokens });
    const by = Object.fromEntries(rows.map((r) => [r.mint, r]));
    // SOLD is kept (we saw it and it is flat on both sides); EMPTY and WSOL are noise.
    expect(Object.keys(by).sort()).toEqual(["M", "N", "OLD", "SOLD"]);
    expect(by.N.diff_raw).toBe(-2n);
    expect(by.OLD.token_created_in_window).toBe(false);
    expect(by.SOLD.token_created_in_window).toBeNull();
    const s = summarize(rows);
    expect([s.rows, s.trusted_rows, s.trusted_match_rate]).toEqual([4, 2, 0.5]);
  });
});
