import { Logger, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { ArbitrumBalanceClient } from "../src/wallet/arbitrum-balance.client.js";
import { WalletController } from "../src/wallet/wallet.controller.js";
import { WalletRepository } from "../src/wallet/wallet.repository.js";
import { WalletService } from "../src/wallet/wallet.service.js";
import { WithdrawalController } from "../src/wallet/withdrawal.controller.js";
import { WithdrawalRepository } from "../src/wallet/withdrawal.repository.js";
import { WithdrawalExchangeClient } from "../src/wallet/withdrawal-exchange.client.js";
import { WithdrawalService } from "../src/wallet/withdrawal.service.js";
import { privateKeyToAccount } from "viem/accounts";
import { eq, sql } from "drizzle-orm";
import { users, walletWithdrawals } from "@trading-dashboard/shared/database";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

// Deterministic test key only; no provider or network ever receives it.
const TEST_ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const MAIN = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const DEST = `0x${"22".repeat(20)}`;
const OTHER = `0x${"33".repeat(20)}`;
const INPUT = { destination: DEST, amount: "12.500000" };
const SERVICE = "withdrawal-service-token-0123456789";
const ROOT = "/me/wallet/withdrawals";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("durable owner withdrawal metadata", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    alice: { privyUserId: "did:privy:alice", profile: { email: "alice@example.com", walletAddress: null, embeddedWalletAddress: MAIN } },
    bob: { privyUserId: "did:privy:bob", profile: { email: "bob@example.com", walletAddress: null, embeddedWalletAddress: OTHER } },
  });
  const info = { userNonFundingLedgerUpdates: vi.fn(async () => [] as Array<{ time: number; hash: string; delta: Record<string, unknown> }>) };
  const exchange = { acquire: vi.fn(async () => {}), send: vi.fn<WithdrawalExchangeClient['send']>(async () => ({ status: "ok", response: { type: "default" } } as unknown)) };
  let app: INestApplication;
  let auth: AuthService;
  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = SERVICE;
    ({ app, auth } = await createAuthedApp({ db, privy, controllers: [WalletController, WithdrawalController], providers: [
      WalletRepository, WalletService, WithdrawalRepository, WithdrawalService,
      { provide: WithdrawalExchangeClient, useValue: exchange },
      { provide: HyperliquidInfoClient, useValue: info }, { provide: ArbitrumBalanceClient, useValue: {} },
    ] }));
  });
  beforeEach(async () => { await truncateAll(db); auth.clearCache(); vi.clearAllMocks(); info.userNonFundingLedgerUpdates.mockResolvedValue([]); exchange.acquire.mockResolvedValue(undefined); exchange.send.mockResolvedValue({ status: "ok", response: { type: "default" } }); });
  afterAll(async () => { delete process.env.AUTH_SERVICE_TOKEN; await app.close(); await closeTestDb(); });
  afterEach(() => vi.restoreAllMocks());
  const post = (path: string, body: object = {}, token = "alice") => request(app.getHttpServer()).post(ROOT + path).set("Authorization", `Bearer ${token}`).send(body);
  const current = (token = "alice") => request(app.getHttpServer()).get(ROOT + "/current").set("Authorization", `Bearer ${token}`);
  async function reserve() { return (await post("", INPUT).expect(200)).body.data; }
  async function unknown() {
    const op = await reserve();
    const claim = await post(`/${op.id}/broadcast`).expect(200);
    expect(claim.body.data.claimed).toBe(true);
    return op;
  }
  async function signature(op: { nonce: number }, changes: { destination?: string; amount?: string; time?: number; chainId?: number } = {}) {
    return TEST_ACCOUNT.signTypedData({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: changes.chainId ?? 421614, verifyingContract: "0x0000000000000000000000000000000000000000" },
      primaryType: "HyperliquidTransaction:Withdraw",
      types: { "HyperliquidTransaction:Withdraw": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] },
      message: { hyperliquidChain: "Testnet", destination: changes.destination ?? DEST, amount: changes.amount ?? "12.5", time: BigInt(changes.time ?? op.nonce) },
    });
  }

  it('retains unknown after shared quota wait ages the original owner proof and never retries', async () => {
    const op = await unknown(), sig = await signature(op); let nativeCalls = 0;
    exchange.send.mockImplementation(async (_operation, _signature, guard) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5001);
      try { if (!guard) throw Error('missing native withdrawal guard'); guard(); nativeCalls++; return { status: 'ok', response: { type: 'default' } }; }
      finally { clock.mockRestore(); }
    });
    const res = await post(`/${op.id}/submit`, { signature: sig }).expect(200);
    expect(res.body.data.status).toBe('unknown'); expect(exchange.send.mock.calls[0][2]).toEqual(expect.any(Function)); expect(nativeCalls).toBe(0);
    await post(`/${op.id}/submit`, { signature: sig }).expect(200); expect(exchange.send).toHaveBeenCalledTimes(1);
  });

  it("logs every state change of a withdrawal, with its id and nonce, never the signature or destination", async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation(function (this: Logger, message: unknown) { lines.push(message); });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(function (this: Logger, message: unknown) { lines.push(message); });
    const op = await unknown(), sig = await signature(op);
    await post(`/${op.id}/submit`, { signature: sig }).expect(200);
    const events = (lines as Array<{ event?: string; withdrawalId?: string; nonce?: number; status?: string }>).filter((line) => line?.event?.startsWith("withdrawal."));
    expect(events.map((e) => [e.event, e.status])).toEqual([
      ["withdrawal.reserved", "prepared"], ["withdrawal.claimed", "unknown"], ["withdrawal.submit.started", "unknown"], ["withdrawal.submit.result", "accepted"],
    ]);
    expect(events.every((e) => e.withdrawalId === op.id && e.nonce === op.nonce)).toBe(true);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(sig.slice(2, 40));
    expect(text).not.toContain(DEST);
  });

  it("logs a submission whose answer is lost as unknown", async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation(function (this: Logger, message: unknown) { lines.push(message); });
    exchange.send.mockRejectedValueOnce(new Error("socket hang up"));
    const op = await unknown();
    await post(`/${op.id}/submit`, { signature: await signature(op) }).expect(200);
    expect(lines).toContainEqual(expect.objectContaining({ event: "withdrawal.submit.failed", withdrawalId: op.id, outcome: "unknown" }));
  });

  it("reserves one canonical operation across devices and recovers it without provider side effects", async () => {
    const first = await reserve();
    const second = (await post("", { ...INPUT, amount: "12.5" }).expect(200)).body.data;
    expect(second).toEqual(first);
    expect(first).toMatchObject({ network: "testnet", address: MAIN, destination: DEST, amount: "12.5", status: "prepared" });
    const recovered = await current().expect(200);
    expect(recovered.headers["cache-control"]).toBe("no-store");
    expect(recovered.body.data).toEqual(first);
    expect(info.userNonFundingLedgerUpdates).not.toHaveBeenCalled();
  });

  it("serializes concurrent different intents and permits only one active operation", async () => {
    const replies = await Promise.all([post("", INPUT), post("", { ...INPUT, destination: OTHER })]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
  });

  it("gives concurrent identical intents one immutable nonce and ID", async () => {
    const replies = await Promise.all([post("", INPUT), post("", INPUT)]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    expect(replies[0].body.data).toEqual(replies[1].body.data);
  });

  it("grants broadcast permission once and blocks a new intent while the outcome is unknown", async () => {
    const op = await reserve();
    const replies = await Promise.all([post(`/${op.id}/broadcast`), post(`/${op.id}/broadcast`)]);
    expect(replies.map((reply) => reply.body.data.claimed).sort()).toEqual([false, true]);
    expect((await current().expect(200)).body.data).toMatchObject({ id: op.id, nonce: op.nonce, status: "unknown" });
    await post("", { ...INPUT, amount: "20" }).expect(409);
    // The server can still prove that no exchange attempt was made.
    expect((await current().expect(200)).body.data.canCancel).toBe(true);
    await post(`/${op.id}/cancel`).expect(200);
  });

  it("cancels only unbroadcast preparation, retires that ID and never reuses its nonce", async () => {
    const op = await reserve();
    expect((await post(`/${op.id}/cancel`).expect(200)).body.data.status).toBe("cancelled");
    const next = await reserve();
    expect(next.id).not.toBe(op.id);
    expect(next.nonce).toBeGreaterThan(op.nonce);
    expect((await post(`/${op.id}/broadcast`).expect(200)).body.data.claimed).toBe(false);
  });

  it("isolates operation ownership, including missing and malformed IDs", async () => {
    const op = await reserve();
    expect((await current("bob").expect(200)).body.data).toBeNull();
    for (const action of ["broadcast", "cancel", "reconcile"]) {
      await post(`/${op.id}/${action}`, {}, "bob").expect(404);
      await post(`/not-a-uuid/${action}`).expect(400);
    }
    expect(info.userNonFundingLedgerUpdates).not.toHaveBeenCalled();
  });

  it("rejects anonymous and service callers", async () => {
    await request(app.getHttpServer()).get(ROOT + "/current").expect(401);
    await current(SERVICE).expect(403);
    await post("", INPUT, SERVICE).expect(403);
  });

  it("rejects client-selected networks, addresses, statuses, signatures and invalid amounts", async () => {
    for (const body of [
      { ...INPUT, network: "mainnet" }, { ...INPUT, address: OTHER }, { ...INPUT, status: "accepted" },
      { ...INPUT, signature: "secret" }, { ...INPUT, amount: "1" }, { ...INPUT, amount: "1e3" },
      { ...INPUT, amount: "1.0000001" }, { ...INPUT, destination: "0x123" },
    ]) await post("", body).expect(400);
  });

  it("does not treat a bounded empty ledger or a mismatched nonce as evidence of failure or success", async () => {
    const op = await unknown();
    info.userNonFundingLedgerUpdates.mockResolvedValue([{ time: op.nonce, hash: `0x${"aa".repeat(32)}`, delta: { type: "withdraw", nonce: op.nonce + 1, usdc: "12.5", fee: "1" } }]);
    expect((await post(`/${op.id}/reconcile`).expect(200)).body.data.status).toBe("unknown");
    await post("", { ...INPUT, amount: "20" }).expect(409);
  });

  it("requires the exact withdrawal amount and type as well as nonce", async () => {
    const op = await unknown();
    info.userNonFundingLedgerUpdates.mockResolvedValue([
      { time: op.nonce, hash: `0x${"aa".repeat(32)}`, delta: { type: "withdraw", nonce: op.nonce, usdc: "999", fee: "1" } },
      { time: op.nonce, hash: `0x${"bb".repeat(32)}`, delta: { type: "deposit", nonce: op.nonce, usdc: "12.5" } },
    ]);
    expect((await post(`/${op.id}/reconcile`).expect(200)).body.data.status).toBe("unknown");
  });

  it("correlates the live microsecond ledger nonce and exact net amount plus fee", async () => {
    const op = await unknown();
    info.userNonFundingLedgerUpdates.mockResolvedValue([{ time: op.nonce + 1, hash: `0x${"aa".repeat(32)}`, delta: { type: "withdraw", nonce: op.nonce * 1000, usdc: "11.500000", fee: "1.0" } }]);
    expect((await post(`/${op.id}/reconcile`).expect(200)).body.data.status).toBe("accepted");
  });

  it("accepts only correlated authoritative ledger evidence on the account's configured network", async () => {
    const op = await unknown();
    info.userNonFundingLedgerUpdates.mockResolvedValue([{ time: op.nonce + 1, hash: `0x${"aa".repeat(32)}`, delta: { type: "withdraw", nonce: op.nonce, usdc: "12.500000", fee: "1" } }]);
    expect((await post(`/${op.id}/reconcile`).expect(200)).body.data).toMatchObject({ id: op.id, nonce: op.nonce, status: "accepted" });
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledWith(MAIN, op.nonce - 60_000, expect.any(Number), "background", expect.any(Number), "https://api.hyperliquid-testnet.xyz/info");
    expect((await post("", { ...INPUT, amount: "20" }).expect(200)).body.data.id).not.toBe(op.id);
  });

  it("retains uncertainty after upstream failure and does not expose upstream diagnostics", async () => {
    const op = await unknown();
    info.userNonFundingLedgerUpdates.mockRejectedValue(new Error("provider-private-details"));
    const reply = await post(`/${op.id}/reconcile`).expect(502);
    expect(JSON.stringify(reply.body)).not.toContain("provider-private-details");
    expect((await current().expect(200)).body.data.status).toBe("unknown");
  });

  it("imports a legacy unknown operation with its original nonce and never broadcasts it", async () => {
    const legacy = { ...INPUT, nonce: Date.now() - 30_000 };
    const first = (await post("/import", legacy).expect(200)).body.data;
    expect(first).toMatchObject({ nonce: legacy.nonce, amount: "12.5", status: "unknown" });
    expect((await post("/import", legacy).expect(200)).body.data.id).toBe(first.id);
    expect((await post(`/${first.id}/broadcast`).expect(200)).body.data.claimed).toBe(false);
    expect(info.userNonFundingLedgerUpdates).not.toHaveBeenCalled();
  });

  it("shows an imported older uncertain intent before newer completed history", async () => {
    const completed = await unknown();
    info.userNonFundingLedgerUpdates.mockResolvedValue([{ time: completed.nonce, hash: `0x${"aa".repeat(32)}`, delta: { type: "withdraw", nonce: completed.nonce, usdc: "12.5", fee: "1" } }]);
    await post(`/${completed.id}/reconcile`).expect(200);
    const imported = (await post("/import", { ...INPUT, nonce: completed.nonce - 30_000 }).expect(200)).body.data;
    expect((await current().expect(200)).body.data).toMatchObject({ id: imported.id, status: "unknown" });
  });

  it("conservatively upgrades a matching prepared operation when legacy metadata proves an uncertain outcome", async () => {
    const prepared = await reserve();
    const imported = (await post("/import", { ...INPUT, nonce: prepared.nonce }).expect(200)).body.data;
    expect(imported).toMatchObject({ id: prepared.id, nonce: prepared.nonce, status: "unknown" });
    expect((await post(`/${prepared.id}/broadcast`).expect(200)).body.data.claimed).toBe(false);
  });

  it("verifies the actual EIP-712 signer and immutable payload before a single trusted exchange submission", async () => {
    const op = await unknown();
    const signed = await signature(op);
    const responses = await Promise.all([post(`/${op.id}/submit`, { signature: signed }), post(`/${op.id}/submit`, { signature: signed })]);
    expect(responses.map((reply) => reply.status)).toEqual([200, 200]);
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect(exchange.send).toHaveBeenCalledWith(expect.objectContaining({ address: MAIN, nonce: op.nonce, destination: DEST, amount: "12.5" }), signed, expect.any(Function));
    expect((await current().expect(200)).body.data.status).toBe("accepted");
    expect(JSON.stringify(responses.map((reply) => reply.body))).not.toContain(signed);
    const [saved] = await db.select().from(walletWithdrawals).where(eq(walletWithdrawals.id, op.id));
    expect(saved).toMatchObject({ status: "accepted", attemptedAt: expect.any(Date), evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(saved)).not.toContain(signed);
  });

  it("rejects signatures for a different destination, amount, nonce, chain or owner without contacting the exchange", async () => {
    const op = await unknown();
    for (const changes of [{ destination: OTHER }, { amount: "20" }, { time: op.nonce + 1 }, { chainId: 42161 }]) {
      await post(`/${op.id}/submit`, { signature: await signature(op, changes) }).expect(400);
    }
    await post(`/${op.id}/submit`, { signature: `0x${"00".repeat(65)}` }).expect(400);
    await post(`/${op.id}/submit`, { signature: "not-a-signature" }).expect(400);
    // A well-formed signature by a different EOA must also fail.
    const foreign = await privateKeyToAccount(`0x${"22".repeat(32)}`).signTypedData({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" },
      primaryType: "HyperliquidTransaction:Withdraw",
      types: { "HyperliquidTransaction:Withdraw": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] },
      message: { hyperliquidChain: "Testnet", destination: DEST, amount: "12.5", time: BigInt(op.nonce) },
    });
    await post(`/${op.id}/submit`, { signature: foreign }).expect(400);
    expect(exchange.send).not.toHaveBeenCalled();
    expect(exchange.acquire).not.toHaveBeenCalled();
  });

  it("records a definitive exchange rejection and allows a fresh explicit intent", async () => {
    const op = await unknown();
    exchange.send.mockResolvedValue({ status: "err", response: "Insufficient withdrawable balance" });
    expect((await post(`/${op.id}/submit`, { signature: await signature(op) }).expect(200)).body.data.status).toBe("rejected");
    const next = await reserve();
    expect(next.id).not.toBe(op.id); expect(next.nonce).toBeGreaterThan(op.nonce);
  });

  it.each(["disabled", "replaced"])("does not submit when the owner is %s while waiting for the exchange budget", async (change) => {
    const op = await unknown();
    const [operation] = await db.select().from(walletWithdrawals).where(eq(walletWithdrawals.id, op.id));
    exchange.acquire.mockImplementationOnce(async () => {
      await db.update(users).set(change === "disabled" ? { disabledAt: new Date() } : { embeddedWalletAddress: OTHER })
        .where(eq(users.id, operation!.userId));
    });
    await post(`/${op.id}/submit`, { signature: await signature(op) }).expect(409);
    expect(exchange.send).not.toHaveBeenCalled();
    const [saved] = await db.select().from(walletWithdrawals).where(eq(walletWithdrawals.id, op.id));
    expect(saved).toMatchObject({ status: "unknown", attemptedAt: null });
  });

  it("waits for an in-progress owner disable transaction before deciding the durable submission boundary", async () => {
    const op = await unknown();
    const [operation] = await db.select().from(walletWithdrawals).where(eq(walletWithdrawals.id, op.id));
    const locked = deferred();
    const release = deferred();
    const disable = db.transaction(async (tx) => {
      await tx.update(users).set({ disabledAt: new Date() }).where(eq(users.id, operation!.userId));
      locked.resolve();
      await release.promise;
    });
    void disable.catch((error: unknown) => locked.reject(error));
    let attempt: Promise<unknown> | undefined;
    try {
      await locked.promise;
      attempt = app.get(WithdrawalRepository).beginSubmit(operation!.userId, op.id);
      void attempt.catch(() => undefined);
      await vi.waitFor(async () => {
        const result = await db.execute<{ blocked: boolean }>(sql`
          select exists(select 1 from pg_stat_activity
            where datname = current_database() and query ilike '%from "users"%'
            and query ilike '%for share%' and cardinality(pg_blocking_pids(pid)) > 0) as blocked
        `);
        expect(result.rows[0]?.blocked).toBe(true);
      }, { timeout: 1500, interval: 10 });
    } finally {
      release.resolve();
      try { await disable; }
      finally { await attempt?.catch(() => undefined); }
    }
    await expect(attempt).rejects.toMatchObject({ status: 409 });
    const [saved] = await db.select().from(walletWithdrawals).where(eq(walletWithdrawals.id, op.id));
    expect(saved!.attemptedAt).toBeNull();
    expect(exchange.send).not.toHaveBeenCalled();
  });

  it("restores preparation when the request budget fails before any exchange attempt", async () => {
    const op = await unknown();
    exchange.acquire.mockRejectedValueOnce(new Error("budget unavailable"));
    await post(`/${op.id}/submit`, { signature: await signature(op) }).expect(503);
    expect(exchange.send).not.toHaveBeenCalled();
    expect((await current().expect(200)).body.data).toMatchObject({ id: op.id, nonce: op.nonce, status: "prepared" });
    await post(`/${op.id}/broadcast`).expect(200);
    expect((await post(`/${op.id}/submit`, { signature: await signature(op) }).expect(200)).body.data.status).toBe("accepted");
    expect(exchange.send).toHaveBeenCalledTimes(1);
  });

  it("retains ambiguity after nonce errors, malformed responses and transport failure without retrying", async () => {
    for (const result of [{ status: "err", response: "Nonce already used" }, { status: "ok", response: { type: "order" } }, new Error("private upstream details")]) {
      await truncateAll(db); auth.clearCache(); vi.clearAllMocks();
      const op = await unknown();
      if (result instanceof Error) exchange.send.mockRejectedValueOnce(result); else exchange.send.mockResolvedValueOnce(result);
      const body = { signature: await signature(op) };
      expect((await post(`/${op.id}/submit`, body).expect(200)).body.data.status).toBe("unknown");
      expect((await post(`/${op.id}/submit`, body).expect(200)).body.data.status).toBe("unknown");
      expect(exchange.send).toHaveBeenCalledTimes(1);
    }
  });

  it("does not let a legacy import convert an uncertain browser broadcast into a new server submission", async () => {
    const op = await unknown();
    const imported = (await post("/import", { ...INPUT, nonce: op.nonce }).expect(200)).body.data;
    expect(imported).toMatchObject({ id: op.id, status: "unknown", canCancel: false });
    await post(`/${op.id}/submit`, { signature: await signature(op) }).expect(409);
    await post(`/${op.id}/cancel`).expect(409);
    expect(exchange.send).not.toHaveBeenCalled();
  });

  it("cannot cancel uncertainty after the server marked its exchange attempt", async () => {
    const op = await unknown();
    exchange.send.mockRejectedValueOnce(new Error("response lost"));
    const reply = await post(`/${op.id}/submit`, { signature: await signature(op) }).expect(200);
    expect(reply.body.data).toMatchObject({ status: "unknown", canCancel: false });
    await post(`/${op.id}/cancel`).expect(409);
  });

  it("never submits legacy lookup-only imports, or unclaimed preparation", async () => {
    const prepared = await reserve();
    await post(`/${prepared.id}/submit`, { signature: await signature(prepared) }).expect(409);
    await post(`/${prepared.id}/cancel`).expect(200);
    const imported = (await post("/import", { ...INPUT, nonce: prepared.nonce - 20_000 }).expect(200)).body.data;
    await post(`/${imported.id}/submit`, { signature: await signature(imported) }).expect(409);
    expect(exchange.send).not.toHaveBeenCalled();
  });
});
