import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { copyExecutionAccounts, copyStrategies } from "@trading-dashboard/shared/database";
import { copyFundingSchema, copyFundingOverviewSchema } from "@trading-dashboard/shared/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyFundingController } from "../src/copy/copy-funding.controller.js";
import { CopyFundingRepository } from "../src/copy/copy-funding.repository.js";
import { CopyFundingService } from "../src/copy/copy-funding.service.js";
import { CopyFundingExchangeClient } from "../src/copy/copy-funding-exchange.client.js";
import { CopyWalletRepository } from "../src/copy/copy-wallet.repository.js";
import { CopyWalletService } from "../src/copy/copy-wallet.service.js";
import { USER_WALLET_PROVISIONER } from "../src/copy/live/privy-wallet-provisioner.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const db = getTestDb(), SOURCE = `0x${"11".repeat(20)}`, DEST = `0x${"22".repeat(20)}`;
const privy = stubPrivy({ alice: { privyUserId: "did:privy:funding-alice" }, bob: { privyUserId: "did:privy:funding-bob" } });
const provider = { available: true, create: vi.fn(), findOwned: vi.fn(async () => ({ id: "provider-wallet", address: DEST, externalId: "copy_funding_test", ownerQuorumId: "quorum" })) };
const exchange = { available: vi.fn(), acquire: vi.fn(), send: vi.fn(), txDetails: vi.fn() };
let app: INestApplication, auth: AuthService, uid: number;
const serviceToken = "funding-service-token-0123456789012345";
const path = "/me/copy/execution-wallets/test-account/funding";
const post = (route: string, body: object, token = "alice") => request(app.getHttpServer()).post(route).set("Authorization", `Bearer ${token}`).send(body);
beforeAll(async () => {
  vi.stubEnv("AUTH_SERVICE_TOKEN", serviceToken); vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "copy.read,execution.pause");
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyFundingController], providers: [CopyFundingService, CopyFundingRepository, CopyWalletService, CopyWalletRepository,
    { provide: USER_WALLET_PROVISIONER, useValue: provider }, { provide: CopyFundingExchangeClient, useValue: exchange }, { provide: HyperliquidInfoClient, useValue: { userNonFundingLedgerUpdates: vi.fn(async () => []) } }] }));
});
beforeEach(async () => {
  await truncateAll(db); auth.clearCache(); vi.clearAllMocks();
  uid = (await insertUser(db, { privyUserId: "did:privy:funding-alice", embeddedWalletAddress: SOURCE })).id;
  await insertUser(db, { privyUserId: "did:privy:funding-bob" });
  const strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: DEST, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0]!.id;
  await db.insert(copyExecutionAccounts).values({ id: "test-account", userId: uid, strategyId, network: "testnet", privyUserId: "did:privy:funding-alice", externalId: "copy_funding_test", state: "ready", address: DEST, privyWalletId: "provider-wallet", ownerQuorumId: "quorum" });
});
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });
describe("strategy funding authenticated HTTP boundary", () => {
  it("rejects anonymous and service principals on every endpoint without provider side effects", async () => {
    for (const token of [null, serviceToken]) {
      const get = request(app.getHttpServer()).get("/me/copy/funding"); if (token) get.set("Authorization", `Bearer ${token}`);
      await get.expect(token ? 403 : 401);
      const id = randomUUID();
      for (const [route, body] of [[path, { amount: "10", idempotencyKey: randomUUID() }], ...["broadcast", "cancel", "reconcile"].map((action) => [`/me/copy/funding/${id}/${action}`, {}]), [`/me/copy/funding/${id}/submit`, { signature: `0x${"11".repeat(64)}1b` }]] as [string, object][]) {
        const call = request(app.getHttpServer()).post(route).send(body); if (token) call.set("Authorization", `Bearer ${token}`); await call.expect(token ? 403 : 401);
      }
    }
    expect(provider.findOwned).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it("returns private canonical intent and owner-specific no-store overview", async () => {
    const response = await post(path, { amount: "12.500000", idempotencyKey: randomUUID() }).expect(200).expect("Cache-Control", "no-store");
    const operation = copyFundingSchema.parse(response.body.data); expect(operation).toMatchObject({ amount: "12.5", address: SOURCE, destination: DEST, status: "prepared" });
    const summary = await request(app.getHttpServer()).get("/me/copy/funding").set("Authorization", "Bearer alice").expect(200).expect("Cache-Control", "no-store");
    expect(copyFundingOverviewSchema.parse(summary.body.data).operations[0]!.id).toBe(operation.id);
    for (const action of ["broadcast", "cancel", "reconcile", "submit"]) await post(`/me/copy/funding/${operation.id}/${action}`, action === "submit" ? { signature: `0x${"11".repeat(64)}1b` } : {}, "bob").expect(404);
    expect(JSON.stringify(summary.body)).not.toMatch(/provider-wallet|did:privy|quorum|idempotencyKey/); expect(exchange.send).not.toHaveBeenCalled();
  });
  it("rejects malformed quantities and arbitrary destination/network/signing overrides", async () => {
    for (const amount of [10, "0", "-1", "1e2", "10.0000001", "NaN"]) await post(path, { amount, idempotencyKey: randomUUID() }).expect(400);
    for (const extra of [{ destination: SOURCE }, { network: "mainnet" }, { nonce: 1 }, { signature: "secret" }]) await post(path, { amount: "10", idempotencyKey: randomUUID(), ...extra }).expect(400);
    await post(path, { amount: "10", idempotencyKey: "bad" }).expect(400);
    await post("/me/copy/funding/not-a-uuid/submit", { signature: "bad" }).expect(400);
    await post(`/me/copy/funding/${randomUUID()}/submit`, { signature: "bad" }).expect(400);
    expect(exchange.send).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
  });
});
