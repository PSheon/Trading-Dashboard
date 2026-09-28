import path from "node:path";

import { describe, expect, it } from "vitest";

import { build } from "../src/lib/fifo";
import { ingestWallets } from "../src/lib/jobs";
import { bound } from "../src/lib/metrics";
import { appendRaw } from "../src/lib/rawStore";
import { changedFrom, maintainSnapshots, verifyDay } from "../src/lib/snapshots";
import type { RawTransaction } from "../src/lib/solana";
import { Warehouse } from "../src/lib/store";
import { addWallets, recordFetch } from "../src/lib/wallets";
import { ATA, FEE, MINT, POOL, RENT, SOL, W, tb, tx } from "./fixtures";
import { tmpDir } from "./helpers";

const DAY = 86_400;
const D0 = "2026-03-01";
const T0 = bound(D0);

function at(raw: RawTransaction, sig: string, t: number) {
  raw.transaction.signatures = [sig];
  raw.blockTime = t;
  raw.slot = t;
  return raw;
}
const buy = (sig: string, t: number) =>
  at(tx({ keys: [W, ATA, POOL], pre: [10 * SOL, 0, 50 * SOL], post: [10 * SOL - SOL - FEE - RENT, RENT, 51 * SOL], postTok: [tb(1, MINT, W, 1000)] }), sig, t);
const sell = (sig: string, t: number, proceeds = 2 * SOL) =>
  at(tx({ keys: [W, ATA, POOL], pre: [SOL, RENT, 50 * SOL], post: [SOL + proceeds + RENT - FEE, 0, 50 * SOL - proceeds], preTok: [tb(1, MINT, W, 1000)] }), sig, t);

function page(file: string, raws: RawTransaction[]) {
  appendRaw(file, {
    source: "test",
    requestKey: "k",
    request: {},
    response: { data: raws.map((r) => ({ signature: r.transaction.signatures[0], parsed: { slot: r.slot, blockTime: r.blockTime }, rawTransaction: r })) },
  });
}

async function setup() {
  const dir = tmpDir();
  const wh = new Warehouse(path.join(dir, "warehouse"));
  const rawDir = path.join(dir, "raw");
  const hist = path.join(rawDir, "helius", "transaction-history", W);
  await addWallets(wh, [W], { via: "manual", now: T0 });
  await recordFetch(wh, { [W]: [null, T0, T0 - 3 * DAY] });
  return { wh, rawDir, hist };
}

describe("changedFrom", () => {
  it("finds the earliest differing row per wallet, in either direction", () => {
    const sig = (r: { k: string }) => r.k;
    const a = [{ wallet: "A", k: "1", block_time: 10 }, { wallet: "A", k: "2", block_time: 20 }, { wallet: "B", k: "3", block_time: 5 }];
    const b = [{ wallet: "A", k: "1", block_time: 10 }, { wallet: "A", k: "2b", block_time: 20 }, { wallet: "B", k: "3", block_time: 5 }, { wallet: "B", k: "4", block_time: 7 }];
    expect([...changedFrom(a, b, sig)]).toEqual([["A", 20], ["B", 7]]);
    expect(changedFrom(a, a, sig).size).toBe(0);
  });
});

describe("maintainSnapshots", () => {
  it("fills every day from the start of history, then keeps stored days equal to a recompute", async () => {
    const { wh, rawDir, hist } = await setup();
    page(path.join(hist, "a.jsonl.gz"), [buy("b1", T0 - 2 * DAY), sell("s1", T0 - 2 * DAY + 60)]);
    await ingestWallets(wh, rawDir, [W], T0);
    const first = await maintainSnapshots(wh, D0);
    // History starts 3 days before D0, so the first snapshot day is the day after.
    expect(first.filled_days).toBe(3);
    expect(wh.days("wallet_metrics_daily")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);

    // A late round trip two days back: stored days after it are now stale.
    page(path.join(hist, "b.jsonl.gz"), [buy("b2", T0 - DAY - 600), sell("s2", T0 - DAY - 300, 5 * SOL)]);
    const ingested = await ingestWallets(wh, rawDir, [W], T0 + 10);
    expect(ingested.stale_wallets).toBe(1);
    const before = await verifyDay(wh, D0);
    expect(before.mismatched).toEqual([W]); // the cache is stale until maintained

    const second = await maintainSnapshots(wh, D0);
    // The late trade is on Feb 27 (late evening): it changes the Feb 28 and Mar 1 snapshots.
    expect(second).toEqual({ filled_days: 0, updated_days: 2, stale_wallets: 1 });
    for (const day of wh.days("wallet_metrics_daily")) expect((await verifyDay(wh, day)).mismatched).toEqual([]);
    const [m] = await wh.read<{ trade_count: number }>("wallet_metrics_daily", "as_of_date = DATE '2026-03-01'");
    expect(m.trade_count).toBe(2);
    expect(await wh.read("snapshot_dirty")).toEqual([]);
  });

  it("fills days missed while the server was down", async () => {
    const { wh, rawDir, hist } = await setup();
    page(path.join(hist, "a.jsonl.gz"), [buy("b1", T0 - 2 * DAY)]);
    await ingestWallets(wh, rawDir, [W], T0);
    await maintainSnapshots(wh, D0);
    const later = await maintainSnapshots(wh, "2026-03-04");
    expect(later.filled_days).toBe(3);
    expect(wh.days("wallet_metrics_daily").at(-1)).toBe("2026-03-04");
  });

  it("an unchanged re-ingest marks nothing stale", async () => {
    const { wh, rawDir, hist } = await setup();
    page(path.join(hist, "a.jsonl.gz"), [buy("b1", T0 - 2 * DAY), sell("s1", T0 - DAY)]);
    await ingestWallets(wh, rawDir, [W], T0);
    await maintainSnapshots(wh, D0);
    const again = await ingestWallets(wh, rawDir, [W], T0 + 100);
    expect(again.stale_wallets).toBe(0);
    expect(await wh.read("snapshot_dirty")).toEqual([]);
  });
});

describe("compute on a subset", () => {
  it("gives a wallet the same row as computing everyone", async () => {
    const { wh } = await setup();
    const t = (wallet: string, side: "buy" | "sell", time: number, sol: bigint) => ({
      tx_sig: `${wallet}${time}`, wallet, mint: "M", side, token_amount_raw: 10n, sol_lamports: sol, fee_lamports: 0n,
      slot: time, tx_index: null, block_time: time,
    });
    const trades = [t("A", "buy", T0 - 100, 10n), t("A", "sell", T0 - 50, 30n), t("B", "buy", T0 - 90, 5n), t("B", "sell", T0 - 40, 1n)];
    const { positions } = build(trades, []);
    await wh.replaceWallets("trades", ["A", "B"], trades);
    await wh.replaceWallets("positions", ["A", "B"], positions as unknown as Record<string, unknown>[]);
    const { compute } = await import("../src/lib/metrics");
    const all = await compute(D0, { trades: wh.relation("trades"), positions: wh.relation("positions") });
    const onlyB = await compute(D0, { trades: wh.relation("trades"), positions: wh.relation("positions"), wallets: ["B"] });
    expect(onlyB).toEqual(all.filter((m) => m.wallet === "B"));
  });
});

describe("backfilling snapshot history", () => {
  it("fills days before the first stored one, back to the start of history", async () => {
    const { wh, rawDir, hist } = await setup();
    page(path.join(hist, "a.jsonl.gz"), [buy("b1", T0 - 2 * DAY)]);
    await ingestWallets(wh, rawDir, [W], T0);
    await wh.writeDay("wallet_metrics_daily", D0, []); // only today was ever stored
    const r = await maintainSnapshots(wh, D0);
    expect(r.filled_days).toBe(2);
    expect(wh.days("wallet_metrics_daily")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
});
