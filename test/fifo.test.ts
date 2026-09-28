import { describe, expect, it } from "vitest";

import { build, type EventKind, type FifoEvent, runFifo } from "../src/lib/fifo";

const SOL = 1_000_000_000n;

function ev(t: number, kind: EventKind, amount: number | bigint, sol: bigint | null = null, sig?: string): FifoEvent {
  const a = BigInt(amount);
  return {
    txSig: sig ?? `s${t}`,
    slot: t,
    blockTime: t,
    kind,
    amount: kind === "buy" || kind === "transfer_in" ? a : -a,
    sol,
  };
}

const closed = <T extends { close_type: unknown }>(lots: T[]) => lots.filter((l) => l.close_type !== null);

describe("runFifo", () => {
  it("makes a round trip one position with realized PnL", () => {
    const { lots, positions } = runFifo("W", "M", [ev(10, "buy", 100, SOL), ev(20, "sell", 100, 3n * SOL)]);
    const [lot] = lots;
    expect([lot.close_type, lot.cost_lamports, lot.proceeds_lamports]).toEqual(["sell", SOL, 3n * SOL]);
    expect([lot.realized_pnl_lamports, lot.hold_seconds]).toEqual([2n * SOL, 10]);
    const [pos] = positions;
    expect([pos.opened_at, pos.closed_at, pos.realized_pnl_lamports, pos.complete]).toEqual([10, 20, 2n * SOL, true]);
  });

  it("splits lots on partial sells but keeps one position", () => {
    const { lots, positions } = runFifo("W", "M", [ev(1, "buy", 100, SOL), ev(2, "sell", 30, SOL), ev(3, "sell", 70, 2n * SOL)]);
    expect(lots.map((l) => [l.token_amount_raw, l.cost_lamports])).toEqual([
      [30n, 300_000_000n],
      [70n, 700_000_000n],
    ]);
    expect(positions[0].lots).toBe(2);
    expect(positions[0].realized_pnl_lamports).toBe(3n * SOL - SOL);
  });

  it("consumes the oldest lot first and splits proceeds exactly", () => {
    const { lots } = runFifo("W", "M", [ev(1, "buy", 10, 10n), ev(2, "buy", 10, 20n), ev(3, "sell", 15, 45n)]);
    const done = closed(lots);
    expect(done.map((l) => [l.buy_tx_sig, l.token_amount_raw, l.cost_lamports])).toEqual([
      ["s1", 10n, 10n],
      ["s2", 5n, 10n],
    ]);
    expect(done.map((l) => l.proceeds_lamports)).toEqual([30n, 15n]);
    const open = lots.filter((l) => l.close_type === null);
    expect(open.map((l) => [l.token_amount_raw, l.cost_lamports])).toEqual([[5n, 10n]]);
  });

  it("never loses a lamport when splitting cost", () => {
    const { lots, positions } = runFifo("W", "M", [
      ev(1, "buy", 3, 100n), ev(2, "sell", 1, 50n), ev(3, "sell", 1, 50n), ev(4, "sell", 1, 50n),
    ]);
    expect(lots.reduce((s, l) => s + l.cost_lamports!, 0n)).toBe(100n);
    expect(positions[0].cost_lamports).toBe(100n);
  });

  it("starts a new position after selling back to zero", () => {
    const { positions } = runFifo("W", "M", [ev(1, "buy", 10, 10n), ev(2, "sell", 10, 20n), ev(3, "buy", 5, 5n), ev(4, "sell", 5, 1n)]);
    expect(positions.map((p) => [p.position_seq, p.opened_at, p.closed_at, p.realized_pnl_lamports])).toEqual([
      [0, 1, 2, 10n],
      [1, 3, 4, -4n],
    ]);
  });

  it("leaves an open position without close or PnL", () => {
    const { lots, positions } = runFifo("W", "M", [ev(1, "buy", 10, 10n)]);
    expect([positions[0].closed_at, positions[0].realized_pnl_lamports, positions[0].complete]).toEqual([null, null, false]);
    expect(lots[0].close_type).toBeNull();
  });

  it("closes lots on transfer out without PnL and marks the position incomplete", () => {
    const { lots, positions } = runFifo("W", "M", [ev(1, "buy", 10, 10n), ev(2, "transfer_out", 10)]);
    expect([lots[0].close_type, lots[0].realized_pnl_lamports]).toEqual(["transfer_out", null]);
    expect([positions[0].has_transfer_out, positions[0].complete, positions[0].realized_pnl_lamports]).toEqual([true, false, null]);
  });

  it("gives tokens received by transfer an unknown cost", () => {
    const { lots, positions } = runFifo("W", "M", [ev(1, "transfer_in", 10), ev(2, "sell", 10, 50n)]);
    expect([lots[0].cost_unknown, lots[0].realized_pnl_lamports, lots[0].proceeds_lamports]).toEqual([true, null, 50n]);
    expect([positions[0].has_unknown_cost, positions[0].complete]).toEqual([true, false]);
  });

  it("creates an orphan lot for selling more than held", () => {
    const { lots, positions } = runFifo("W", "M", [ev(1, "buy", 10, 10n), ev(2, "sell", 15, 30n)]);
    const [known, orphan] = lots;
    expect([known.token_amount_raw, known.proceeds_lamports, known.cost_unknown]).toEqual([10n, 20n, false]);
    expect([orphan.token_amount_raw, orphan.proceeds_lamports]).toEqual([5n, 10n]);
    expect([orphan.cost_unknown, orphan.buy_tx_sig, orphan.hold_seconds]).toEqual([true, null, null]);
    expect([positions[0].closed_at, positions[0].has_unknown_cost]).toEqual([2, true]);
  });

  it("makes a sell with no holdings its own closed position", () => {
    const { lots, positions } = runFifo("W", "M", [ev(5, "sell", 10, 30n)]);
    expect(lots[0].cost_unknown).toBe(true);
    expect([positions[0].opened_at, positions[0].closed_at, positions[0].complete]).toEqual([5, 5, false]);
  });

  it("writes off dust left after selling and closes the position", () => {
    const { lots, positions } = runFifo("W", "M", [ev(1, "buy", 100_000, 1000n), ev(2, "sell", 99_999, 2000n), ev(3, "buy", 10, 10n)]);
    const [first, second] = positions;
    expect([first.closed_at, first.complete]).toEqual([2, true]);
    const dust = lots.filter((l) => l.close_type === "dust");
    expect(dust.map((d) => [d.token_amount_raw, d.proceeds_lamports, d.close_time])).toEqual([[1n, 0n, 2]]);
    expect(first.realized_pnl_lamports).toBe(2000n - 1000n); // the dust's cost is a loss inside it
    expect(second.opened_at).toBe(3);
  });

  it("treats a buy with an unknown SOL leg as unknown cost", () => {
    const { lots, positions } = runFifo("W", "M", [ev(1, "buy", 10, null), ev(2, "sell", 10, 50n)]);
    expect([lots[0].cost_unknown, positions[0].complete]).toEqual([true, false]);
  });

  it("leaves a position incomplete when sell proceeds are unknown", () => {
    const { lots, positions } = runFifo("W", "M", [ev(1, "buy", 10, 10n), ev(2, "sell", 10, null)]);
    expect([lots[0].proceeds_lamports, lots[0].realized_pnl_lamports, positions[0].complete]).toEqual([null, null, false]);
  });

  it("numbers lots uniquely even when one buy is sold in pieces", () => {
    const { lots } = runFifo("W", "M", [
      ev(1, "buy", 10, 10n), ev(2, "sell", 3, 5n), ev(3, "sell", 3, 5n), ev(4, "buy", 1, 1n), ev(5, "sell", 5, 5n), ev(6, "buy", 2, 2n),
    ]);
    expect(lots.map((l) => l.lot_seq)).toEqual(lots.map((_, i) => i));
  });

  it("is deterministic", () => {
    const events = [ev(1, "buy", 7, 13n), ev(2, "sell", 3, 11n), ev(3, "transfer_in", 2), ev(4, "sell", 6, 9n)];
    expect(runFifo("W", "M", events)).toEqual(runFifo("W", "M", [...events]));
  });
});

describe("build", () => {
  it("orders events in one slot by block index, not signature", () => {
    const base = { wallet: "W", mint: "M", fee_lamports: 0n, slot: 7, block_time: 1 };
    const { positions } = build(
      [
        { ...base, tx_sig: "a-sell", side: "sell", token_amount_raw: 10n, sol_lamports: 30n, tx_index: 5 },
        { ...base, tx_sig: "b-buy", side: "buy", token_amount_raw: 10n, sol_lamports: 10n, tx_index: 2 },
      ],
      [],
    );
    expect([positions[0].complete, positions[0].realized_pnl_lamports]).toEqual([true, 20n]);
  });
});

describe("negative proceeds", () => {
  it("splits with floor division and still adds up", () => {
    const { lots } = runFifo("W", "M", [ev(1, "buy", 3, 30n), ev(2, "sell", 3, -10n)]);
    expect(lots.map((l) => l.proceeds_lamports)).toEqual([-10n]);
    const split = runFifo("W", "M", [ev(1, "buy", 1, 10n), ev(2, "buy", 2, 20n), ev(3, "sell", 3, -10n)]);
    // -10 * 1 / 3 floors to -4, the remaining -6 goes to the second lot.
    expect(split.lots.map((l) => l.proceeds_lamports)).toEqual([-4n, -6n]);
  });
});
