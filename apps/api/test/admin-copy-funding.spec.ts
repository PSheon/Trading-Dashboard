import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminAuditLogs, copyExecutionAccounts, copyFundingOperations, copyStrategies } from "@trading-dashboard/shared/database";
import { adminResolvedCopyFundingSchema } from "@trading-dashboard/shared/contracts";
import { AdminCopyFundingController } from "../src/admin/admin-copy-funding.controller.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { CopyFundingRepository } from "../src/copy/copy-funding.repository.js";
import { CopyFundingService } from "../src/copy/copy-funding.service.js";
import { CopyFundingExchangeClient } from "../src/copy/copy-funding-exchange.client.js";
import { FUNDING_NONCE_EXPIRY_MS } from "../src/copy/copy-funding-scan.js";
import { CopyWalletRepository } from "../src/copy/copy-wallet.repository.js";
import { CopyWalletService } from "../src/copy/copy-wallet.service.js";
import { USER_WALLET_PROVISIONER } from "../src/copy/live/privy-wallet-provisioner.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { WithdrawalRepository } from "../src/wallet/withdrawal.repository.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const MAIN = `0x${"11".repeat(20)}`, ACCOUNT = `0x${"22".repeat(20)}`;
const ID = "55555555-5555-4555-8555-555555555555";
const OWN = `0x${"ab".repeat(32)}`, OTHER = `0x${"cd".repeat(32)}`;
const route = `/admin/copy/live/transfers/${ID}/resolve`;

describe("/admin/copy/live/transfers/:id/resolve — a stuck copy transfer's terminal state", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    admin: { privyUserId: "did:privy:f-admin", profile: { email: "ops@example.com", walletAddress: null, embeddedWalletAddress: null } },
    operator: { privyUserId: "did:privy:f-operator", profile: { email: "op@example.com", walletAddress: null, embeddedWalletAddress: null } },
    alice: { privyUserId: "did:privy:f-alice", profile: { email: "alice@example.com", walletAddress: null, embeddedWalletAddress: MAIN } },
  });
  const info = { userNonFundingLedgerUpdates: vi.fn(async () => [] as Array<{ time: number; hash: string; delta: Record<string, unknown> }>) };
  const exchange = { available: vi.fn(), acquire: vi.fn(), send: vi.fn(), txDetails: vi.fn(async (_network: string, _hash: string): Promise<unknown> => null) };
  let app: INestApplication, auth: AuthService, aliceId: number, nonce: number;
  const as = (token: string) => (body: object) => request(app.getHttpServer()).post(route).set("Authorization", `Bearer ${token}`).send(body);
  const transfer = (hash: string, time: number) => ({ hash, time: time + 50, delta: { type: "internalTransfer", user: MAIN, destination: ACCOUNT, usdc: "12.5", fee: "1" } });
  const details = (hash: string, time: number, amount = "12.5") => ({ type: "txDetails", tx: { hash, user: MAIN, error: null, time: time + 50,
    action: { type: "usdSend", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination: ACCOUNT, amount, time } } });
  beforeAll(async () => {
    ({ app, auth } = await createAuthedApp({ db, privy, controllers: [AdminCopyFundingController], providers: [CopyFundingService, CopyFundingRepository, CopyWalletService, CopyWalletRepository,
      { provide: USER_WALLET_PROVISIONER, useValue: { available: true, create: vi.fn(), findOwned: vi.fn() } }, { provide: CopyFundingExchangeClient, useValue: exchange },
      { provide: HyperliquidInfoClient, useValue: info }] }));
  });
  async function seed(ageMs: number, status: "unknown" | "accepted" = "unknown") {
    nonce = Date.now() - ageMs;
    const strategyId = (await db.insert(copyStrategies).values({ userId: aliceId, leaderAddress: ACCOUNT, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0]!.id;
    await db.insert(copyExecutionAccounts).values({ id: "test-account", userId: aliceId, strategyId, network: "testnet", privyUserId: "did:privy:f-alice", externalId: "copy_funding_test", state: "ready", address: ACCOUNT, privyWalletId: "provider-wallet", ownerQuorumId: "quorum" });
    await db.insert(copyFundingOperations).values({ id: ID, userId: aliceId, accountId: "test-account", strategyId, idempotencyKey: "k", network: "testnet", address: MAIN, destination: ACCOUNT,
      amount: "12.5", nonce, status, claimedAt: new Date(nonce), attemptedAt: new Date(nonce), evidenceHash: status === "accepted" ? "e".repeat(64) : null });
  }
  const row = async () => (await db.select().from(copyFundingOperations).where(eq(copyFundingOperations.id, ID)))[0]!;
  const code = (res: request.Response) => (res.body as { error?: { code?: string }; code?: string }).error?.code ?? (res.body as { code?: string }).code;
  beforeEach(async () => {
    await truncateAll(db); auth.clearCache(); info.userNonFundingLedgerUpdates.mockReset().mockResolvedValue([]); exchange.txDetails.mockReset().mockResolvedValue(null);
    await insertUser(db, { privyUserId: "did:privy:f-admin", email: "ops@example.com", role: "admin" });
    await insertUser(db, { privyUserId: "did:privy:f-operator", email: "op@example.com", role: "operator" });
    aliceId = (await insertUser(db, { privyUserId: "did:privy:f-alice", email: "alice@example.com", embeddedWalletAddress: MAIN })).id;
  });
  afterAll(async () => { await app.close(); await closeTestDb(); });

  it("refuses an operator (no users.manage) and the owner, and any resolution inside the nonce window", async () => {
    await seed(60_000);
    const body = { evidence: "ledger_absent_after_nonce_expiry", reason: "lost answer" };
    await as("operator")(body).expect(403);
    await as("alice")(body).expect(403);
    expect(code(await as("admin")(body).expect(409))).toBe("funding_nonce_window_open");
    expect(info.userNonFundingLedgerUpdates).not.toHaveBeenCalled();
    expect((await row()).status).toBe("unknown");
    expect(await db.select().from(adminAuditLogs)).toEqual([]);
  });

  it("after the window, every transfer between the accounts proven another operation → rejected: audited, the main wallet free again", async () => {
    await seed(FUNDING_NONCE_EXPIRY_MS + 60_000);
    // An earlier credited deposit (another nonce) is on the ledger.
    info.userNonFundingLedgerUpdates.mockResolvedValue([transfer(OTHER, nonce - 3_600_000)]);
    exchange.txDetails.mockResolvedValue(details(OTHER, nonce - 3_600_000));
    const resolved = adminResolvedCopyFundingSchema.parse((await as("admin")({ evidence: "ledger_absent_after_nonce_expiry", reason: "exchange answer lost; ledger checked" }).expect(200)).body.data);
    expect(resolved).toEqual({ id: ID, status: "rejected", evidence: "ledger_absent_after_nonce_expiry" });
    expect((await row())).toMatchObject({ status: "rejected", transactionHash: null });
    expect((await row()).evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    const [audit] = await db.select().from(adminAuditLogs);
    expect(audit).toMatchObject({ event: "copy.funding.resolve", target: `funding:${ID}`, actorKind: "user",
      beforeJson: expect.objectContaining({ status: "unknown", userId: aliceId }), afterJson: expect.objectContaining({ status: "rejected", reason: "exchange answer lost; ledger checked" }) });
    await expect(new WithdrawalRepository(db).reserve({ userId: aliceId, network: "testnet", address: MAIN }, { destination: ACCOUNT, amount: "20" })).resolves.toBeTruthy();
    // Once resolved, it is final.
    expect(code(await as("admin")({ evidence: "ledger_absent_after_nonce_expiry", reason: "again" }).expect(409))).toBe("funding_not_unresolved");
  });

  it.each([
    ["details that cannot be read", null, "funding_ledger_ambiguous"],
    ["the same nonce with another amount", "same-nonce", "funding_ledger_ambiguous"],
    ["this transfer's own receipt", "own", "funding_ledger_has_receipt"],
  ] as const)("refuses 'never executed' when a transfer between the accounts has %s", async (_label, variant, expected) => {
    await seed(FUNDING_NONCE_EXPIRY_MS + 60_000);
    info.userNonFundingLedgerUpdates.mockResolvedValue([transfer(OWN, nonce)]);
    exchange.txDetails.mockResolvedValue(variant === null ? null : details(OWN, nonce, variant === "own" ? "12.5" : "13"));
    expect(code(await as("admin")({ evidence: "ledger_absent_after_nonce_expiry", reason: "check" }).expect(409))).toBe(expected);
    expect((await row()).status).toBe("unknown");
    expect(await db.select().from(adminAuditLogs)).toEqual([]);
  });

  it("credits with the operator's named receipt only when it proves this transfer (also an accepted one)", async () => {
    await seed(FUNDING_NONCE_EXPIRY_MS + 60_000, "accepted");
    expect(code(await as("admin")({ evidence: "ledger_absent_after_nonce_expiry", reason: "check" }).expect(409))).toBe("funding_accepted");
    info.userNonFundingLedgerUpdates.mockResolvedValue([transfer(OWN, nonce), transfer(OTHER, nonce - 1000)]);
    exchange.txDetails.mockImplementation(async (_network, hash) => details(hash, hash === OWN ? nonce : nonce - 1000));
    expect(code(await as("admin")({ evidence: "ledger_receipt", transactionHash: OTHER, reason: "check" }).expect(409))).toBe("funding_receipt_unproven");
    expect(code(await as("admin")({ evidence: "ledger_receipt", transactionHash: `0x${"ef".repeat(32)}`, reason: "check" }).expect(409))).toBe("funding_receipt_unproven");
    const resolved = adminResolvedCopyFundingSchema.parse((await as("admin")({ evidence: "ledger_receipt", transactionHash: OWN, reason: "receipt found" }).expect(200)).body.data);
    expect(resolved).toEqual({ id: ID, status: "credited", evidence: "ledger_receipt" });
    expect(await row()).toMatchObject({ status: "credited", transactionHash: OWN, creditedAmount: "11.5", fee: "1" });
    const [audit] = await db.select().from(adminAuditLogs);
    expect(audit).toMatchObject({ event: "copy.funding.resolve", afterJson: expect.objectContaining({ status: "credited", transactionHash: OWN, reason: "receipt found" }) });
  });

  it("validates the body (evidence, hash, reason)", async () => {
    await seed(FUNDING_NONCE_EXPIRY_MS + 60_000);
    await as("admin")({ evidence: "guess", reason: "check" }).expect(400);
    await as("admin")({ evidence: "ledger_receipt", reason: "check" }).expect(400);
    await as("admin")({ evidence: "ledger_absent_after_nonce_expiry", reason: "x" }).expect(400);
    expect((await row()).status).toBe("unknown");
  });

  it("reads the whole ledger: a full page reads on from its last time without doubling that time's rows", async () => {
    await seed(FUNDING_NONCE_EXPIRY_MS + 60_000);
    const start = nonce - 86_400_000;
    const page = Array.from({ length: 500 }, (_, i) => ({ time: start + 1 + i, hash: `0x${(i + 1).toString(16).padStart(64, "0")}`, delta: { type: "deposit", usdc: "1" } }));
    const boundary = page.at(-1)!;
    info.userNonFundingLedgerUpdates.mockResolvedValueOnce(page).mockResolvedValueOnce([boundary, transfer(OWN, nonce)]);
    exchange.txDetails.mockResolvedValue(details(OWN, nonce));
    expect((await as("admin")({ evidence: "ledger_receipt", transactionHash: OWN, reason: "check" }).expect(200)).body.data.status).toBe("credited");
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledTimes(2);
    expect((info.userNonFundingLedgerUpdates.mock.calls[1] as unknown[])[1]).toBe(boundary.time);
  });
});
