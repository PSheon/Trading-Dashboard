import { describe, expect, it } from "vitest";
import type { WalletSummary } from "@/lib/contracts";
import { walletTotalValue } from "@/lib/wallet-value";

const summary = (overrides: Partial<WalletSummary> = {}): WalletSummary => ({
  network: "testnet", address: `0x${"11".repeat(20)}`,
  hyperliquid: { perpValue: 40, withdrawable: 40, spotUsdc: 10, spotUsdcHold: 0 },
  arbitrum: { usdc: 25, eth: 0 }, totalValue: 75,
  fetchedAt: new Date().toISOString(), ...overrides,
});

describe("wallet totals with incomplete chain balances", () => {
  it("does not present a partial total after an Arbitrum RPC failure", () => {
    expect(walletTotalValue(summary({ arbitrum: null, totalValue: 50 }))).toBeNull();
  });
  it("does not present a partial total without Hyperliquid balances", () => {
    expect(walletTotalValue(summary({ hyperliquid: null, totalValue: 25 }))).toBeNull();
  });
  it("preserves a complete total", () => {
    expect(walletTotalValue(summary())).toBe(75);
  });
  it("distinguishes a proven zero balance from an unavailable balance", () => {
    expect(walletTotalValue(summary({ hyperliquid: { perpValue: 0, withdrawable: 0, spotUsdc: 0, spotUsdcHold: 0 }, arbitrum: { usdc: 0, eth: 0 }, totalValue: 0 }))).toBe(0);
  });
  it("preserves zero before a wallet address exists", () => {
    expect(walletTotalValue(summary({ address: null, hyperliquid: null, arbitrum: null, totalValue: 0 }))).toBe(0);
  });
  it("keeps a not-yet-fetched balance unknown", () => {
    expect(walletTotalValue(undefined)).toBeNull();
  });
});
