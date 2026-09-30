import { describe, expect, it } from "vitest";

import type { HlLedgerUpdate, HlTwapHistoryEntry, HlUserFill } from "../src/hyperliquid/types.js";
import { activeTwaps, HYPER_EVM_BRIDGE, mergeOrders, toTraderTransfer } from "../src/traders/trader-tabs.mappers.js";
import { hlFillToTraderFill, summarizeAccount } from "../src/traders/traders.mappers.js";

const ME = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const update = (delta: Record<string, unknown>, time = 1_790_000_000_000): HlLedgerUpdate =>
  ({ time, hash: `0x${time.toString(16)}`, delta: delta as HlLedgerUpdate["delta"] });

describe("轉帳: ledger updates classified as CopyDog does", () => {
  it("tells sent from received by the destination, and names the counterparties", () => {
    const sent = toTraderTransfer(update({ type: "send", user: ME, destination: OTHER, token: "USDC", amount: "200.5", usdcValue: "200.5" }), ME);
    expect(sent).toMatchObject({ kind: "sent", direction: "out", token: "USDC", amount: 200.5, usd: false, from: ME, to: OTHER });
    const received = toTraderTransfer(update({ type: "send", user: OTHER, destination: ME.toUpperCase().replace("0X", "0x"), token: "MAX", amount: "10000" }), ME);
    expect(received).toMatchObject({ kind: "received", direction: "in", token: "MAX", amount: 10000 });
  });

  it("maps deposits, withdrawals, HyperEVM, perp/spot, vault, staking and liquidation rows", () => {
    const kinds = [
      update({ type: "deposit", usdc: "1000" }),
      update({ type: "withdraw", usdc: "9999999.0", fee: "1.0" }),
      update({ type: "spotTransfer", user: ME, destination: HYPER_EVM_BRIDGE, token: "HYPE", amount: "3" }),
      update({ type: "accountClassTransfer", usdc: "50", toPerp: true }),
      update({ type: "vaultDeposit", vault: OTHER, usdc: "25" }),
      update({ type: "vaultWithdraw", vault: OTHER, requestedUsd: "30", netWithdrawnUsd: "29" }),
      update({ type: "cStakingTransfer", token: "HYPE", amount: "7", isDeposit: true }),
      update({ type: "liquidation", liquidatedNtlPos: "-1234.5", accountValue: "10" }),
    ].map((u) => toTraderTransfer(u, ME));
    expect(kinds.map((t) => [t?.kind, t?.direction, t?.token, t?.amount, t?.usd])).toEqual([
      ["deposit", "in", "USDC", 1000, false],
      ["withdraw", "out", "USDC", 9999999, false],
      ["toHyperEvm", "out", "HYPE", 3, false],
      ["toPerp", "move", "USDC", 50, false],
      ["vaultDeposit", "out", "USDC", 25, true],
      ["vaultWithdraw", "in", "USDC", 29, true],
      ["staked", "out", "HYPE", 7, false],
      ["liquidated", "out", "USDC", 1234.5, true],
    ]);
  });

  it("drops kinds CopyDog doesn't list", () => {
    expect(toTraderTransfer(update({ type: "somethingNew" }), ME)).toBeNull();
  });
});

describe("TWAP: running orders from twapHistory", () => {
  const entry = (twapId: number, status: string, time: number, sz = "10"): HlTwapHistoryEntry => ({
    time, twapId, status: { status },
    state: { coin: "ETH", side: "A", sz, executedSz: "0.0", executedNtl: "0.0", minutes: 90, reduceOnly: true, randomize: false, timestamp: time * 1000 },
  });
  const slice = (twapId: number, sz: string): HlUserFill => ({
    coin: "ETH", px: "2500", sz, side: "A", time: 1, tid: Math.random(), closedPnl: "0", fee: "0", dir: "Close Long", hash: "0x0", oid: 1, crossed: true, twapId,
  });

  it("keeps TWAPs whose latest status is activated, with progress from their slices", () => {
    const history = [entry(1, "activated", 100), entry(1, "finished", 200), entry(2, "activated", 300), entry(3, "activated", 400), entry(3, "terminated", 500)];
    const twaps = activeTwaps(history, [slice(2, "4"), slice(2, "1"), slice(1, "10")]);
    expect(twaps).toEqual([expect.objectContaining({ twapId: 2, side: "sell", size: 10, filledSize: 5, filledFraction: 0.5, minutes: 90, reduceOnly: true })]);
  });

  it("caps progress at the TWAP's size", () => {
    expect(activeTwaps([entry(9, "activated", 1, "2")], [slice(9, "3")])[0].filledFraction).toBe(1);
  });
});

describe("訂單: open orders across dexes", () => {
  it("merges dexes once per oid, largest value first, and hides the 0.0 trigger of a plain order", () => {
    const orders = mergeOrders([
      [{ coin: "BTC", side: "B", limitPx: "60000", sz: "0.1", oid: 1, timestamp: 1, isTrigger: false, triggerPx: "0.0", orderType: "Limit", reduceOnly: false }],
      [
        { coin: "xyz:TSLA", side: "A", limitPx: "400", sz: "100", oid: 2, timestamp: 2, isTrigger: true, triggerPx: "390", orderType: "Stop Limit", reduceOnly: true, triggerCondition: "Price below 390" },
        { coin: "BTC", side: "B", limitPx: "60000", sz: "0.1", oid: 1, timestamp: 1 },
      ],
    ]);
    expect(orders.map((o) => [o.oid, o.side, o.orderType, o.triggerPx, o.reduceOnly])).toEqual([
      ["2", "sell", "Stop Limit", 390, true],
      ["1", "buy", "Limit", null, false],
    ]);
  });
});

describe("持倉 and 成交: CopyDog's extra columns", () => {
  it("maps a position's margin, funding since open and return on equity", () => {
    const { positions } = summarizeAccount([{
      assetPositions: [{ type: "oneWay", position: {
        coin: "ETH", szi: "-2", entryPx: "2500", leverage: { type: "cross", value: 10 }, liquidationPx: "2900", marginUsed: "480",
        unrealizedPnl: "200", positionValue: "4800", returnOnEquity: "0.4", cumFunding: { allTime: "-5", sinceOpen: "-3.5", sinceChange: "-1" },
      } }],
      marginSummary: { accountValue: "1000", totalMarginUsed: "480", totalNtlPos: "4800", totalRawUsd: "0" },
      crossMarginSummary: { accountValue: "1000", totalMarginUsed: "480", totalNtlPos: "4800", totalRawUsd: "0" },
      withdrawable: "500", time: 0,
    }]);
    expect(positions[0]).toMatchObject({ side: "short", marginUsed: 480, fundingSinceOpen: -3.5, returnOnEquity: 0.4, liqPx: 2900 });
  });

  it("keeps a fill's starting position and liquidation flag", () => {
    const base = { coin: "HYPE", px: "40", sz: "5", side: "A" as const, time: 1, tid: 3, closedPnl: "-12", fee: "0.1", dir: "Close Long", hash: "0x1", oid: 4, crossed: true };
    expect(hlFillToTraderFill({ ...base, startPosition: "5" })).toMatchObject({ startPosition: 5, liquidation: false });
    expect(hlFillToTraderFill({ ...base, liquidation: { markPx: 39, method: "market" } })).toMatchObject({ startPosition: null, liquidation: true });
  });
});
