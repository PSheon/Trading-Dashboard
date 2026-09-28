import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { build } from "../src/lib/fifo";
import { bound, compute, type Metrics } from "../src/lib/metrics";
import { tmpWarehouse } from "./helpers";

const SOL = 1_000_000_000n;
const D = "2026-01-10";
const T = bound(D);
const HOUR = 3600;

type Trade = ReturnType<typeof trade>;
const trade = (wallet: string, mint: string, t: number, side: "buy" | "sell", amount: bigint, sol: bigint, fee = 0n) => ({
  tx_sig: `${wallet}-${mint}-${t}`, wallet, mint, side, token_amount_raw: amount, sol_lamports: sol,
  fee_lamports: fee, slot: t, tx_index: null, block_time: t,
});
const transfer = (wallet: string, mint: string, t: number, direction: "in" | "out", amount: bigint) => ({
  tx_sig: `${wallet}-${mint}-${t}`, wallet, mint, direction, kind: "transfer", token_amount_raw: amount,
  slot: t, tx_index: null, block_time: t,
});

async function snapshot(
  trades: Trade[],
  { transfers = [], tokens }: { transfers?: ReturnType<typeof transfer>[]; tokens?: Record<string, unknown>[] } = {},
): Promise<Metrics[]> {
  const wh = tmpWarehouse();
  const wallets = [...new Set([...trades, ...transfers].map((r) => r.wallet))];
  const { positions } = build(trades, transfers);
  await wh.replaceWallets("trades", wallets, trades);
  await wh.replaceWallets("positions", wallets, positions as unknown as Record<string, unknown>[]);
  if (tokens) await wh.write("tokens", tokens);
  return compute(D, {
    trades: wh.relation("trades"),
    positions: wh.relation("positions"),
    tokens: tokens ? wh.relation("tokens") : null,
  });
}

const row = (ms: Metrics[], wallet = "A") => ms.find((m) => m.wallet === wallet)!;

const BASE = [
  trade("A", "M1", T - 10 * HOUR, "buy", 100n, SOL),
  trade("A", "M1", T - 9 * HOUR, "sell", 100n, 3n * SOL), // +2
  trade("A", "M2", T - 8 * HOUR, "buy", 100n, SOL),
  trade("A", "M2", T - 6 * HOUR, "sell", 100n, SOL / 2n), // -0.5
  trade("A", "M3", T - 5 * HOUR, "buy", 100n, SOL),
  trade("A", "M3", T - 2 * HOUR, "sell", 100n, 2n * SOL), // +1
];

describe("compute", () => {
  it("measures three round trips", async () => {
    const r = row(await snapshot(BASE));
    expect(r.as_of_date).toBe(D);
    expect([r.trade_count, r.token_count]).toEqual([3, 3]);
    expect(r.realized_pnl_sol).toBeCloseTo(2.5);
    expect(r.win_rate).toBeCloseTo(2 / 3);
    expect(r.pnl_concentration).toBeCloseTo(2 / 3);
    expect(r.max_drawdown_sol).toBeCloseTo(0.5); // cumulative 2, 1.5, 2.5
    expect(r.median_hold_seconds).toBe(2 * HOUR);
    expect(r.tx_per_active_hour).toBe(1);
    expect(r.last_active_at).toBe(T - 2 * HOUR);
    expect(r.unknown_cost_ratio).toBe(0);
  });

  it("counts fees against PnL and reports them", async () => {
    const r = row(await snapshot([
      trade("A", "M", T - 20, "buy", 10n, SOL, SOL / 100n),
      trade("A", "M", T - 10, "sell", 10n, 2n * SOL, SOL / 100n),
    ]));
    expect(r.realized_pnl_sol).toBeCloseTo(0.98);
    expect(r.fees_sol).toBeCloseTo(0.02);
  });

  it("is unchanged by anything after as_of (the point-in-time property)", async () => {
    const before = [...BASE, trade("A", "M4", T - HOUR, "buy", 100n, SOL)];
    const future = [
      trade("A", "M4", T + HOUR, "sell", 100n, 10n * SOL), // closes a position open at D
      trade("A", "M5", T, "buy", 100n, SOL), // exactly at the bound: excluded
      trade("A", "M5", T + 2 * HOUR, "sell", 100n, 5n * SOL),
      trade("B", "M1", T + HOUR, "buy", 1n, SOL), // a wallet that only starts later
    ];
    const tokens = [{ mint: "M1", created_at: T - 20 * HOUR, graduated_at: T + HOUR }];
    const a = await snapshot(before, { tokens });
    const b = await snapshot([...before, ...future], { tokens });
    expect(b).toEqual(a);
    expect(b.map((m) => m.wallet)).toEqual(["A"]);
    expect(row(b).trade_count).toBe(3); // M4 was still open at D
  });

  it("does not know about a graduation after as_of", async () => {
    const tokens = [
      { mint: "M1", created_at: T - 20 * HOUR, graduated_at: T - 9 * HOUR + 1 },
      { mint: "M2", created_at: T - 20 * HOUR, graduated_at: T + HOUR },
    ];
    const r = row(await snapshot(BASE, { tokens }));
    // M1 bought before a graduation that had happened; M2's is in the future; M3 is unknown.
    expect(r.pre_graduation_ratio).toBeCloseTo(1 / 2);
    expect(r.median_entry_age_seconds).toBeCloseTo(((10 + 12) / 2) * HOUR);
  });

  it("excludes positions with unknown cost but counts them in the ratio", async () => {
    const r = row(await snapshot([...BASE, trade("A", "GIFT", T - 3 * HOUR, "sell", 50n, SOL)], {
      transfers: [transfer("A", "GIFT", T - 4 * HOUR, "in", 50n)],
    }));
    expect(r.trade_count).toBe(3);
    expect(r.realized_pnl_sol).toBeCloseTo(2.5);
    expect(r.unknown_cost_ratio).toBeCloseTo(1 / 4);
  });

  it("gives a losing-only wallet no concentration", async () => {
    const r = row(await snapshot([trade("A", "M", T - 20, "buy", 1n, SOL), trade("A", "M", T - 10, "sell", 1n, 1n)]));
    expect(r.pnl_concentration).toBeNull();
    expect(r.win_rate).toBe(0);
  });

  it("requires a bound and reads no files itself", () => {
    expect(() => bound("yesterday")).toThrow();
    const source = readFileSync("src/lib/metrics.ts", "utf8");
    for (const forbidden of ["read_parquet", "Warehouse", "readFileSync", "node:fs"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
