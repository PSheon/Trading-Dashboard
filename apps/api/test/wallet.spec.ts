import type { INestApplication } from "@nestjs/common";
import { users } from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { ArbitrumBalanceClient } from "../src/wallet/arbitrum-balance.client.js";
import { WalletController } from "../src/wallet/wallet.controller.js";
import { WalletRepository } from "../src/wallet/wallet.repository.js";
import { WalletService } from "../src/wallet/wallet.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "service-token-for-wallet-tests-0123456789";
const EMBEDDED = "0x" + "e1".repeat(20);
const TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";

describe("/me/wallet — real controller/service/repository, real Postgres, stubbed Privy / Hyperliquid / RPC", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": {
      privyUserId: "did:privy:alice",
      profile: { email: "alice@example.com", walletAddress: null, embeddedWalletAddress: EMBEDDED },
    },
    // Signed up before every account got an embedded wallet.
    "bob-token": { privyUserId: "did:privy:bob", profile: { email: "bob@example.com", walletAddress: null, embeddedWalletAddress: null } },
  });
  const info = {
    clearinghouseState: vi.fn(async () => ({
      assetPositions: [],
      marginSummary: { accountValue: "1250.5", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "1250.5" },
      crossMarginSummary: { accountValue: "1250.5", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "1250.5" },
      withdrawable: "1180.25",
      time: Date.now(),
    })),
    spotClearinghouseState: vi.fn(async () => ({ balances: [{ coin: "USDC", total: "64.5", hold: "4.5", entryNtl: "0" }] })),
    userNonFundingLedgerUpdates: vi.fn(async () => [
      { time: Date.now() - 86_400_000, hash: "0x" + "aa".repeat(32), delta: { type: "deposit", usdc: "1500" } },
      { time: Date.now() - 3_600_000, hash: "0x" + "bb".repeat(32), delta: { type: "withdraw", usdc: "120", nonce: 1, fee: "1" } },
    ]),
  };
  const arbitrum = { balances: vi.fn(async () => ({ usdc: 25, eth: 0.001 })) };
  let app: INestApplication;
  let auth: AuthService;
  let wallet: WalletService;

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
    ({ app, auth } = await createAuthedApp({
      db,
      privy,
      controllers: [WalletController],
      providers: [
        WalletRepository,
        WalletService,
        { provide: HyperliquidInfoClient, useValue: info },
        { provide: ArbitrumBalanceClient, useValue: arbitrum },
      ],
    }));
    wallet = app.get(WalletService);
  });

  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
    wallet.summaryCache.clear();
    wallet.historyCache.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    delete process.env.AUTH_SERVICE_TOKEN;
    await app.close();
    await closeTestDb();
  });

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  it("needs a signed-in person: 401 anonymous, 403 service token", async () => {
    await get("/me/wallet").expect(401);
    await get("/me/wallet/history").expect(401);
    await get("/me/wallet", SERVICE_TOKEN).expect(403);
  });

  it("stores the Privy embedded wallet at sign-up and reads its balances on the wallet network", async () => {
    const res = await get("/me/wallet", "alice-token").expect(200);
    const body = res.body.data;
    expect(body).toMatchObject({
      network: "testnet",
      address: EMBEDDED,
      hyperliquid: { perpValue: 1250.5, withdrawable: 1180.25, spotUsdc: 64.5, spotUsdcHold: 4.5 },
      arbitrum: { usdc: 25, eth: 0.001 },
      totalValue: 1250.5 + 64.5 + 25,
    });
    // The wallet network's info host, under the shared budget (page rank 0).
    expect(info.clearinghouseState).toHaveBeenCalledWith(EMBEDDED, undefined, "background", 0, TESTNET_INFO);
    expect(info.spotClearinghouseState).toHaveBeenCalledWith(EMBEDDED, "background", 0, TESTNET_INFO);
    const [row] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
    expect(row.embeddedWalletAddress).toBe(EMBEDDED);
  });

  it("caches balances per address (one Hyperliquid read for back-to-back requests)", async () => {
    await get("/me/wallet", "alice-token").expect(200);
    await get("/me/wallet", "alice-token").expect(200);
    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
  });

  it("answers without balances while Privy has no wallet, then picks it up from Privy (not the client)", async () => {
    const first = await get("/me/wallet", "bob-token").expect(200);
    expect(first.body.data).toMatchObject({ address: null, hyperliquid: null, arbitrum: null, totalValue: 0 });
    expect(info.clearinghouseState).not.toHaveBeenCalled();

    // The browser created the wallet; Privy now reports it.
    const bobWallet = "0x" + "b0".repeat(20);
    privy.fetchProfile.mockResolvedValueOnce({ email: "bob@example.com", walletAddress: null, embeddedWalletAddress: bobWallet });
    const [bob] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:bob"));
    // Skip the per-user retry window.
    (wallet as unknown as { addressRetryAt: Map<number, number> }).addressRetryAt.delete(bob.id);
    const second = await get("/me/wallet", "bob-token").expect(200);
    expect(second.body.data.address).toBe(bobWallet);
  });

  it("an Arbitrum RPC failure only nulls the Arbitrum part", async () => {
    arbitrum.balances.mockRejectedValueOnce(new Error("rpc down"));
    const res = await get("/me/wallet", "alice-token").expect(200);
    expect(res.body.data.arbitrum).toBeNull();
    expect(res.body.data.totalValue).toBe(1250.5 + 64.5);
  });

  it("a Hyperliquid failure is a 502, not a zero balance", async () => {
    info.clearinghouseState.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 500"));
    await get("/me/wallet", "alice-token").expect(502);
  });

  it("history maps the ledger newest first on the wallet network", async () => {
    const res = await get("/me/wallet/history", "alice-token").expect(200);
    const body = res.body.data;
    expect(body.network).toBe("testnet");
    expect(body.transfers.map((t: { kind: string }) => t.kind)).toEqual(["withdraw", "deposit"]);
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledWith(EMBEDDED, expect.any(Number), undefined, "background", 2, TESTNET_INFO);
  });
});
