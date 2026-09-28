// Regression over the P1 golden samples in test/golden: each is a real
// transaction whose reading was checked against Helius's decoding (and, once
// ticked in docs/p1-golden.md, by hand on Solscan). The normalizer must keep
// reading them the same way.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { GoldenCase } from "../src/lib/golden";
import { walletDeltas } from "../src/lib/normalize";

const DIR = "test/golden";
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];

describe.skipIf(!files.length)("golden samples", () => {
  it("has both venues", () => {
    const venues = new Set(files.map((f) => f.split("-")[0]));
    expect([...venues].sort()).toEqual(["curve", "pumpswap"]);
  });

  for (const file of files) {
    it(file, () => {
      const c = JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as GoldenCase;
      expect(c.token_match).toBe(true);
      const [d] = walletDeltas(c.raw, c.wallet);
      const abs = (v: bigint) => (v < 0n ? -v : v);
      expect({
        mint: d.mint,
        side: d.side,
        token_amount_raw: abs(d.tokenAmountRaw).toString(),
        sol_lamports: abs(d.quoteAmountRaw!).toString(),
        fee_lamports: d.feeLamports.toString(),
      }).toEqual(c.ours);
    });
  }
});
