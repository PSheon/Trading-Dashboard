import path from "node:path";

import { describe, expect, it } from "vitest";

import { tmpWarehouse } from "./helpers";

const JAN = 1_704_067_200; // 2024-01-01
const FEB = 1_706_745_600; // 2024-02-01

const trade = (wallet: string, sig: string, t: number, amount = 1n) => ({
  tx_sig: sig, wallet, mint: "M", side: "buy", token_amount_raw: amount, slot: t, block_time: t,
});

describe("Warehouse", () => {
  it("reads a missing table as empty", async () => {
    expect(await tmpWarehouse().read("trades")).toEqual([]);
  });

  it("splits a monthly table by block_time month", async () => {
    const wh = tmpWarehouse();
    await wh.replaceWallets("trades", ["A"], [trade("A", "s1", JAN), trade("A", "s2", FEB)]);
    expect(wh.files("trades").map((f) => path.basename(f))).toEqual(["month=2024-01.parquet", "month=2024-02.parquet"]);
    expect((await wh.read<{ tx_sig: string }>("trades", "true", "tx_sig")).map((r) => r.tx_sig)).toEqual(["s1", "s2"]);
  });

  it("drops rows a wallet no longer emits and keeps other wallets", async () => {
    const wh = tmpWarehouse();
    await wh.replaceWallets("trades", ["A", "B"], [trade("A", "a1", JAN), trade("A", "a2", FEB), trade("B", "b1", JAN)]);
    await wh.replaceWallets("trades", ["A"], [trade("A", "a1", JAN, 5n)]);
    const rows = await wh.read<{ tx_sig: string; token_amount_raw: bigint }>("trades", "true", "tx_sig");
    expect(rows.map((r) => [r.tx_sig, r.token_amount_raw])).toEqual([["a1", 5n], ["b1", 1n]]);
  });

  it("replaces wallets in a single-file table", async () => {
    const wh = tmpWarehouse();
    await wh.replaceWallets("lots", ["A", "B"], [{ wallet: "A", mint: "M", lot_seq: 0 }, { wallet: "B", mint: "M", lot_seq: 0 }]);
    await wh.replaceWallets("lots", ["A"], []);
    expect((await wh.read<{ wallet: string }>("lots")).map((r) => r.wallet)).toEqual(["B"]);
  });

  it("round-trips bigints beyond 2^53, lists and dates exactly", async () => {
    const wh = tmpWarehouse();
    const big = 2n ** 62n + 7n;
    await wh.replaceWallets("trades", ["A"], [{ ...trade("A", "s", JAN, big), programs: ["pump_amm", "system"] }]);
    const [r] = await wh.read<{ token_amount_raw: bigint; programs: string[] }>("trades");
    expect(r.token_amount_raw).toBe(big);
    expect(r.programs).toEqual(["pump_amm", "system"]);
    await wh.writeDay("wallet_metrics_daily", "2026-09-28", [{ as_of_date: "2026-09-28", wallet: "A", trade_count: 3 }]);
    expect(wh.days("wallet_metrics_daily")).toEqual(["2026-09-28"]);
    const [m] = await wh.read<{ as_of_date: string; trade_count: number }>("wallet_metrics_daily");
    expect([m.as_of_date, m.trade_count]).toEqual(["2026-09-28", 3]);
  });
});
