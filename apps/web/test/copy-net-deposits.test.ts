import { expect, it } from "vitest";

import { liveNetDeposits, livePnl } from "@/lib/copy-net-deposits";
import type { FundsFlowView } from "@/lib/funds";

/**
 * A real copy's PnL is equity less its net deposits (audit 2026-10-07 P0-2):
 * a withdrawal or the return to the main wallet is never a loss, and the
 * page shows "—" instead of a figure it cannot back.
 */
const owner = `0x${"11".repeat(20)}`, account = `0x${"cc".repeat(20)}`;
const copy = { strategyId: 902, accountAddress: account, createdAt: "2026-10-05T00:00:00.000Z" };
const flow = (over: Partial<FundsFlowView>): FundsFlowView => ({ id: Math.random().toString(36), time: "2026-10-05T01:00:00.000Z", kind: "copy_funding", mode: "mainnet", amount: 50,
  strategyId: 902, leaderAddress: `0x${"44".repeat(20)}`, status: "credited", txHash: null, fee: null, counterparty: account, count: null, ...over });

it("a 10 USDC withdrawal lowers net deposits, so a 40.41 equity on a 50 budget is +0.41, not -9.59", () => {
  const flows = [flow({ amount: 10, counterparty: owner, time: "2026-10-06T00:00:00.000Z" }), flow({})];
  const net = liveNetDeposits(flows, true, copy, owner);
  expect(net).toBe(40);
  const { pnl, roi } = livePnl(40.41, net);
  expect(pnl).toBeCloseTo(0.41, 6);
  expect(roi).toBeCloseTo(0.41 / 40, 6);
});

it("adds every top-up and ignores refused or cancelled transfers and other copies", () => {
  const flows = [flow({}), flow({ amount: 25 }), flow({ amount: 99, status: "rejected" }), flow({ amount: 7, strategyId: 1 }), flow({ kind: "hub_withdrawal", amount: -20, strategyId: null })];
  expect(liveNetDeposits(flows, true, copy, owner)).toBe(75);
});

it("is unknown (—) while a transfer is on its way, before the ledger reaches the copy's start, or without any deposit", () => {
  expect(liveNetDeposits([flow({}), flow({ amount: 10, counterparty: owner, status: "prepared" })], true, copy, owner)).toBeNull();
  expect(liveNetDeposits([flow({ time: "2026-10-06T00:00:00.000Z" })], false, copy, owner)).toBeNull();
  expect(liveNetDeposits([flow({ time: "2026-10-04T00:00:00.000Z" }), flow({})], false, copy, owner)).toBe(100);
  expect(liveNetDeposits([], true, copy, owner)).toBeNull();
  expect(liveNetDeposits([flow({ counterparty: `0x${"99".repeat(20)}` })], true, copy, owner)).toBeNull();
  expect(livePnl(49.17, null)).toEqual({ pnl: null, roi: null });
  expect(livePnl(null, 50)).toEqual({ pnl: null, roi: null });
});
