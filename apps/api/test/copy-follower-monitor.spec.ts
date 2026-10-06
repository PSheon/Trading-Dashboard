import { testConfig } from './config-test-utils.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { copyExecutionAccounts, copyStrategies, copyFollowerScans, copyFollowerReceipts, copyFollowerAccountState, users } from "@trading-dashboard/shared/database";
import { CopyFollowerReconciler } from "../src/copy/copy-follower-monitor.service.js";
import { CopyFollowerScanRepository } from "../src/copy/copy-follower-scan.repository.js";
import { CopyFollowerLedger } from "../src/copy/live/copy-follower-ledger.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { LiveBoundaryError } from "../src/copy/live/wallet-authorization.js";
import { getTestDb, closeTestDb, truncateAll, insertUser, type TestDb } from "./db-test-utils.js";

let db: TestDb, uid: number, strategyId: number, repository: CopyFollowerScanRepository, ledger: CopyFollowerLedger;
const accountId = "monitor-account", accountAddress = `0x${"11".repeat(20)}`;
function evidence(input: { accountAddress: string; from: number; to: number }, changes: Record<string, unknown> = {}) {
  return { network: "testnet", ...input, observedAt: Date.now(), completedAt: Date.now(), fresh: true, requestsUsed: 2,
    requestedWindows: [{ kind: "fills", from: input.from, to: input.to, depth: 0 }, { kind: "funding", from: input.from, to: input.to, depth: 0 }],
    observations: [], unresolvedWindows: [], fills: [], funding: [], historicalCompleteness: "unproven",
    completenessReasons: ["latest_10000_fills_limit", "provider_history_unproven"], ...changes };
}
beforeAll(() => { db = getTestDb(); repository = new CopyFollowerScanRepository(db, testConfig()); ledger = new CopyFollowerLedger(db, new UnitOfWork(db)); });
beforeEach(async () => {
  await truncateAll(db); uid = (await insertUser(db)).id;
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: `0x${"55".repeat(20)}`, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: "testnet", privyUserId: "did:privy:monitor",
    externalId: "master", state: "ready", address: accountAddress, privyWalletId: "wallet", ownerQuorumId: "owner", createdAt: new Date(Date.now() - 60_000) });
});
afterAll(closeTestDb);
describe("durable follower reconciliation", () => {
  it("cannot quarantine a new binding using malformed old-address evidence", async () => {
    const read = vi.fn(async () => {
      await db.update(copyExecutionAccounts).set({ address: `0x${"22".repeat(20)}` }).where(eq(copyExecutionAccounts.id, accountId));
      throw new LiveBoundaryError("follower_receipt_invalid_evidence");
    });
    await expect(new CopyFollowerReconciler(repository, ledger, { read } as never).runOnce()).rejects.toThrow("follower_receipt_invalid_evidence");
    expect(await db.select().from(copyFollowerAccountState)).toHaveLength(0);
    expect((await db.select().from(copyFollowerScans))[0].through).toBeNull();
  });
  it("uses the database clock to enforce admission despite a slow worker clock", async () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 120_000);
    try { expect(await repository.claim()).not.toBeNull(); expect(await repository.claim()).toBeNull(); }
    finally { spy.mockRestore(); }
  });
  it("cannot advance empty old-address coverage after a binding change", async () => {
    const read = vi.fn(async input => {
      await db.update(copyExecutionAccounts).set({ address: `0x${"22".repeat(20)}` }).where(eq(copyExecutionAccounts.id, accountId));
      return evidence(input);
    });
    await expect(new CopyFollowerReconciler(repository, ledger, { read } as never).runOnce()).rejects.toThrow("follower_account_identity_changed");
    expect((await db.select().from(copyFollowerScans))[0].through).toBeNull();
  });
  it("cannot book old-address receipts when the binding changes during provider reads", async () => {
    const read = vi.fn(async input => {
      await db.update(copyExecutionAccounts).set({ address: `0x${"22".repeat(20)}` }).where(eq(copyExecutionAccounts.id, accountId));
      return evidence(input, { fills: [{ raw: { coin: "BTC", tid: 1, oid: 7, side: "B", time: input.from,
        px: "20000", sz: "0.01", closedPnl: "0", fee: "0.06", builderFee: "0.02", feeToken: "USDC" } }] });
    });
    await expect(new CopyFollowerReconciler(repository, ledger, { read } as never).runOnce()).rejects.toThrow("follower_account_identity_changed");
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(0);
    expect((await db.select().from(copyFollowerScans))[0]).toMatchObject({ through: null, issue: "follower_account_identity_changed" });
  });
  it("claims one account across concurrent workers, preserving disabled/stopped reconciliation", async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await db.update(copyStrategies).set({ status: "stopped", cash: "0", stoppedAt: new Date() }).where(eq(copyStrategies.id, strategyId));
    const claims = await Promise.all([repository.claim(), repository.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("persists successful fetched windows without claiming historical completeness", async () => {
    const read = vi.fn(async (input) => evidence(input));
    await new CopyFollowerReconciler(repository, ledger, { read } as never).runOnce();
    const [scan] = await db.select().from(copyFollowerScans);
    expect(scan.through).toBeGreaterThan(Number(scan.createdAt));
    expect(scan.scanState).toMatchObject({ historicalCompleteness: "unproven", pending: [] });
    expect(read.mock.calls[0][0]).toMatchObject({ accountAddress, maxRequests: 2 });
  });
  it("never advances through an unresolved time range and resumes the original bounds", async () => {
    const read = vi.fn(async (input) => evidence(input, { unresolvedWindows: [{ kind: "fills", from: input.from, to: input.to, depth: 1, reason: "request_budget" }] }));
    await new CopyFollowerReconciler(repository, ledger, { read } as never).runOnce();
    const [scan] = await db.select().from(copyFollowerScans); expect(scan.through).toBeNull();
    await db.update(copyFollowerScans).set({ nextRunAt: new Date(0) });
    read.mockImplementation(async input => evidence(input));
    await new CopyFollowerReconciler(repository, ledger, { read } as never).runOnce();
    expect(read.mock.calls[1][0]).toMatchObject({ from: read.mock.calls[0][0].from, to: read.mock.calls[0][0].to,
      resumeWindows: [{ kind: "fills", from: read.mock.calls[0][0].from, to: read.mock.calls[0][0].to, depth: 1 }] });
    expect((await db.select().from(copyFollowerScans))[0].through).toBe(read.mock.calls[0][0].to);
  });
  it("books partial receipts before retaining coverage gaps and leaves paper cash untouched", async () => {
    const read = vi.fn(async input => evidence(input, { fills: [{ raw: { coin: "BTC", tid: 1, oid: 7, side: "B", time: input.from,
      px: "20000", sz: "0.01", closedPnl: "0", fee: "0.06", builderFee: "0.02", feeToken: "USDC" } }],
      unresolvedWindows: [{ kind: "funding", from: input.from, to: input.to, depth: 0, reason: "read_unavailable" }] }));
    await new CopyFollowerReconciler(repository, ledger, { read } as never).runOnce();
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(1);
    expect((await db.select().from(copyFollowerScans))[0].through).toBeNull();
    expect((await db.select().from(copyStrategies))[0].cash).toBe("100");
  });
  it("books a mainnet deployment's receipts as mainnet evidence (they were refused as not testnet, failing every settle and stop after a fill)", async () => {
    const base = testConfig();
    const mainnet = { get value() { const v = base.value; return { ...v, hyperliquid: { ...v.hyperliquid, wallet: { ...v.hyperliquid.wallet, network: "mainnet" as const } } }; } } as typeof base;
    await db.update(copyExecutionAccounts).set({ network: "mainnet" }).where(eq(copyExecutionAccounts.id, accountId));
    const read = vi.fn(async input => evidence(input, { network: "mainnet", fills: [{ raw: { coin: "BTC", tid: 1, oid: 7, side: "B", time: input.from,
      px: "20000", sz: "0.01", closedPnl: "0", fee: "0.06", builderFee: "0.02", feeToken: "USDC" } }] }));
    await new CopyFollowerReconciler(new CopyFollowerScanRepository(db, mainnet), ledger, { read } as never).runFor(accountId);
    expect(await db.select().from(copyFollowerReceipts)).toMatchObject([{ network: "mainnet", accountAddress }]);
    expect((await db.select().from(copyFollowerScans))[0]).toMatchObject({ issue: null });
    // Testnet evidence for the mainnet account is still refused.
    await db.update(copyFollowerScans).set({ nextRunAt: new Date(0) });
    read.mockImplementation(async input => evidence(input));
    await expect(new CopyFollowerReconciler(new CopyFollowerScanRepository(db, mainnet), ledger, { read } as never).runFor(accountId)).rejects.toThrow("follower_receipt_invalid_evidence");
  });
  it("quarantines malformed provider evidence without advancing a scan", async () => {
    const read = vi.fn(async () => { throw new LiveBoundaryError("follower_receipt_invalid_evidence"); });
    await expect(new CopyFollowerReconciler(repository, ledger, { read } as never).runOnce()).rejects.toThrow();
    expect((await db.select().from(copyFollowerScans))[0]).toMatchObject({ through: null, issue: "follower_receipt_invalid_evidence" });
  });
  it("does not let a stale worker overwrite a newer scan", async () => {
    const first = await repository.claim(); expect(first).not.toBeNull();
    await db.update(copyFollowerScans).set({ nextRunAt: new Date(0) });
    const second = await repository.claim(); expect(second).not.toBeNull();
    expect(await repository.save(first!, { from: 1, to: 2, pending: [], historicalCompleteness: "unproven", observations: [] }, 2)).toBe(false);
    expect((await db.select().from(copyFollowerScans))[0].claimToken).toBe(second!.claimToken);
  });
});
