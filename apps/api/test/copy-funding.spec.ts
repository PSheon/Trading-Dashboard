import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { copyExecutionAccounts, copyFundingOperations, copyStrategies, users } from "@trading-dashboard/shared/database";
import { copyFundingSchema } from "@trading-dashboard/shared/contracts";
import { CopyFundingRepository } from "../src/copy/copy-funding.repository.js";
import { CopyFundingService } from "../src/copy/copy-funding.service.js";
import { CopyWalletRepository } from "../src/copy/copy-wallet.repository.js";
import { CopyWalletService } from "../src/copy/copy-wallet.service.js";
import { WithdrawalRepository } from "../src/wallet/withdrawal.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";
import { testConfig } from "./config-test-utils.js";

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const MAIN = signer.address.toLowerCase(), DEST = `0x${"22".repeat(20)}`, HASH = `0x${"aa".repeat(32)}`;
const db = getTestDb();
const exchange = { available: vi.fn(async () => true), acquire: vi.fn(async () => {}), send: vi.fn<import('../src/copy/copy-funding-exchange.client.js').CopyFundingExchangeClient['send']>(async (): Promise<unknown> => ({ status: "ok", response: { type: "default" } })), txDetails: vi.fn(async () => null as unknown) };
const info = { userNonFundingLedgerUpdates: vi.fn(async () => [] as Array<{ time: number; hash: string; delta: Record<string, unknown> }>) };
const provider = { available: true, create: vi.fn(), findOwned: vi.fn(async () => ({ id: "provider-wallet", address: DEST, externalId: "copy_funding_test", ownerQuorumId: "quorum" })) };
let userId: number, otherId: number, strategyId: number, service: CopyFundingService, repository: CopyFundingRepository;
beforeEach(async () => {
  await truncateAll(db); vi.clearAllMocks();
  userId = (await insertUser(db, { embeddedWalletAddress: MAIN, privyUserId: "did:privy:funding" })).id;
  otherId = (await insertUser(db)).id;
  strategyId = (await db.insert(copyStrategies).values({ userId, leaderAddress: DEST, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0]!.id;
  await db.insert(copyExecutionAccounts).values({ id: "test-account", userId, strategyId, network: "testnet", privyUserId: "did:privy:funding", externalId: "copy_funding_test", state: "ready", address: DEST, privyWalletId: "provider-wallet", ownerQuorumId: "quorum" });
  const wallets = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
  repository = new CopyFundingRepository(db);
  service = new CopyFundingService(testConfig(), repository, wallets, exchange as never, info as never);
  exchange.available.mockResolvedValue(true); exchange.acquire.mockResolvedValue(undefined); exchange.send.mockResolvedValue({ status: "ok", response: { type: "default" } }); exchange.txDetails.mockResolvedValue(null); info.userNonFundingLedgerUpdates.mockResolvedValue([]);
  provider.findOwned.mockResolvedValue({ id: "provider-wallet", address: DEST, externalId: "copy_funding_test", ownerQuorumId: "quorum" });
});
afterAll(closeTestDb);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const reserve = (amount = "12.500000", idempotencyKey = randomUUID()) => service.reserve(userId, "test-account", { amount, idempotencyKey });
async function signature(op: Awaited<ReturnType<typeof reserve>>) {
  // Independent vector: don't derive expected signing fields from the production builder.
  return signer.signTypedData({ domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" },
    primaryType: "HyperliquidTransaction:UsdSend", types: { "HyperliquidTransaction:UsdSend": [ { name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" } ] },
    message: { hyperliquidChain: "Testnet", destination: op.destination, amount: op.amount, time: BigInt(op.nonce) } });
}
async function attempted() {
  const op = await reserve(); await service.claim(userId, op.id);
  return service.submit(userId, op.id, await signature(op));
}
function receipt(op: Awaited<ReturnType<typeof reserve>>, nonce = op.nonce) {
  info.userNonFundingLedgerUpdates.mockResolvedValue([{ hash: HASH, time: op.nonce + 100, delta: { type: "internalTransfer", user: MAIN, destination: DEST, usdc: op.amount, fee: "1" } }]);
  exchange.txDetails.mockResolvedValue({ type: "txDetails", tx: { hash: HASH, user: MAIN, error: null, time: op.nonce + 100, action: { type: "usdSend", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination: DEST, amount: op.amount, time: nonce } } });
}

describe("durable strategy funding", () => {
  it("persists canonical immutable intent without changing paper money or starting trading", async () => {
    const op = copyFundingSchema.parse(await reserve());
    expect(op).toMatchObject({ address: MAIN, destination: DEST, amount: "12.5", status: "prepared", canCancel: true, creditedAmount: null });
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", allocated: "100", cash: "100" });
    expect(exchange.send).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
    expect(JSON.stringify(op)).not.toMatch(/privy|signature|quorum|idempotency/i);
  });
  it("replays the same key and canonical amount and rejects changed payloads", async () => {
    const key = randomUUID(), original = await reserve("12.500000", key);
    expect((await reserve("12.5", key)).id).toBe(original.id);
    await expect(reserve("13", key)).rejects.toThrow("Idempotency payload changed");
    await expect(reserve()).rejects.toThrow("Resolve the pending");
  });
  it("limits concurrent reservations and source operations across replicas", async () => {
    const key = randomUUID();
    const results = await Promise.all([reserve("12.5", key), reserve("12.5000", key)]);
    expect(results[0].id).toBe(results[1].id); expect(await db.select().from(copyFundingOperations)).toHaveLength(1);
    await expect(new WithdrawalRepository(db).reserve({ userId, network: "testnet", address: MAIN }, { destination: DEST, amount: "20" })).rejects.toThrow("pending");
  });
  it("does not reserve funding while a source withdrawal is pending", async () => {
    await new WithdrawalRepository(db).reserve({ userId, network: "testnet", address: MAIN }, { destination: DEST, amount: "20" });
    await expect(reserve()).rejects.toThrow("Resolve the pending");
  });
  it("uses monotonically unique source nonces across cancelled transfers and withdrawals", async () => {
    const first = await reserve(); await service.cancel(userId, first.id);
    const wr = new WithdrawalRepository(db), withdrawal = await wr.reserve({ userId, network: "testnet", address: MAIN }, { destination: DEST, amount: "20" });
    expect(withdrawal.nonce).toBeGreaterThan(first.nonce); await wr.cancel(userId, withdrawal.id);
    expect((await reserve()).nonce).toBeGreaterThan(withdrawal.nonce);
  });
  it("separates owners, rejects disabled owners, stopped copies and unverified accounts", async () => {
    const op = await reserve();
    await expect(service.claim(otherId, op.id)).rejects.toThrow("not found");
    await expect(service.reconcile(otherId, op.id)).rejects.toThrow("not found");
    await service.cancel(userId, op.id);
    await db.update(copyStrategies).set({ status: "stopped", stoppedAt: new Date(), cash: "0" }).where(eq(copyStrategies.id, strategyId));
    await expect(reserve()).rejects.toThrow("stopped");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    await expect(reserve()).rejects.toThrow("not found");
  });
  it('restores only a genuinely never-dispatched attempt and retains its original nonce', async () => {
    const op = await reserve(); await service.claim(userId, op.id);
    const transport = new CopyFundingExchangeClient({} as RequestBudgeterService);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    exchange.send.mockImplementation((attempt, sig) => transport.send(attempt, sig, () => { throw Error('expired proof'); }));
    expect(await service.submit(userId, op.id, await signature(op))).toMatchObject({ status: 'prepared', canCancel: true });
    expect(await repository.find(userId, op.id)).toMatchObject({ nonce: op.nonce, attemptedAt: null, claimedAt: null });
    expect(fetcher).not.toHaveBeenCalled();
    await service.claim(userId, op.id);
    exchange.send.mockResolvedValue({ status: 'ok', response: { type: 'default' } });
    expect(await service.submit(userId, op.id, await signature(op))).toMatchObject({ status: 'accepted' });
  });
  it('a forged pre-dispatch error cannot reset durable attempted state', async () => {
    exchange.send.mockRejectedValue(new LiveBoundaryError('funding_not_dispatched'));
    const op = await attempted();
    expect(op.status).toBe('unknown');
    expect((await repository.find(userId, op.id)).attemptedAt).not.toBeNull();
    await service.submit(userId, op.id, await signature(op));
    expect(exchange.send).toHaveBeenCalledTimes(1);
  });
  it('a concurrent scan revision wins over original never-dispatched evidence', async () => {
    const op = await reserve(); await service.claim(userId, op.id);
    const transport = new CopyFundingExchangeClient({} as RequestBudgeterService);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    exchange.send.mockImplementation(async (attempt, sig) => {
      await db.update(copyFundingOperations).set({ scanRevision: attempt.scanRevision + 1 }).where(eq(copyFundingOperations.id, op.id));
      return transport.send(attempt, sig, () => { throw Error('expired proof'); });
    });
    expect(await service.submit(userId, op.id, await signature(op))).toMatchObject({ status: 'unknown' });
    expect((await repository.find(userId, op.id)).attemptedAt).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['nonce', 'amount', 'attemptedAt', 'updatedAt', 'accepted', 'receipt', 'owner'] as const)('never resets a concurrently changed %s from an original pre-dispatch proof', async change => {
    const op = await reserve(); await service.claim(userId, op.id);
    const transport = new CopyFundingExchangeClient({} as RequestBudgeterService);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    exchange.send.mockImplementation(async (attempt, sig) => {
      if (change === 'owner') await db.update(users).set({ embeddedWalletAddress: DEST }).where(eq(users.id, userId));
      else {
        const changed = change === 'nonce' ? { nonce: attempt.nonce + 1 }
          : change === 'amount' ? { amount: '13' }
          : change === 'attemptedAt' ? { attemptedAt: new Date(attempt.attemptedAt!.getTime() + 1) }
          : change === 'updatedAt' ? { updatedAt: new Date(attempt.updatedAt.getTime() + 1) }
          : change === 'accepted' ? { status: 'accepted' as const, evidenceHash: 'e'.repeat(64) }
          : { transactionHash: HASH };
        await db.update(copyFundingOperations).set(changed).where(eq(copyFundingOperations.id, op.id));
      }
      return transport.send(attempt, sig, () => { throw Error('expired proof'); });
    });
    expect(await service.submit(userId, op.id, await signature(op))).toMatchObject({ status: change === 'accepted' ? 'accepted' : 'unknown' });
    expect((await repository.find(userId, op.id)).attemptedAt).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('a crash after persisting an attempt supplies no reset proof and never resends', async () => {
    const op = await reserve(); await service.claim(userId, op.id);
    expect(await repository.beginSubmit(userId, op.id)).not.toBeNull();
    expect(await service.submit(userId, op.id, await signature(op))).toMatchObject({ status: 'unknown' });
    expect(exchange.send).not.toHaveBeenCalled();
    expect((await repository.find(userId, op.id)).attemptedAt).not.toBeNull();
  });
  it("submits one verified user signature across concurrent callers", async () => {
    const op = await reserve(), sig = await signature(op);
    const claims = await Promise.all([service.claim(userId, op.id), service.claim(userId, op.id)]);
    expect(claims.filter((x) => x.claimed)).toHaveLength(1);
    await Promise.all([service.submit(userId, op.id, sig), service.submit(userId, op.id, sig)]);
    expect(exchange.send).toHaveBeenCalledTimes(1);
    const current = await repository.find(userId, op.id);
    expect(current.status).toBe("accepted"); expect(current.attemptedAt).not.toBeNull();
    expect(JSON.stringify(current)).not.toContain(sig);
    await expect(reserve()).rejects.toThrow("pending");
  });

  it('carries wallet identity age across global admission to the native funding POST', async () => {
    const op = await reserve(); await service.claim(userId, op.id); let nativeCalls = 0;
    exchange.send.mockImplementation(async (_operation, _signature, guard) => {
      const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5001);
      try { if (!guard) throw new Error('missing native funding guard'); guard(); nativeCalls++; return { status: 'ok', response: { type: 'default' } }; }
      finally { clock.mockRestore(); }
    });
    expect((await service.submit(userId, op.id, await signature(op))).status).toBe('unknown');
    expect(exchange.send.mock.calls[0][2]).toEqual(expect.any(Function)); expect(nativeCalls).toBe(0);
    await service.submit(userId, op.id, await signature(op)); expect(exchange.send).toHaveBeenCalledTimes(1);
    expect((await repository.find(userId, op.id)).attemptedAt).not.toBeNull();
  });
  it("refuses signatures for changed amount, destination or nonce before querying funds", async () => {
    const op = await reserve(); await service.claim(userId, op.id);
    for (const change of [{ amount: "99" }, { destination: MAIN }, { nonce: op.nonce + 1 }]) {
      await expect(service.submit(userId, op.id, await signature({ ...op, ...change }))).rejects.toThrow("Invalid funding signature");
    }
    expect(exchange.available).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it("allows cancellation after a lost claim response but never after an attempted POST", async () => {
    const op = await reserve(); await service.claim(userId, op.id);
    expect((await service.cancel(userId, op.id)).status).toBe("cancelled");
    const sent = await attempted(); await expect(service.cancel(userId, sent.id)).rejects.toThrow("pending");
  });
  it("retains an uncertain attempt after response loss and only reconciles on recovery", async () => {
    exchange.send.mockRejectedValue(new Error("private response loss"));
    const op = await attempted(); expect(op.status).toBe("unknown");
    expect((await service.reconcile(userId, op.id)).status).toBe("unknown");
    await service.submit(userId, op.id, await signature(op)); expect(exchange.send).toHaveBeenCalledTimes(1);
    await expect(reserve()).rejects.toThrow("pending");
  });
  it("an unknown transfer gets a terminal state: rejected once a full ledger read past its nonce's expiry shows no credit, pending before that", async () => {
    exchange.send.mockRejectedValue(new Error("private response loss"));
    const op = await attempted(); expect(op.status).toBe("unknown");
    // A read that ends inside the nonce window: still possible, still pending.
    expect((await service.reconcile(userId, op.id)).status).toBe("unknown");
    // Three days later the nonce can no longer execute and the ledger has nothing.
    const later = vi.spyOn(Date, "now").mockReturnValue(op.nonce + 3 * 86_400_000);
    try {
      let status = "unknown";
      for (let i = 0; i < 3 && status === "unknown"; i++) status = (await service.reconcile(userId, op.id)).status;
      expect(status).toBe("rejected");
    } finally { later.mockRestore(); }
    // The address is free again.
    exchange.send.mockResolvedValue({ status: "ok", response: { type: "default" } });
    await expect(reserve()).resolves.toBeTruthy();
  });
  it("never calls a transfer not executed from a failed ledger read, or from a matching transfer it could not prove", async () => {
    exchange.send.mockRejectedValue(new Error("private response loss"));
    const op = await attempted();
    let clock = op.nonce + 3 * 86_400_000;
    // Each call a minute later, past the lookup cache.
    const later = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const again = async () => { clock += 60_000; return service.reconcile(userId, op.id); };
    try {
      // The ledger read fails: no conclusion.
      info.userNonFundingLedgerUpdates.mockRejectedValueOnce(new Error("busy"));
      await expect(again()).rejects.toThrow();
      expect((await repository.find(userId, op.id)).status).toBe("unknown");
      // A transfer from this source to this destination is there but its details cannot be proven.
      info.userNonFundingLedgerUpdates.mockResolvedValue([{ hash: HASH, time: op.nonce + 100, delta: { type: "internalTransfer", user: MAIN, destination: DEST, usdc: op.amount, fee: "1" } }]);
      exchange.txDetails.mockResolvedValue(null);
      for (let i = 0; i < 3; i++) await again();
      expect((await repository.find(userId, op.id)).status).toBe("unknown");
    } finally { later.mockRestore(); }
  });

  it("the not-executed decision is a compare-and-set: a concurrent turn that saved anything wins", async () => {
    exchange.send.mockRejectedValue(new Error("private response loss"));
    const op = await attempted();
    const stale = await repository.find(userId, op.id);
    // Another turn saved its scan meanwhile.
    expect(await repository.saveScan(stale, { version: 1, windows: [], receipts: [], seen: 1 })).toBeTruthy();
    expect(await repository.notExecuted(stale, "a".repeat(64))).toBeNull();
    expect((await repository.find(userId, op.id)).status).toBe("unknown");
    // On the current revision it applies.
    expect(await repository.notExecuted(await repository.find(userId, op.id), "a".repeat(64))).toMatchObject({ status: "rejected" });
  });

  it.each([{ status: "err", response: "nonce already used" }, { status: "ok", response: { type: "unexpected" } }, null])("keeps ambiguous reply pending: %j", async (reply) => {
    exchange.send.mockResolvedValue(reply); expect((await attempted()).status).toBe("unknown");
  });
  it("releases only definite rejection and preserves the original operation on replay", async () => {
    exchange.send.mockResolvedValue({ status: "err", response: "insufficient funds" });
    const rejected = await attempted(); expect(rejected.status).toBe("rejected");
    expect((await reserve()).id).not.toBe(rejected.id);
  });
  it("restores unattempted intent after budget failure or insufficient balance", async () => {
    const op = await reserve(); await service.claim(userId, op.id);
    exchange.available.mockResolvedValue(false);
    await expect(service.submit(userId, op.id, await signature(op))).rejects.toMatchObject({ response: expect.objectContaining({ code: "insufficient_main_balance" }) });
    expect((await repository.find(userId, op.id)).status).toBe("prepared"); expect(exchange.send).not.toHaveBeenCalled();
    exchange.available.mockResolvedValue(true); await service.claim(userId, op.id); exchange.acquire.mockRejectedValue(new Error("budget"));
    await expect(service.submit(userId, op.id, await signature(op))).rejects.toThrow();
    expect((await repository.find(userId, op.id)).attemptedAt).toBeNull();
  });
  it("rechecks owner disablement and wallet identity after remote balance reads", async () => {
    const op = await reserve(); await service.claim(userId, op.id);
    exchange.available.mockImplementationOnce(async () => { await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId)); return true; });
    await expect(service.submit(userId, op.id, await signature(op))).rejects.toThrow();
    expect(exchange.send).not.toHaveBeenCalled(); expect((await repository.find(userId, op.id)).attemptedAt).toBeNull();
  });
  it("does not credit a similar ledger transfer with a different original nonce", async () => {
    const op = await attempted(); receipt(op, op.nonce + 1);
    expect((await service.reconcile(userId, op.id)).status).toBe("accepted");
  });
  it("credits only exact nonce proof plus recipient ledger, preserving actual fee", async () => {
    const op = await attempted(); receipt(op);
    expect(await service.reconcile(userId, op.id)).toMatchObject({ status: "credited", transactionHash: HASH, fee: "1", creditedAmount: "11.5", canCancel: false });
    expect(exchange.txDetails).toHaveBeenCalledWith("testnet", HASH);
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledWith(DEST, op.nonce - 86_400_000, expect.any(Number), "live", expect.any(Number), "https://api.hyperliquid-testnet.xyz/info");
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", cash: "100" });
    expect((await reserve()).id).not.toBe(op.id);
  });
  it("finish moves only an attempted operation, a copy deposit as a main-wallet withdrawal (a legacy import excepted)", async () => {
    const deposit = await reserve(); await service.claim(userId, deposit.id);
    expect(await repository.finish(userId, deposit.id, "accepted", "e".repeat(64))).toMatchObject({ status: "unknown" });
    await repository.cancel(userId, deposit.id);
    const withdrawals = new WithdrawalRepository(db), scope = { userId, network: "testnet" as const, address: MAIN };
    const claimed = await withdrawals.reserve(scope, { destination: DEST, amount: "20" }); await withdrawals.claim(userId, claimed.id);
    expect(await withdrawals.finish(userId, claimed.id, "accepted", "e".repeat(64))).toMatchObject({ status: "unknown" });
    expect(await withdrawals.beginSubmit(userId, claimed.id)).toMatchObject({ status: "unknown" });
    expect(await withdrawals.finish(userId, claimed.id, "accepted", "e".repeat(64))).toMatchObject({ status: "accepted" });
    const legacy = await withdrawals.reserve(scope, { destination: DEST, amount: "21" }, Date.now() - 60_000);
    expect(legacy).toMatchObject({ origin: "legacy", status: "unknown", attemptedAt: null });
    expect(await withdrawals.finish(userId, legacy.id, "accepted", "f".repeat(64))).toMatchObject({ status: "accepted" });
  });
  it("cannot credit an unattempted claim or query another user's account", async () => {
    const op = await reserve(); await service.claim(userId, op.id); receipt(op);
    expect((await service.reconcile(userId, op.id)).status).toBe("unknown");
    expect(exchange.txDetails).not.toHaveBeenCalled(); expect(info.userNonFundingLedgerUpdates).not.toHaveBeenCalled();
  });
  it("automatically confirms attempted transfers after restart and owner disablement without sending or provisioning", async () => {
    const op = await attempted(); receipt(op);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    await db.update(copyFundingOperations).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(copyFundingOperations.id, op.id));
    // A new instance has no in-memory receipt or cache from the submitter.
    const restarted = new CopyFundingService(testConfig(), repository, {} as never, exchange as never, info as never);
    expect(await restarted.reconcilePending()).toBe(1);
    expect((await repository.find(userId, op.id)).status).toBe("credited");
    expect(exchange.send).toHaveBeenCalledTimes(1); expect(provider.create).not.toHaveBeenCalled();
  });
  it("persists the recipient ledger before an explorer quota failure and resumes only the original receipt after restart", async () => {
    const op = await attempted(); receipt(op);
    exchange.txDetails.mockRejectedValueOnce(new Error("live_budget_wait"));
    await expect(service.reconcile(userId, op.id)).rejects.toThrow("Funding confirmation unavailable");
    expect((await repository.find(userId, op.id)).scanState).toMatchObject({ pendingDetails: [{ hash: HASH }] });
    const wallets = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
    const restarted = new CopyFundingService(testConfig(), repository, wallets, exchange as never, info as never);
    expect((await restarted.reconcile(userId, op.id)).status).toBe("credited");
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledTimes(1);
    expect(exchange.txDetails).toHaveBeenCalledTimes(2);
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("leases pending evidence checks across replicas without releasing transfer exclusion", async () => {
    const op = await attempted();
    await db.update(copyFundingOperations).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(copyFundingOperations.id, op.id));
    const claims = await Promise.all([repository.claimPending(5), repository.claimPending(5)]);
    expect(claims.flat().map((row) => row.id)).toEqual([op.id]);
    await expect(reserve()).rejects.toThrow("pending");
    expect(await repository.claimPending(5)).toEqual([]);
  });
  it("finds and confirms a successful nonce ahead of the ledger's block time", async () => {
    const op = await attempted(); receipt(op);
    const rows = [{ hash: HASH, time: op.nonce - 1000, delta: { type: "internalTransfer", user: MAIN, destination: DEST, usdc: op.amount, fee: "1" } }];
    info.userNonFundingLedgerUpdates.mockImplementation(async (_address?: unknown, start?: number) => (start ?? 0) <= rows[0]!.time ? rows : []);
    expect((await service.reconcile(userId, op.id)).status).toBe("credited");
  });
  it("advances past five unrelated transfers with persisted progress across process restarts", async () => {
    const op = await attempted();
    const rows = Array.from({ length: 6 }, (_, i) => ({ hash: `0x${(i + 1).toString(16).padStart(64, "0")}`, time: op.nonce + i, delta: { type: "internalTransfer", user: MAIN, destination: DEST, usdc: op.amount, fee: "1" } }));
    info.userNonFundingLedgerUpdates.mockResolvedValue(rows);
    exchange.txDetails.mockImplementation(async (_network?: unknown, hash?: string) => ({ type: "txDetails", tx: { hash, user: MAIN, error: null, time: op.nonce, action: { type: "usdSend", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination: DEST, amount: op.amount, time: hash === rows[0]!.hash ? op.nonce : op.nonce + 1 } } }));
    const wallets = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
    for (let i = 0; i < 3; i++) await new CopyFundingService(testConfig(), repository, wallets, exchange as never, info as never).reconcile(userId, op.id);
    expect(await repository.find(userId, op.id)).toMatchObject({ status: "credited", transactionHash: rows[0]!.hash });
    expect(exchange.txDetails).toHaveBeenCalledWith("testnet", rows[0]!.hash); expect(exchange.send).toHaveBeenCalledTimes(1);
    expect(exchange.txDetails).toHaveBeenCalledTimes(6);
  });
  it("splits capped ledger windows rather than permanently abandoning a full page", async () => {
    const op = await attempted(); receipt(op);
    const validRows = (await info.userNonFundingLedgerUpdates()).map((row) => ({ ...row, time: op.nonce - 1 }));
    info.userNonFundingLedgerUpdates.mockImplementation(async (_address?: unknown, start?: number, end?: number) => {
      if ((end ?? 0) - (start ?? 0) > 50_000_000) return Array.from({ length: 2000 }, () => ({ hash: HASH, time: op.nonce, delta: { type: "deposit", usdc: "1" } }));
      return (start ?? 0) <= validRows[0]!.time && validRows[0]!.time <= (end ?? Infinity) ? validRows : [];
    });
    const wallets = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
    for (let i = 0; i < 5; i++) await new CopyFundingService(testConfig(), repository, wallets, exchange as never, info as never).reconcile(userId, op.id);
    expect((await repository.find(userId, op.id)).status).toBe("credited"); expect(exchange.send).toHaveBeenCalledTimes(1);
  });
  it("retains ambiguity across scan batches and refuses a stale scan writer", async () => {
    const op = await attempted();
    const rows = Array.from({ length: 6 }, (_, i) => ({ hash: `0x${(i + 1).toString(16).padStart(64, "0")}`, time: op.nonce - 1, delta: { type: "internalTransfer", user: MAIN, destination: DEST, usdc: op.amount, fee: "1" } }));
    info.userNonFundingLedgerUpdates.mockResolvedValue(rows);
    exchange.txDetails.mockImplementation(async (_network?: unknown, hash?: string) => ({ type: "txDetails", tx: { hash, user: MAIN, error: null, time: op.nonce - 1, action: { type: "usdSend", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination: DEST, amount: op.amount, time: hash === rows[0]!.hash || hash === rows[5]!.hash ? op.nonce : op.nonce + 1 } } }));
    const before = await repository.find(userId, op.id);
    await service.reconcile(userId, op.id);
    expect(await repository.saveScan(before, null)).toBeNull();
    const wallets = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
    await new CopyFundingService(testConfig(), repository, wallets, exchange as never, info as never).reconcile(userId, op.id);
    expect((await repository.find(userId, op.id)).status).toBe("accepted");
    await expect(reserve()).rejects.toThrow("pending"); expect(exchange.send).toHaveBeenCalledTimes(1);
  });
});
