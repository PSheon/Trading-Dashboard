// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { fixtureRequest } from "@/fixtures/handler";
import { demoLiveItems } from "@/fixtures/portfolio-demo";
import type { LiveCopyPortfolioItem, LiveCopySetup } from "@trading-dashboard/shared/contracts";
afterEach(() => { vi.unstubAllEnvs(); sessionStorage.clear(); });
it("retains the setup's execution network in portfolio data so a reload can resume the right copy", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_FIXTURES", "1");
  window.history.replaceState(null, "", "/en?signer=fixture");
  const setup = await fixtureRequest<LiveCopySetup>("POST", "/me/copy/live/setups", {
    idempotencyKey: crypto.randomUUID(), leader: `0x${"ab".repeat(20)}`, sourceNetwork: "mainnet", budgetUsd: "150",
    settings: { direction: "same", sizingMode: "ratio", perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: "delta" },
  }, "fixture-token");
  const portfolio = await fixtureRequest<{ items: LiveCopyPortfolioItem[] }>("GET", "/me/copy/live/portfolio", undefined, "fixture-token");
  expect(setup.consent?.network).toBe("testnet");
  expect(portfolio.items.find(item => item.strategyId === setup.strategyId)?.network).toBe(setup.consent?.network);
});
it("demo copies identify their execution network rather than relying on the selected UI mode", () => {
  expect(demoLiveItems().every(item => item.network === "testnet")).toBe(true);
});
