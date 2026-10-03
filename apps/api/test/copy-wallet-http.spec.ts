import type { INestApplication } from "@nestjs/common";
import { copyExecutionAccounts, copyStrategies } from "@trading-dashboard/shared/database";
import { copyExecutionAccountSchema, copyExecutionWalletsSchema } from "@trading-dashboard/shared/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyWalletController } from "../src/copy/copy-wallet.controller.js";
import { CopyWalletRepository } from "../src/copy/copy-wallet.repository.js";
import { CopyWalletService } from "../src/copy/copy-wallet.service.js";
import { USER_WALLET_PROVISIONER, type ProvisionedUserWallet } from "../src/copy/live/privy-wallet-provisioner.js";
import { AccountRepository } from "../src/users/account.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const db = getTestDb();
const privy = stubPrivy({ alice: { privyUserId: "did:privy:wallet-alice" }, bob: { privyUserId: "did:privy:wallet-bob" } });
const provider = { available: true, create: vi.fn(), findOwned: vi.fn<() => Promise<ProvisionedUserWallet | null>>() };
let app: INestApplication;
let auth: AuthService;
let strategy: number;
let uid: number;
const serviceToken = "wallet-service-token-0123456789012345";
const endpoint = () => `/me/copy/strategies/${strategy}/execution-wallet`;
beforeAll(async () => {
  vi.stubEnv("AUTH_SERVICE_TOKEN", serviceToken);
  vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "copy.read,execution.pause");
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyWalletController], providers: [CopyWalletService, CopyWalletRepository, { provide: USER_WALLET_PROVISIONER, useValue: provider }] }));
});
beforeEach(async () => {
  await truncateAll(db);
  auth.clearCache();
  uid = (await insertUser(db, { privyUserId: "did:privy:wallet-alice" })).id;
  await insertUser(db, { privyUserId: "did:privy:wallet-bob" });
  strategy = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: `0x${"11".repeat(20)}`, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  provider.create.mockReset().mockResolvedValue(undefined);
  provider.findOwned.mockReset().mockResolvedValue(null);
});
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });

describe("execution wallet user API", () => {
  it("anonymous and service principals cannot read or mutate user wallets", async () => {
    for (const token of [null, serviceToken]) {
      const code = token ? 403 : 401;
      const get = request(app.getHttpServer()).get("/me/copy/execution-wallets");
      const post = request(app.getHttpServer()).post(endpoint()).send({ network: "testnet" });
      if (token) { get.set("Authorization", `Bearer ${token}`); post.set("Authorization", `Bearer ${token}`); }
      await get.expect(code);
      await post.expect(code);
    }
    expect(provider.create).not.toHaveBeenCalled();
    expect(await db.select().from(copyExecutionAccounts)).toHaveLength(0);
  });
  it("validates network, owner and path before any provider side effect", async () => {
    const send = (path: string, body: object, token = "alice") => request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body);
    await send(endpoint(), { network: "invalid" }).expect(400);
    await send(endpoint(), { network: "testnet", accountAddress: `0x${"33".repeat(20)}` }).expect(400);
    await send("/me/copy/strategies/0/execution-wallet", { network: "testnet" }).expect(400);
    await send(endpoint(), { network: "mainnet" }).expect(409);
    await send(endpoint(), { network: "testnet" }, "bob").expect(404);
    await send("/me/copy/wallet-authorizations/foreign/revoke", {}).expect(404);
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("returns validated safe state and permits only the owner to recover it", async () => {
    provider.create.mockRejectedValueOnce(new Error("Sensitive provider data"));
    const response = await request(app.getHttpServer()).post(endpoint()).set("Authorization", "Bearer alice").send({ network: "testnet" }).expect(200);
    const result = copyExecutionAccountSchema.parse(response.body.data);
    expect(result).toMatchObject({ state: "unknown", address: null, issue: "provider_unavailable" });
    expect(JSON.stringify(response.body)).not.toContain("Sensitive");
    await request(app.getHttpServer()).post(`/me/copy/execution-wallets/${result.id}/reconcile`).set("Authorization", "Bearer bob").send({}).expect(404);
    const summary = await request(app.getHttpServer()).get("/me/copy/execution-wallets").set("Authorization", "Bearer alice").expect(200).expect("Cache-Control", "no-store");
    expect(copyExecutionWalletsSchema.parse(summary.body.data).accounts[0].id).toBe(result.id);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it("retains execution account evidence in the account deletion guard", async () => {
    const result = await app.get(CopyWalletService).prepare(uid, strategy, { network: "testnet" });
    expect(result.state).toBe("unknown");
    const repo = new AccountRepository(db);
    await expect(new UnitOfWork(db).run((tx) => repo.hasExecutionRecords(tx, uid))).resolves.toBe(true);
  });
});
