import { afterEach, expect, it, vi } from "vitest";
import { testConfig } from "./config-test-utils.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { TradeFeedService } from "../src/watcher/trade-feed.service.js";
import { offlineGlobalTransport } from './hyperliquid-quota-test-utils.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("can initialize the live market feed while a heavy history request awaits budget", async () => {
  vi.useFakeTimers();
  vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "600");
  vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "100");
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Response(JSON.stringify(JSON.parse(init.body).type === "perpDexs" ? [null] : [{universe: [{name: "BTC", isDelisted: false, szDecimals: 5, maxLeverage: 50}]}]), {status: 200, headers: {"content-type": "application/json"}})));
  const config = testConfig();
  const budget = new RequestBudgeterService(config);
  try {
    await budget.acquire(100, "live");
    void budget.acquire(120, "background", 1000).catch(() => undefined);
    const feed = new TradeFeedService(config, new HyperliquidInfoClient(config, budget, undefined, offlineGlobalTransport().transport));
    let coins: string[] | undefined;
    let failure: unknown;
    void feed.listMarkets().then(value => { coins = value; }).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(6000);
    expect(failure).toBeUndefined();
    expect(coins).toEqual(["BTC"]);
  } finally { budget.onModuleDestroy(); }
});
