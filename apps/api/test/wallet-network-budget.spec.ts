import { describe, expect, it } from "vitest";

import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import type { HyperliquidGlobalTransport } from "../src/hyperliquid/hyperliquid-global-transport.js";
import { PostgresHyperliquidQuota } from "../src/hyperliquid/postgres-hyperliquid-quota.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
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
    const info = new HyperliquidInfoClient(cfg, main), wallet = walletNetworkHyperliquid(cfg, main, transport, quota, info);
    expect(wallet.budget).not.toBe(main);
    expect(wallet.transport).not.toBe(transport);
    // Wallet balances, ledgers, withdrawals and copy funding scans read
    // through this client: a testnet 429 no longer halves the mainnet budget.
    expect(wallet.dedicated).toBe(true); expect(wallet.info).not.toBe(info);
    expect((wallet.info as unknown as { budgeter: unknown }).budgeter).toBe(wallet.budget);
    expect(wallet.budget.introspect()).toMatchObject({ configuredBudgetPerMin: 300, burstCapacity: 900 });
  });

  it("on mainnet, the wallet network is the mainnet host: the api's own budget and transport", () => {
    const cfg = config({ HYPERLIQUID_NETWORK: "mainnet" });
    const main = new RequestBudgeterService(cfg);
    const info = new HyperliquidInfoClient(cfg, main), wallet = walletNetworkHyperliquid(cfg, main, transport, quota, info);
    expect(wallet.budget).toBe(main);
    expect(wallet.transport).toBe(transport);
    expect(wallet.dedicated).toBe(false); expect(wallet.info).toBe(info);
  });
});
