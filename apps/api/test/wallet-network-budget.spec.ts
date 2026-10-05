import { describe, expect, it } from "vitest";

import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import type { HyperliquidGlobalTransport } from "../src/hyperliquid/hyperliquid-global-transport.js";
import { PostgresHyperliquidQuota } from "../src/hyperliquid/postgres-hyperliquid-quota.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { walletNetworkHyperliquid } from "../src/copy/copy.module.js";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", NODE_ENV: "test", HYPERLIQUID_EGRESS_KEY: "egress" };
const config = (env: Record<string, string>) => new AppConfig(validateEnvironment({ ...base, ...env }));
// Only the instance check runs at construction; nothing is read here.
const quota = Object.create(PostgresHyperliquidQuota.prototype) as PostgresHyperliquidQuota;
const transport = {} as HyperliquidGlobalTransport;

describe("the wallet network's Hyperliquid budget", () => {
  it("on testnet, copy setup calls get their own bucket and egress key instead of waiting behind the api's mainnet page traffic", () => {
    const cfg = config({ HYPERLIQUID_NETWORK: "testnet" });
    const main = new RequestBudgeterService(cfg);
    const wallet = walletNetworkHyperliquid(cfg, main, transport, quota);
    expect(wallet.budget).not.toBe(main);
    expect(wallet.transport).not.toBe(transport);
  });

  it("on mainnet, the wallet network is the mainnet host: the api's own budget and transport", () => {
    const cfg = config({ HYPERLIQUID_NETWORK: "mainnet" });
    const main = new RequestBudgeterService(cfg);
    const wallet = walletNetworkHyperliquid(cfg, main, transport, quota);
    expect(wallet.budget).toBe(main);
    expect(wallet.transport).toBe(transport);
  });
});
