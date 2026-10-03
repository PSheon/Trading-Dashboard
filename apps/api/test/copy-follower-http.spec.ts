import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFollowerStatementSchema } from "@trading-dashboard/shared/contracts";
import { copyExecutionAccounts, copyExecutionWallets, copyStrategies, copyLiveExecutions, copyFollowerScans, copyFollowerReceipts, copyFollowerLedger, copyWalletAuthorizations, users } from "@trading-dashboard/shared/database";
import { CopyFollowerController } from "../src/copy/copy-follower.controller.js";
import { CopyFollowerStatementRepository } from "../src/copy/copy-follower-statement.repository.js";
import { CopyFollowerStatementService } from "../src/copy/copy-follower-statement.service.js";
import { CopyFollowerActivityService } from "../src/copy/copy-follower-activity.service.js";
import { CopyFollowerActivityRepository } from "../src/copy/copy-follower-activity.repository.js";
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from '../src/copy/live/live-order.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import { CopyFollowerLedger } from "../src/copy/live/copy-follower-ledger.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

// No provider/signer is registered: this route reads actual persisted evidence.
const db = getTestDb(), accountId = "statement-account", address = `0x${"11".repeat(20)}`, otherAddress = `0x${"22".repeat(20)}`;
const serviceToken = "follower-http-service-token-0123456789012345";
const privy = stubPrivy({ alice: { privyUserId: "did:privy:statement-alice" }, bob: { privyUserId: "did:privy:statement-bob" }, expired: { privyUserId: "did:privy:statement-alice", expiresAt: new Date(0) } });
let app: INestApplication, auth: AuthService, uid: number, otherUid: number, strategyId: number, ledger: CopyFollowerLedger;
const path = (id = accountId) => `/me/copy/execution-wallets/${id}/statement`;
const get = (id = accountId, token = "alice") => request(app.getHttpServer()).get(path(id)).set("Authorization", `Bearer ${token}`);
const fill = () => ({ coin: "BTC", tid: 1, oid: 7, side: "B", time: Date.now() - 1000, px: "20000", sz: "0.01", closedPnl: "2", fee: "0.06", builderFee: "0.02", feeToken: "USDC" });
beforeAll(async () => {
  vi.stubEnv("AUTH_SERVICE_TOKEN", serviceToken); vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "copy.read,execution.pause");
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyFollowerController], providers: [CopyFollowerStatementService, CopyFollowerStatementRepository, CopyFollowerActivityService, CopyFollowerActivityRepository] }));
  ledger = new CopyFollowerLedger(db, new UnitOfWork(db));
});
beforeEach(async () => {
  await truncateAll(db); auth.clearCache();
  uid = (await insertUser(db, { privyUserId: "did:privy:statement-alice" })).id;
  otherUid = (await insertUser(db, { privyUserId: "did:privy:statement-bob" })).id;
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: otherAddress, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: "testnet", privyUserId: "did:privy:statement-alice", externalId: "private-external-id", state: "ready", address, privyWalletId: "private-provider-wallet", ownerQuorumId: "private-owner-quorum" });
});
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });

describe("actual follower statement authenticated HTTP boundary", () => {
  it("rejects anonymous, invalid, expired and service principals without exposing stored money", async () => {
    await ledger.bookFill(accountId, fill());
    for (const token of [null, "invalid", "expired", serviceToken]) {
      const call = request(app.getHttpServer()).get(path()); if (token) call.set("Authorization", `Bearer ${token}`);
      const response = await call.expect(token === serviceToken ? 403 : 401); expect(response.body).not.toHaveProperty("data.actual"); expect(JSON.stringify(response.body)).not.toContain(address);
    }
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(1); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });

  it("returns an honest empty canonical no-store statement without equity or a completeness claim", async () => {
    const response = await get().expect(200).expect("Cache-Control", "no-store"), statement = copyFollowerStatementSchema.parse(response.body.data);
    expect(statement).toMatchObject({ accountId, strategyId, network: "testnet", accountAddress: address, token: "USDC", receiptCount: "0", actual: { realizedPnl: "0", exchangeFee: "0", builderFee: "0", funding: "0", tradingCashDelta: "0" }, coverage: { historicalCompleteness: "unproven", scannedThrough: null, unresolvedWindows: null, issue: null, updatedAt: null }, latestReceipts: [] });
    expect(statement).not.toHaveProperty("equity"); expect(statement).not.toHaveProperty("paperBalance"); expect(JSON.stringify(response.body)).not.toMatch(/private-provider-wallet|private-owner-quorum|private-external-id|did:privy/);
  });

  it("returns exact actual fee/funding components while retaining unresolved scan coverage", async () => {
    const receipt = fill(), createdAt = receipt.time - 1000;
    const market = { network: 'testnet' as const, coin: 'BTC', dex: '', asset: 0, universeIndex: 0, perpDexIndex: 0, sizeDecimals: 5, maxLeverage: 20, observedAt: createdAt };
    const intent: LiveOrderIntent = { authorizationId: 'statement-grant', userId: uid, strategyId, walletId: 'statement-agent', network: 'testnet', accountAddress: address as `0x${string}`, reduceOnly: false,
      cloid: `0x${'33'.repeat(16)}`, asset: 0, side: 'B', size: '0.01', limitPrice: '20000', sizeDecimals: 5, timeInForce: 'Ioc', market };
    const action = buildOrderAction(intent), key = executionKey(intent);
    const record: LiveExecutionRecord = { key, fingerprint: intentFingerprint(intent, action), market, action, nonce: createdAt, expiresAfter: createdAt + 60000, state: 'partial', createdAt, updatedAt: createdAt,
      authorization: { id: 'statement-grant', version: 1, userId: uid, strategyId, walletId: 'statement-agent', privyOwnerId: 'statement-agent-owner', signerAddress: otherAddress as `0x${string}`, accountAddress: intent.accountAddress,
        network: 'testnet', scopes: ['copy:trade'], validFrom: createdAt - 1, expiresAt: createdAt + 60000, revokedAt: null, exchangeApprovedAt: createdAt - 1 }, outcome: { state: 'partial', exchangeOrderId: '7' } };
    await db.insert(copyExecutionWallets).values({ id: 'statement-local-agent', userId: uid, strategyId, network: 'testnet', accountAddress: address, privyWalletId: 'statement-agent', privyOwnerId: 'statement-agent-owner', signerAddress: otherAddress });
    await db.insert(copyWalletAuthorizations).values({ id: 'statement-grant', walletId: 'statement-local-agent', version: 1, scopes: ['copy:trade'], validFrom: new Date(createdAt - 1), expiresAt: new Date(createdAt + 60000) });
    await db.insert(copyLiveExecutions).values({ key, network: 'testnet', accountAddress: address, signerAddress: otherAddress, cloid: intent.cloid, nonce: record.nonce, userId: uid, strategyId, state: record.state, updatedAt: new Date(record.updatedAt), record: record as unknown as Record<string, unknown> });
    await ledger.bookFill(accountId, receipt); await ledger.bookFunding(accountId, { hash: `0x${"44".repeat(32)}`, time: Date.now() - 500, delta: { type: "funding", coin: "BTC", usdc: "-0.37" } });
    const through = Date.now() - 10000;
    await db.insert(copyFollowerScans).values({ accountId, through, claimToken: "private-claim", issue: "follower_scan_unavailable", scanState: { from: through, to: Date.now(), pending: [{ kind: "fills", from: through, to: Date.now(), depth: 1 }], observations: [], historicalCompleteness: "unproven" } });
    const response = await get().expect(200).expect("Cache-Control", "no-store"), statement = copyFollowerStatementSchema.parse(response.body.data);
    expect(statement).toMatchObject({ receiptCount: "2", actual: { realizedPnl: "2", exchangeFee: "-0.04", builderFee: "-0.02", funding: "-0.37", tradingCashDelta: "1.57" }, quarantine: { blocked: false, reason: null }, coverage: { historicalCompleteness: "unproven", scannedThrough: new Date(through).toISOString(), unresolvedWindows: 1, issue: "follower_scan_unavailable" } });
    expect(statement.latestReceipts.map((row) => row.kind)).toEqual(["funding", "fill"]); expect(statement.latestReceipts[1]).toMatchObject({ attribution: "execution", executionKey: key });
    expect(JSON.stringify(response.body)).not.toMatch(/private-claim|"raw"|"record"/); expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", cash: "100" });
  });

  it("returns 404 for cross-owner and missing accounts without leaking foreign receipt metadata", async () => {
    await ledger.bookFill(accountId, fill());
    for (const [id, token] of [[accountId, "bob"], ["missing-account", "alice"]]) { const response = await get(id, token).expect(404); expect(JSON.stringify(response.body)).not.toContain(address); expect(response.body).not.toHaveProperty("data.actual"); }
  });

  it("denies cached disabled users and changed provider-owner bindings while retaining ledger history", async () => {
    await ledger.bookFill(accountId, fill()); await get().expect(200);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid)); await get().expect(401);
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, uid));
    await db.update(copyExecutionAccounts).set({ privyUserId: "did:privy:statement-bob" }).where(eq(copyExecutionAccounts.id, accountId)); await get().expect(404);
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(1);
  });

  it("validates account path DTO and cannot override ownership/account network with query fields", async () => {
    await get("bad%20id").expect(400); await get("a".repeat(129)).expect(400);
    const response = await get().query({ userId: otherUid, network: "mainnet", accountAddress: otherAddress }).expect(200); expect(copyFollowerStatementSchema.parse(response.body.data)).toMatchObject({ accountId, accountAddress: address, network: "testnet" });
    await get(accountId, "bob").query({ userId: uid }).expect(404); expect(await db.select().from(copyFollowerLedger)).toHaveLength(0);
  });

  it("exposes quarantine rather than rewriting conflicting actual receipts", async () => {
    const receipt = fill(); await ledger.bookFill(accountId, receipt); await expect(ledger.bookFill(accountId, { ...receipt, fee: "0.07" })).rejects.toThrow("follower_receipt_conflict");
    const response = await get().expect(200), statement = copyFollowerStatementSchema.parse(response.body.data);
    expect(statement).toMatchObject({ receiptCount: "1", quarantine: { blocked: true, reason: "follower_receipt_conflict" }, actual: { exchangeFee: "-0.04", builderFee: "-0.02", tradingCashDelta: "1.94" } });
    expect(JSON.stringify(response.body)).not.toMatch(/seenDigest|seenRecord|"raw"/);
  });

  it("bounds latest receipts to fifty while counting and summing the complete persisted ledger", async () => {
    const time = Date.now() - 10000;
    for (let index = 0; index < 55; index++) await ledger.bookFunding(accountId, { hash: `0x${index.toString(16).padStart(64, "0")}`, time: time + index, delta: { type: "funding", coin: "BTC", usdc: "0.01" } });
    const response = await get().expect(200).expect("Cache-Control", "no-store"), statement = copyFollowerStatementSchema.parse(response.body.data);
    expect(statement.receiptCount).toBe("55"); expect(statement.actual.funding).toBe("0.55"); expect(statement.actual.tradingCashDelta).toBe("0.55"); expect(statement.latestReceipts).toHaveLength(50); expect(statement.latestReceipts[0].time).toBe(new Date(time + 54).toISOString());
  });
});
