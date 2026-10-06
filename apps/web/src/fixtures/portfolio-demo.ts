import type { CopyExecutionAccount, CopyFollowerSnapshot, LiveCopyMandate, LiveCopyPortfolioItem, LiveCopyStrategy } from "@trading-dashboard/shared/contracts";

import { fixtureSignerFlag } from "@/lib/fixture-signer";
import { traderStats } from "./data";

/**
 * `?portfolio=demo` (with `?signer=fixture`): a signed-in portfolio with two
 * running testnet copies, two that ended, their accounts, a fresh snapshot
 * of each and some activity, for reviewing the portfolio page in fixture
 * mode (screenshots). Sticky for the tab, like the signer flag. Fixtures
 * only: never in a build without NEXT_PUBLIC_API_FIXTURES.
 */
const STICKY = "orbie:fixtures:portfolio-demo";
export function portfolioDemo(): boolean {
  if (typeof window === "undefined" || !fixtureSignerFlag(window.location.search)) return false;
  const flagged = new URLSearchParams(window.location.search).get("portfolio") === "demo";
  try {
    if (flagged) sessionStorage.setItem(STICKY, "1");
    return flagged || sessionStorage.getItem(STICKY) === "1";
  } catch { return flagged; }
}

const named = traderStats.filter((s) => s.displayName).slice(0, 4);
const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
const DAY = 86_400_000;
const settings = { direction: "same" as const, sizingMode: "ratio" as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: "delta" as const };
const SEED = [
  { id: 61, stage: "active" as const, budget: "250", equity: "268.40", withdrawable: "141.15", pnl: "6.15", position: { coin: "ETH", size: "0.05", entry: "4512.3", value: "231.9", margin: "23.19" } },
  { id: 62, stage: "active" as const, budget: "150", equity: "143.75", withdrawable: "143.75", pnl: "0", position: null },
  { id: 63, stage: "stopped" as const, budget: "100", equity: "0", withdrawable: "0", pnl: "0", position: null },
  { id: 64, stage: "stopped" as const, budget: "200", equity: "0", withdrawable: "0", pnl: "0", position: null },
];
const address = (id: number) => `0x${id.toString(16).padStart(2, "0").repeat(20)}`;
const mandateId = (id: number) => `6f1c1d2e-3a4b-4c5d-8e9f-${String(id).padStart(12, "0")}`;

export function demoLiveItems(): LiveCopyPortfolioItem[] {
  return SEED.map((s, i) => ({
    strategyId: s.id, leaderAddress: named[i]!.address, sourceNetwork: "mainnet", budgetUsd: s.budget, status: s.stage === "stopped" ? "stopped" : "active", stage: s.stage,
    createdAt: iso((i + 2) * DAY), accountId: `acct-${s.id}`, accountAddress: address(s.id),
    mandate: s.stage === "stopped" ? null : { id: mandateId(s.id), state: "active", revision: 3 }, stop: null, pendingTransfer: null, lastRefusal: null, automaticReturn: true,
    sweep: s.stage === "stopped" ? { amount: i === 2 ? "103.20" : "188.75", status: "credited" } : null, setup: null, expiresAt: iso(-25 * DAY), renewalDue: false, oneClick: true,
  }));
}
export function demoLiveStrategies(): LiveCopyStrategy[] {
  return SEED.map((s, i) => ({ id: s.id, mode: "actual", network: "testnet", sourceNetwork: "mainnet", leaderAddress: named[i]!.address, budgetUsd: s.budget, status: s.stage === "stopped" ? "stopped" : "active",
    version: 1, settings, pauseNewRisk: false, reduceOnly: false, createdAt: iso((i + 2) * DAY) }));
}
export function demoMandates(): LiveCopyMandate[] {
  return SEED.filter((s) => s.stage !== "stopped").map((s, i) => ({ id: mandateId(s.id), accountId: `acct-${s.id}`, strategyId: s.id, mode: "actual", network: "testnet", accountAddress: address(s.id),
    sourceNetwork: "mainnet", leaderAddress: named[i]!.address, budgetUsd: s.budget, strategyVersion: 1, state: "active", revision: 3, activationCursor: iso((i + 2) * DAY), expiresAt: iso(-25 * DAY),
    createdAt: iso((i + 2) * DAY), updatedAt: iso(DAY) }));
}
export function demoAccounts(): CopyExecutionAccount[] {
  return SEED.map((s) => ({ id: `acct-${s.id}`, strategyId: s.id, network: "testnet", state: "ready", address: address(s.id), createdAt: iso(5 * DAY), updatedAt: iso(DAY), issue: null, automaticReturn: true }));
}
/** A fresh snapshot whose totals add up (the browser checks them). */
export function demoSnapshot(accountId: string): CopyFollowerSnapshot | null {
  const s = SEED.find((x) => `acct-${x.id}` === accountId);
  if (!s) return null;
  const now = Date.now(), p = s.position;
  const margin = p ? p.margin : "0", exposure = p ? p.value : "0";
  return { mode: "actual", network: "testnet", accountId, strategyId: s.id, accountAddress: address(s.id), status: "observed", freshness: "fresh", lastReadIssue: null,
    asOf: { observedAt: now, completedAt: now, earliestProviderTime: now, checkedAt: now, freshUntil: now + 4000 }, sourceDigest: "a".repeat(64), role: "user", accountMode: "standard", accountAbstraction: "disabled",
    collateral: { tokenIndex: 0, coin: "USDC" },
    metrics: { perpEquity: s.equity, marginUsed: margin, withdrawable: s.withdrawable, exposureUsd: exposure, restingExposureUsd: "0", grossRestingExposureUsd: "0", unrealizedPnl: s.pnl, roi: null, periodPnl: null, netDeposits: null },
    positions: p ? [{ coin: p.coin, dex: "", asset: 1, sizeDecimals: 4, size: p.size, entryPrice: p.entry, positionValue: p.value, unrealizedPnl: s.pnl, marginUsed: p.margin, leverage: 10, leverageType: "cross", maxLeverage: 25, fundingSinceOpen: "0", fundingSinceChange: "0" }] : [],
    restingOrders: [],
    dexes: [{ dex: "", perpDexIndex: 0, supported: true, collateralToken: 0, collateralCoin: "USDC", providerTime: now, equity: s.equity, rawUsd: s.equity, marginUsed: margin, withdrawable: s.withdrawable, exposureUsd: exposure,
      crossEquity: s.equity, crossMarginUsed: margin, crossExposureUsd: exposure, crossMaintenanceMarginUsed: "0" }],
    coverage: { complete: true, balanceComplete: true, orderComplete: true, listedDexes: [""], observedOrderDexes: [""], unobservedOrderDexes: [] }, quarantine: { blocked: false, reason: null } };
}
/** The demo copies' fills, as the copy event feed carries them (oldest first). */
export function demoEvents(): { strategyId: number; type: string; payload: Record<string, unknown>; createdAt: Date }[] {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  return [
    { strategyId: 64, type: "order_filled", createdAt: at(60 * 30), payload: { mode: "testnet", coin: "SOL", side: "B", size: "1.2" } },
    { strategyId: 63, type: "order_filled", createdAt: at(60 * 26), payload: { mode: "testnet", coin: "BTC", side: "A", size: "0.002" } },
    { strategyId: 62, type: "funds_added", createdAt: at(60 * 5), payload: { mode: "testnet", amount: "50" } },
    { strategyId: 61, type: "order_filled", createdAt: at(95), payload: { mode: "testnet", coin: "ETH", side: "B", size: "0.03" } },
    { strategyId: 62, type: "order_filled", createdAt: at(40), payload: { mode: "testnet", coin: "HYPE", side: "A", size: "4.5" } },
    { strategyId: 61, type: "order_filled", createdAt: at(12), payload: { mode: "testnet", coin: "ETH", side: "B", size: "0.02" } },
  ];
}
