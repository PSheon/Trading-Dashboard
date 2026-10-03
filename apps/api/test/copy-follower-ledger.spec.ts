import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { copyExecutionAccounts, copyStrategies, copyLiveExecutions, copyFollowerReceipts, copyFollowerLedger,
  copyFollowerAccountState, copyFollowerReceiptConflicts, copyPaperFills, users } from "@trading-dashboard/shared/database";
import { CopyFollowerLedger } from "../src/copy/live/copy-follower-ledger.js";
import { CopyFollowerStatementRepository } from "../src/copy/copy-follower-statement.repository.js";
import { CopyFollowerStatementService } from "../src/copy/copy-follower-statement.service.js";
import { copyFollowerStatementSchema } from "@trading-dashboard/shared/contracts";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { getTestDb, closeTestDb, truncateAll, insertUser, type TestDb } from "./db-test-utils.js";

let db: TestDb, uid: number, strategyId: number, ledger: CopyFollowerLedger;
const accountId = "follower", accountAddress = `0x${"11".repeat(20)}`;
function fill(overrides: Record<string, unknown> = {}) { return { coin: "BTC", tid: 1, oid: 7, side: "B", time: Date.now() - 1000,
  px: "20000", sz: "0.01", closedPnl: "2", fee: "0.06", builderFee: "0.02", feeToken: "USDC", ...overrides }; }
async function execution(coin = "BTC") {
  await db.insert(copyLiveExecutions).values({ key: "execution", network: "testnet", accountAddress, signerAddress: `0x${"22".repeat(20)}`,
    cloid: `0x${"33".repeat(16)}`, nonce: Date.now(), userId: uid, strategyId, state: "partial", updatedAt: new Date(),
    record: { market: { coin }, outcome: { exchangeOrderId: "7" } } });
}
beforeAll(() => { db = getTestDb(); ledger = new CopyFollowerLedger(db, new UnitOfWork(db)); });
beforeEach(async () => {
  await truncateAll(db); uid = (await insertUser(db, { privyUserId: "did:privy:follower" })).id;
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: `0x${"55".repeat(20)}`, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: "testnet", privyUserId: "did:privy:follower",
    externalId: "master", state: "ready", address: accountAddress, privyWalletId: "master-wallet", ownerQuorumId: "owner" });
});
afterAll(closeTestDb);
describe("actual follower receipt ledger", () => {
  it("owner statement separates actual fee components and funding without fabricating equity", async () => {
    await execution(); await ledger.bookFill(accountId, fill());
    await ledger.bookFunding(accountId, { hash: `0x${"66".repeat(32)}`, time: Date.now() - 1000, delta: { type: "funding", coin: "BTC", usdc: "-0.37" } });
    const statement = await new CopyFollowerStatementService(new CopyFollowerStatementRepository(db)).get(uid, accountId);
    expect(copyFollowerStatementSchema.parse(statement)).toMatchObject({ token: "USDC", receiptCount: "2", actual: {
      realizedPnl: "2", exchangeFee: "-0.04", builderFee: "-0.02", funding: "-0.37", tradingCashDelta: "1.57" },
      coverage: { historicalCompleteness: "unproven", scannedThrough: null, unresolvedWindows: null }, latestReceipts: [expect.anything(), expect.anything()] });
    expect(statement).not.toHaveProperty("equity");
  });
  it("never exposes an account statement to another owner or a disabled identity", async () => {
    const other = (await insertUser(db, { privyUserId: "did:privy:other" })).id;
    const statements = new CopyFollowerStatementService(new CopyFollowerStatementRepository(db));
    await expect(statements.get(other, accountId)).rejects.toThrow("Execution account not found");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await expect(statements.get(uid, accountId)).rejects.toThrow("Execution account not found");
  });
  it("books inclusive fee exactly once and retains partial-order attribution", async () => {
    await execution(); const receipt = fill();
    expect(await ledger.bookFill(accountId, receipt)).toEqual({ inserted: true, quarantined: false });
    const components = await db.select().from(copyFollowerLedger);
    expect(Object.fromEntries(components.map(r => [r.component, r.amount]))).toEqual({ realized_pnl: "2", exchange_fee: "-0.04", builder_fee: "-0.02" });
    expect((await db.select().from(copyFollowerReceipts))[0]).toMatchObject({ executionKey: "execution", attribution: "execution" });
    expect(await db.select().from(copyPaperFills)).toHaveLength(0);
    expect((await db.select().from(copyStrategies))[0].cash).toBe("100");
  });
  it("concurrent identical receipts are a single immutable booking", async () => {
    await execution(); const receipt = fill();
    const results = await Promise.all([ledger.bookFill(accountId, receipt), ledger.bookFill(accountId, receipt)]);
    expect(results.filter(r => r.inserted)).toHaveLength(1);
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(1);
    expect(await db.select().from(copyFollowerLedger)).toHaveLength(3);
  });
  it("changed payload with the same identity quarantines durably without rewriting cash", async () => {
    await execution(); const receipt = fill(); await ledger.bookFill(accountId, receipt);
    await expect(ledger.bookFill(accountId, { ...receipt, fee: "0.07" })).rejects.toThrow("follower_receipt_conflict");
    expect((await db.select().from(copyFollowerAccountState))[0]).toMatchObject({ quarantined: true, reason: "follower_receipt_conflict" });
    expect(await db.select().from(copyFollowerReceiptConflicts)).toHaveLength(1);
    expect((await db.select().from(copyFollowerReceipts))[0].record.totalFee).toBe("0.06");
    expect((await db.select().from(copyFollowerLedger)).find(r => r.component === "exchange_fee")?.amount).toBe("-0.04");
  });
  it("malformed replay of a known receipt also commits conflict evidence", async () => {
    await execution(); const receipt = fill(); await ledger.bookFill(accountId, receipt);
    await expect(ledger.bookFill(accountId, { ...receipt, fee: null })).rejects.toThrow("follower_receipt_conflict");
    expect((await db.select().from(copyFollowerAccountState))[0].quarantined).toBe(true);
    expect(await db.select().from(copyFollowerReceiptConflicts)).toHaveLength(1);
    expect((await db.select().from(copyFollowerLedger)).find(r => r.component === "exchange_fee")?.amount).toBe("-0.04");
  });
  it("retains external fills as account evidence and quarantines unmatched trading", async () => {
    expect(await ledger.bookFill(accountId, fill())).toEqual({ inserted: true, quarantined: true });
    expect((await db.select().from(copyFollowerReceipts))[0]).toMatchObject({ executionKey: null, attribution: "account" });
  });
  it("wrong market for an oid is never attributed to a valid execution", async () => {
    await execution("ETH");
    expect(await ledger.bookFill(accountId, fill())).toEqual({ inserted: true, quarantined: true });
    expect((await db.select().from(copyFollowerAccountState))[0].reason).toBe("follower_execution_identity_mismatch");
  });
  it("books actual signed maker rebates rather than simulated nonnegative fees", async () => {
    await execution(); await ledger.bookFill(accountId, fill({ closedPnl: "0", fee: "-0.03", builderFee: "0" }));
    expect((await db.select().from(copyFollowerLedger)).map(r => [r.component, r.amount])).toEqual([["exchange_fee", "0.03"]]);
  });
  it("funding is actual signed movement with replay protection", async () => {
    const receipt = { hash: `0x${"66".repeat(32)}`, time: Date.now() - 1000, delta: { type: "funding", coin: "BTC", usdc: "-0.37" } };
    expect(await ledger.bookFunding(accountId, receipt)).toEqual({ inserted: true, quarantined: false });
    expect(await ledger.bookFunding(accountId, receipt)).toEqual({ inserted: false, quarantined: false });
    expect((await db.select().from(copyFollowerLedger)).map(r => [r.component, r.amount])).toEqual([["funding", "-0.37"]]);
    await expect(ledger.bookFunding(accountId, { ...receipt, delta: { ...receipt.delta, usdc: null } })).rejects.toThrow("follower_receipt_conflict");
    expect((await db.select().from(copyFollowerAccountState))[0].quarantined).toBe(true);
    expect(await db.select().from(copyFollowerReceiptConflicts)).toHaveLength(1);
  });
  it("continues read-only booking after owner disablement and strategy stop", async () => {
    await execution(); await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await db.update(copyStrategies).set({ status: "stopped", cash: "0", stoppedAt: new Date() }).where(eq(copyStrategies.id, strategyId));
    expect((await ledger.bookFill(accountId, fill())).inserted).toBe(true);
  });
  it("refuses malformed, foreign-network and future receipts before any booking", async () => {
    for (const patch of [{ side: ["B"] }, { fee: undefined }, { network: "mainnet" }, { user: `0x${"77".repeat(20)}` }, { time: Date.now() + 60_000 }])
      await expect(ledger.bookFill(accountId, fill(patch))).rejects.toThrow();
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(0);
  });
});
