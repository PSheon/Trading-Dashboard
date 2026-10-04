import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminAuditLogs, copyEvents, walletWithdrawals } from "@trading-dashboard/shared/database";
import { WITHDRAWAL_NONCE_WINDOW_MS, adminResolvedWithdrawalSchema, adminUnresolvedWithdrawalsSchema } from "@trading-dashboard/shared/contracts";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { ArbitrumBalanceClient } from "../src/wallet/arbitrum-balance.client.js";
import { AdminWithdrawalController } from "../src/wallet/admin-withdrawal.controller.js";
import { WalletRepository } from "../src/wallet/wallet.repository.js";
import { WalletService } from "../src/wallet/wallet.service.js";
import { WithdrawalController } from "../src/wallet/withdrawal.controller.js";
import { WithdrawalRepository } from "../src/wallet/withdrawal.repository.js";
import { WithdrawalExchangeClient } from "../src/wallet/withdrawal-exchange.client.js";
import { WithdrawalService } from "../src/wallet/withdrawal.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const MAIN = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const DEST = `0x${"22".repeat(20)}`;
const ID = "44444444-4444-4444-8444-444444444444";

describe("/admin/wallet/withdrawals — an unknown withdrawal's terminal state", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    admin: { privyUserId: "did:privy:w-admin", profile: { email: "ops@example.com", walletAddress: null, embeddedWalletAddress: null } },
    operator: { privyUserId: "did:privy:w-operator", profile: { email: "op@example.com", walletAddress: null, embeddedWalletAddress: null } },
    alice: { privyUserId: "did:privy:alice", profile: { email: "alice@example.com", walletAddress: null, embeddedWalletAddress: MAIN } },
  });
  const info = { userNonFundingLedgerUpdates: vi.fn(async () => [] as Array<{ time: number; hash: string; delta: Record<string, unknown> }>) };
  let app: INestApplication;
  let auth: AuthService;
  let aliceId: number;
  const as = (token: string) => ({
    get: (p: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${token}`),
    post: (p: string, body: object = {}) => request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${token}`).send(body),
  });
  beforeAll(async () => {
    ({ app, auth } = await createAuthedApp({ db, privy, controllers: [WithdrawalController, AdminWithdrawalController], providers: [
      WalletRepository, WalletService, WithdrawalRepository, WithdrawalService,
      { provide: WithdrawalExchangeClient, useValue: { acquire: vi.fn(), send: vi.fn() } },
      { provide: HyperliquidInfoClient, useValue: info }, { provide: ArbitrumBalanceClient, useValue: {} },
    ] }));
  });
  async function seed(ageMs: number) {
    const nonce = Date.now() - ageMs;
    await db.insert(walletWithdrawals).values({ id: ID, userId: aliceId, network: "testnet", address: MAIN, destination: DEST, amount: "12.5", nonce, status: "unknown", origin: "client", claimedAt: new Date(nonce), attemptedAt: new Date(nonce) });
    return nonce;
  }
  beforeEach(async () => {
    await truncateAll(db); auth.clearCache(); info.userNonFundingLedgerUpdates.mockReset().mockResolvedValue([]);
    await insertUser(db, { privyUserId: "did:privy:w-admin", email: "ops@example.com", role: "admin" });
    await insertUser(db, { privyUserId: "did:privy:w-operator", email: "op@example.com", role: "operator" });
    aliceId = (await insertUser(db, { privyUserId: "did:privy:alice", email: "alice@example.com", embeddedWalletAddress: MAIN })).id;
  });
  afterAll(async () => { await app.close(); await closeTestDb(); });

  it("lists it with when it becomes resolvable; the address stays refused until then", async () => {
    const nonce = await seed(60_000);
    const list = adminUnresolvedWithdrawalsSchema.parse((await as("operator").get("/admin/wallet/withdrawals/unresolved").expect(200)).body.data);
    expect(list.items).toEqual([expect.objectContaining({ id: ID, userId: aliceId, email: "alice@example.com", attempted: true, resolvableAt: new Date(nonce + WITHDRAWAL_NONCE_WINDOW_MS).toISOString() })]);
    await as("alice").post("/me/wallet/withdrawals", { destination: DEST, amount: "3" }).expect(409);
    // An operator reads, never resolves; an admin may not resolve inside the window.
    await as("operator").post(`/admin/wallet/withdrawals/${ID}/resolve`, { reason: "lost answer" }).expect(403);
    const early = await as("admin").post(`/admin/wallet/withdrawals/${ID}/resolve`, { reason: "lost answer" }).expect(409);
    expect(early.body.error?.code ?? early.body.code).toBe("withdrawal_nonce_window_open");
    expect(info.userNonFundingLedgerUpdates).not.toHaveBeenCalled();
  });

  it("after the window, a ledger with no such withdraw makes it not_executed: audited, the owner told, the address free again", async () => {
    await seed(WITHDRAWAL_NONCE_WINDOW_MS + 60_000);
    const resolved = adminResolvedWithdrawalSchema.parse((await as("admin").post(`/admin/wallet/withdrawals/${ID}/resolve`, { reason: "exchange answer lost; ledger checked" }).expect(200)).body.data);
    expect(resolved).toEqual({ id: ID, status: "not_executed", evidence: "ledger_absent_after_nonce_window" });
    const [row] = await db.select().from(walletWithdrawals).where(eq(walletWithdrawals.id, ID));
    expect(row).toMatchObject({ status: "not_executed" });
    expect(row.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    const [audit] = await db.select().from(adminAuditLogs);
    expect(audit).toMatchObject({ event: "wallet.withdrawal.resolve", target: `withdrawal:${ID}`, afterJson: expect.objectContaining({ status: "not_executed", reason: "exchange answer lost; ledger checked" }) });
    expect(await db.select().from(copyEvents)).toEqual([expect.objectContaining({ userId: aliceId, type: "wallet_withdrawal", payload: expect.objectContaining({ status: "not_executed" }) })]);
    await as("alice").post("/me/wallet/withdrawals", { destination: DEST, amount: "3" }).expect(200);
    // Once resolved, it is final.
    await as("admin").post(`/admin/wallet/withdrawals/${ID}/resolve`, { reason: "again" }).expect(409);
  });

  it("a ledger that has the withdraw makes it accepted instead", async () => {
    const nonce = await seed(WITHDRAWAL_NONCE_WINDOW_MS + 60_000);
    info.userNonFundingLedgerUpdates.mockResolvedValue([{ time: nonce + 1000, hash: `0x${"ab".repeat(32)}`, delta: { type: "withdraw", usdc: "11.5", fee: "1.0", nonce: nonce * 1000 } }]);
    const resolved = adminResolvedWithdrawalSchema.parse((await as("admin").post(`/admin/wallet/withdrawals/${ID}/resolve`, { reason: "check" }).expect(200)).body.data);
    expect(resolved.status).toBe("accepted");
    expect(resolved.evidence).toBe("ledger_match");
  });

  it("refuses to call it not executed when the ledger has a withdraw with its nonce that does not match exactly", async () => {
    const nonce = await seed(WITHDRAWAL_NONCE_WINDOW_MS + 60_000);
    info.userNonFundingLedgerUpdates.mockResolvedValue([{ time: nonce + 1000, hash: `0x${"ab".repeat(32)}`, delta: { type: "withdraw", usdc: "99", nonce } }]);
    const res = await as("admin").post(`/admin/wallet/withdrawals/${ID}/resolve`, { reason: "check" }).expect(409);
    expect(res.body.error?.code ?? res.body.code).toBe("withdrawal_ledger_ambiguous");
    expect((await db.select().from(walletWithdrawals))[0]).toMatchObject({ status: "unknown" });
  });

  it("reads the whole ledger from the nonce on: a full page is followed by the next", async () => {
    const nonce = await seed(WITHDRAWAL_NONCE_WINDOW_MS + 60_000);
    const page = Array.from({ length: 500 }, (_, i) => ({ time: nonce + i, hash: `0x${"cd".repeat(32)}`, delta: { type: "deposit", usdc: "1" } }));
    info.userNonFundingLedgerUpdates.mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ time: nonce + 9000, hash: `0x${"ab".repeat(32)}`, delta: { type: "withdraw", usdc: "12.5", nonce } }]);
    const resolved = adminResolvedWithdrawalSchema.parse((await as("admin").post(`/admin/wallet/withdrawals/${ID}/resolve`, { reason: "check" }).expect(200)).body.data);
    expect(resolved.status).toBe("accepted");
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledTimes(2);
    expect((info.userNonFundingLedgerUpdates.mock.calls[1] as unknown[])[1]).toBe(nonce + 500);
  });
});
