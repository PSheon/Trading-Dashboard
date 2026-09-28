import { describe, expect, it } from "vitest";

import { USDC_MINT, WSOL_MINT } from "../src/lib/constants";
import { accountKeys, walletDeltas } from "../src/lib/normalize";
import {
  ATA, ATA_B, FEE, MINT, MINT_B, OTHER, OTHER_ATA, POOL, RENT, SOL, TIP, USDC_ACC, W, WSOL_ACC, tb, tx,
} from "./fixtures";

const B = BigInt;

describe("walletDeltas", () => {
  it("splits a buy with a new token account into swap, fee and rent", () => {
    const raw = tx({
      keys: [W, ATA, POOL],
      pre: [10 * SOL, 0, 50 * SOL],
      post: [10 * SOL - SOL - FEE - RENT, RENT, 51 * SOL],
      postTok: [tb(1, MINT, W, 1000)],
    });
    const [d] = walletDeltas(raw, W);
    expect([d.kind, d.side, d.mint]).toEqual(["trade", "buy", MINT]);
    expect(d.tokenAmountRaw).toBe(1000n);
    expect(d.decimals).toBe(6);
    expect([d.quoteMint, d.quoteAmountRaw]).toEqual([WSOL_MINT, B(-SOL)]);
    expect(d.feeLamports).toBe(B(FEE));
    expect(d.rentLamports).toBe(B(RENT));
    expect([d.txSig, d.wallet, d.slot, d.blockTime]).toEqual(["sig1", W, 100, 1_700_000_000]);
  });

  it("counts WSOL as SOL when selling into an existing WSOL account", () => {
    const raw = tx({
      keys: [W, ATA, WSOL_ACC, POOL],
      pre: [SOL, RENT, RENT, 50 * SOL],
      post: [SOL - FEE, RENT, RENT + SOL / 2, 50 * SOL - SOL / 2],
      preTok: [tb(1, MINT, W, 1000), tb(2, WSOL_MINT, W, 0, 9)],
      postTok: [tb(1, MINT, W, 0), tb(2, WSOL_MINT, W, SOL / 2, 9)],
    });
    const [d] = walletDeltas(raw, W);
    expect([d.kind, d.side, d.tokenAmountRaw]).toEqual(["trade", "sell", -1000n]);
    expect(d.quoteAmountRaw).toBe(B(SOL / 2));
    expect(d.rentLamports).toBe(0n);
  });

  it("keeps rent returned by closing the token account outside the swap", () => {
    const raw = tx({
      keys: [W, ATA, POOL],
      pre: [SOL, RENT, 50 * SOL],
      post: [SOL + SOL / 2 + RENT - FEE, 0, 50 * SOL - SOL / 2],
      preTok: [tb(1, MINT, W, 1000)],
    });
    const [d] = walletDeltas(raw, W);
    expect([d.side, d.tokenAmountRaw, d.quoteAmountRaw]).toEqual(["sell", -1000n, B(SOL / 2)]);
    expect(d.rentLamports).toBe(B(-RENT));
  });

  it("treats a token moving without an opposite quote as a transfer on both sides", () => {
    const raw = tx({
      keys: [W, ATA, OTHER_ATA],
      pre: [SOL, RENT, RENT],
      post: [SOL - FEE, RENT, RENT],
      preTok: [tb(1, MINT, W, 1000), tb(2, MINT, OTHER, 0)],
      postTok: [tb(1, MINT, W, 0), tb(2, MINT, OTHER, 1000)],
    });
    const [out] = walletDeltas(raw, W);
    expect([out.kind, out.side, out.tokenAmountRaw, out.quoteMint]).toEqual(["transfer", null, -1000n, null]);
    // The receiver is not in the account keys at all; it is found through the owner field.
    const [inn] = walletDeltas(raw, OTHER);
    expect([inn.kind, inn.tokenAmountRaw, inn.feeLamports]).toEqual(["transfer", 1000n, 0n]);
  });

  it("still calls it a transfer when the sender pays for the receiver's token account", () => {
    const raw = tx({
      keys: [W, ATA, OTHER_ATA],
      pre: [SOL, RENT, 0],
      post: [SOL - FEE - RENT, RENT, RENT],
      preTok: [tb(1, MINT, W, 1000)],
      postTok: [tb(1, MINT, W, 0), tb(2, MINT, OTHER, 1000)],
    });
    expect(walletDeltas(raw, W)[0].kind).toBe("transfer");
  });

  it("counts a Jito tip paid by the wallet as a fee, not swap cost", () => {
    const tip = 1_000_000;
    const raw = tx({
      keys: [W, ATA, POOL, TIP],
      pre: [10 * SOL, 0, 50 * SOL, 0],
      post: [10 * SOL - SOL - FEE - RENT - tip, RENT, 51 * SOL, tip],
      postTok: [tb(1, MINT, W, 1000)],
    });
    const [d] = walletDeltas(raw, W);
    expect(d.quoteAmountRaw).toBe(B(-SOL));
    expect(d.feeLamports).toBe(B(FEE + tip));
  });

  it("resolves a tip account loaded from a lookup table", () => {
    const tip = 1_000_000;
    const raw = tx({
      keys: [W, ATA, POOL],
      pre: [10 * SOL, 0, 50 * SOL, 0],
      post: [10 * SOL - SOL - FEE - RENT - tip, RENT, 51 * SOL, tip],
      postTok: [tb(1, MINT, W, 1000)],
      loaded: { writable: [TIP], readonly: [] },
    });
    expect(accountKeys(raw)).toEqual([W, ATA, POOL, TIP]);
    expect(walletDeltas(raw, W)[0].feeLamports).toBe(B(FEE + tip));
  });

  it("reads jsonParsed account keys, which already include loaded addresses", () => {
    const raw = tx({
      keys: [
        { pubkey: W, signer: true, writable: true, source: "transaction" },
        { pubkey: TIP, signer: false, writable: true, source: "lookupTable" },
      ],
      pre: [SOL, 0],
      post: [SOL, 0],
      loaded: { writable: [TIP], readonly: [] },
    });
    expect(accountKeys(raw)).toEqual([W, TIP]);
  });

  it("produces nothing for a failed transaction", () => {
    const raw = tx({ keys: [W, ATA], pre: [SOL, 0], post: [SOL - FEE, 0], err: { InstructionError: [0, "Custom"] } });
    expect(walletDeltas(raw, W)).toEqual([]);
  });

  it("keeps the stablecoin amount and mint as the quote", () => {
    const raw = tx({
      keys: [W, ATA, USDC_ACC, POOL],
      pre: [SOL, RENT, RENT, 0],
      post: [SOL - FEE, RENT, RENT, 0],
      preTok: [tb(1, MINT, W, 0), tb(2, USDC_MINT, W, 50_000_000)],
      postTok: [tb(1, MINT, W, 1000), tb(2, USDC_MINT, W, 30_000_000)],
    });
    const [d] = walletDeltas(raw, W);
    expect([d.kind, d.side, d.quoteMint, d.quoteAmountRaw]).toEqual(["trade", "buy", USDC_MINT, -20_000_000n]);
  });

  it("marks two non-quote mints in one transaction as complex", () => {
    const raw = tx({
      keys: [W, ATA, ATA_B, POOL],
      pre: [SOL, RENT, RENT, 0],
      post: [SOL - FEE, RENT, RENT, 0],
      preTok: [tb(1, MINT, W, 1000), tb(2, MINT_B, W, 0)],
      postTok: [tb(1, MINT, W, 0), tb(2, MINT_B, W, 500)],
    });
    const got = Object.fromEntries(walletDeltas(raw, W).map((d) => [d.mint, [d.kind, d.tokenAmountRaw]]));
    expect(got).toEqual({ [MINT]: ["complex", -1000n], [MINT_B]: ["complex", 500n] });
  });

  it("produces nothing when the wallet is not in the transaction", () => {
    const raw = tx({ keys: [OTHER, ATA], pre: [SOL, 0], post: [SOL - FEE, 0] });
    expect(walletDeltas(raw, W)).toEqual([]);
  });

  it("carries the block index when the payload has one", () => {
    const raw = tx({
      keys: [W, ATA, POOL],
      pre: [10 * SOL, 0, 50 * SOL],
      post: [10 * SOL - SOL - FEE - RENT, RENT, 51 * SOL],
      postTok: [tb(1, MINT, W, 1000)],
      txIndex: 42,
    });
    expect(walletDeltas(raw, W)[0].txIndex).toBe(42);
  });
});
