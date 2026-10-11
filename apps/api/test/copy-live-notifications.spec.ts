import { copyEvents, copyFollowerReceipts, copyFundingOperations, copyLiveDispatches, copyLiveExecutions, copyLiveSourceFills, copyLiveStopOperations, copyStrategies, notificationChannels, notificationOutbox, users } from "@trading-dashboard/shared/database";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { NotifyRepository } from "../src/notify/notify.repository.js";
import { ALERT_MAX_AGE_MS, NotifyService } from "../src/notify/notify.service.js";
import type { TelegramHttpClient } from "../src/notify/telegram-http.client.js";
import { TelegramLinkRepository } from "../src/telegram/telegram-link.repository.js";
import { testConfig } from "./config-test-utils.js";
import { preparationFixture } from "./copy-live-preparation-test-utils.js";
import { now as fixtureNow } from "./copy-live-risk-test-utils.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

/** Actual (testnet/mainnet) copies write no owner events: the trade bot reads
 * their terminal live rows, once each, through the paper copy pipeline. */
describe("actual copy notifications", () => {
  const db = getTestDb();
  const repository = new NotifyRepository(db);
  const link = new TelegramLinkRepository(db);
  const sendMessage = vi.fn(async (_chat: string, _text: string) => {});
  const service = () => new NotifyService(testConfig(), repository, new UnitOfWork(db), { sendMessage } as unknown as TelegramHttpClient);
  let seed: Awaited<ReturnType<typeof preparationFixture>>;
  const texts = () => sendMessage.mock.calls.map(call => call[1]);
  const at = (offsetMs = 0) => new Date(Date.now() + offsetMs);
  let nonce = fixtureNow;
  const execution = async (key: string) => {
    nonce += 1;
    await db.insert(copyLiveExecutions).values({ key, network: "testnet", accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${"33".repeat(20)}`,
      cloid: `0x${String(nonce % 10).repeat(32)}`, nonce, userId: 1, strategyId: 9, state: "filled", updatedAt: at(), record: { key } });
  };
  const receipt = async (key: string, executionKey: string, record: Record<string, unknown>) => db.insert(copyFollowerReceipts).values({ key, accountId: "account", network: "testnet",
    accountAddress: seed.f.identity.accountAddress, kind: "fill", sourceId: key, coin: "BTC", providerTime: at(-500), digest: "e".repeat(64), executionKey, attribution: "execution",
    record: { coin: "BTC", closedPnl: "0", totalFee: "0", ...record } });
  // Each leg copies its own leader fill (one leg kind per mandate and fill).
  let tid = 100;
  const dispatch = async (id: string, values: Partial<typeof copyLiveDispatches.$inferInsert>) => {
    tid += 1;
    const [fill] = await db.insert(copyLiveSourceFills).values({ ...seed.fill, normalized: { ...seed.fill.normalized }, providerTime: new Date(seed.fill.providerTime),
      receivedAt: new Date(seed.fill.receivedAt), id: `testnet:${seed.fill.leaderAddress}:${tid}`, tid: String(tid) }).returning();
    await db.insert(copyLiveDispatches).values({ id, mandateId: "mandate", userId: 1, strategyId: 9, accountId: "account", sourceFillId: fill!.id, leg: "open", coin: "BTC",
      leaderTime: at(-2000), receivedAt: at(-1900), ...values });
  };
  const settledLeg = async (id: string, leg: "open" | "close", fills: Record<string, unknown>[], settledAt = at()) => {
    await execution(`k-${id}`);
    for (const [i, fill] of fills.entries()) await receipt(`r-${id}-${i}`, `k-${id}`, fill);
    await dispatch(id, { leg, state: "settled", executionKey: `k-${id}`, settledAt, updatedAt: settledAt });
  };
  const stop = (state: "closing" | "stopped", updatedAt = at()) => db.insert(copyLiveStopOperations).values({ id: "11111111-1111-4111-8111-111111111111", userId: 1, strategyId: 9,
    accountId: "account", mandateId: "mandate", idempotencyKey: "notify-stop-0001", originalMandateRevision: 2, network: "testnet", accountAddress: seed.f.identity.accountAddress,
    ownerPrivyUserId: "did:privy:risk-source", ownerAddress: `0x${"55".repeat(20)}`, accountWalletId: "master", accountOwnerQuorumId: "owner", originalIntentDigest: "a".repeat(64),
    originalConsentDigest: "b".repeat(64), state, targetManifest: {}, targetDigest: "c".repeat(64), trackedExecutionCount: 0, trackingComplete: true,
    ...(state === "stopped" ? { flatCertificate: {}, flatDigest: "d".repeat(64), flatVerifiedAt: updatedAt } : {}), createdAt: new Date(updatedAt.getTime() - 1000), updatedAt });
  const funding = (id: string, status: "accepted" | "credited", extra: Partial<typeof copyFundingOperations.$inferInsert> = {}) => db.insert(copyFundingOperations).values({ id, userId: 1,
    accountId: "account", strategyId: 9, idempotencyKey: `notify-${id}`, network: "testnet", address: seed.f.identity.accountAddress, destination: `0x${"55".repeat(20)}`, amount: "25",
    nonce: (nonce += 1), status, direction: "to_main", claimedAt: at(), attemptedAt: at(), evidenceHash: "a".repeat(64),
    ...(status === "credited" ? { transactionHash: `0x${id.slice(0, 1).repeat(64)}`, creditedAmount: "24", fee: "1" } : {}), updatedAt: at(), ...extra });

  beforeEach(async () => {
    seed = await preparationFixture(db);
    sendMessage.mockReset();
    vi.stubEnv("TELEGRAM_DRY_RUN", "false");
    await db.update(users).set({ locale: "en" });
    await db.insert(notificationChannels).values({ userId: 1, kind: "telegram", target: "123" });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(closeTestDb);

  it("sends a settled leg's actual fill once (size, average price, what it did), even across concurrent and repeated ticks", async () => {
    await link.setCopyAlerts(1, true);
    await settledLeg("leg-open", "open", [
      { side: "B", size: "0.04", price: "50000", raw: { startPosition: "0" } },
      { side: "B", size: "0.06", price: "50100", raw: { startPosition: "0.04" } },
    ]);
    await Promise.all([service().deliverAction(), service().deliverAction()]);
    await service().deliverAction();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const lines = texts()[0]!.split("\n");
    expect(lines.slice(0, 4)).toEqual(["Orbie · TESTNET copy", "🟢 Position opened", `Copying 0x4444…4444`, "Buy 0.1 BTC @ $50,060"]);
    const events = await db.select().from(copyEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: 1, strategyId: 9, type: "order_filled", payload: { mode: "testnet", liveSource: "dispatch:leg-open", action: "open" } });
    expect(await db.select().from(notificationOutbox)).toEqual([expect.objectContaining({ copyEventId: events[0]!.id, status: "sent" })]);
    // The outbox row may be retired: the owner event still marks the leg notified.
    await db.delete(notificationOutbox);
    await service().deliverAction();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("says a close closed (P&L after fees), a partial one reduced, and names the network of a mainnet copy", async () => {
    await link.setCopyAlerts(1, true);
    await db.update(copyStrategies).set({ network: "mainnet" });
    await settledLeg("leg-close", "close", [{ side: "A", size: "0.1", price: "51000", closedPnl: "100", totalFee: "2.5", raw: { startPosition: "0.1" } }]);
    await service().deliverAction();
    expect(texts()[0]!.split("\n").slice(0, 5)).toEqual(["Orbie · Copy", "⚪ Position closed", "Copying 0x4444…4444", "Sell 0.1 BTC @ $51,000", "Realized P&L +$97.5 (after fees)"]);
    await db.delete(copyLiveDispatches);
    await settledLeg("leg-reduce", "close", [{ side: "A", size: "0.05", price: "51000", closedPnl: "50", totalFee: "1", raw: { startPosition: "0.2" } }]);
    await service().deliverAction();
    expect(texts()[1]).toContain("🟠 Position reduced");
    expect(texts()[1]).toContain("Realized P&L +$49");
  });

  it("says a close refused after Hyperliquid liquidated the copy as a liquidation, not a rejected order (CP-EXE-16)", async () => {
    await link.setCopyAlerts(1, true);
    // 1 s ahead: copyAlertsSince is the database clock, the row the test clock.
    await dispatch("leg-liquidated", { leg: "close", state: "refused", reason: "position_liquidated", updatedAt: at(1_000) });
    await service().deliverAction();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(texts()[0]).not.toContain("Order not executed");
    const [event] = await db.select().from(copyEvents);
    expect(event!.type).toBe("position_liquidated");
    expect(event!.payload).toEqual({ mode: "testnet", liveSource: "dispatch:leg-liquidated", coin: "BTC" });
  });

  it("sends a refused leg with its public reason only, never internal bookkeeping refusals or a settled leg that did not fill", async () => {
    await link.setCopyAlerts(1, true);
    await dispatch("leg-refused", { state: "refused", reason: "live_source_price_deviation", updatedAt: at(1_000) });
    await dispatch("leg-merged", { leg: "close", state: "refused", reason: "merged_into_adjustment", updatedAt: at() });
    await dispatch("leg-owner", { leg: "close", state: "refused", reason: "position_closed_by_owner", updatedAt: at() });
    await service().deliverAction();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(texts()[0]).toContain("⛔ Order not executed");
    expect(texts()[0]).toContain("Reason: not executed (order_not_executed)");
    expect(texts()[0]).not.toContain("live_source_price_deviation");
    expect((await db.select().from(copyEvents))[0]!.payload).toEqual({ mode: "testnet", liveSource: "dispatch:leg-refused", coin: "BTC", reason: "order_not_executed" });
    await db.delete(copyLiveDispatches);
    await execution("k-empty");
    await dispatch("leg-empty", { state: "settled", executionKey: "k-empty", settledAt: at(), updatedAt: at() });
    await service().deliverAction();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends a finished stop and a credited return once, never a stop still closing or a return only accepted", async () => {
    await link.setCopyAlerts(1, true);
    await stop("closing");
    await funding("22222222-2222-4222-8222-222222222222", "accepted");
    await service().deliverAction();
    expect(sendMessage).not.toHaveBeenCalled();
    await db.update(copyLiveStopOperations).set({ state: "stopped", flatCertificate: {}, flatDigest: "d".repeat(64), flatVerifiedAt: at(), updatedAt: at() });
    await db.update(copyFundingOperations).set({ status: "credited", transactionHash: `0x${"2".repeat(64)}`, creditedAmount: "24", fee: "1", stopId: "11111111-1111-4111-8111-111111111111", updatedAt: at() });
    await funding("33333333-3333-4333-8333-333333333333", "credited");
    await service().deliverAction();
    await service().deliverAction();
    expect(texts().map(text => text.split("\n")[1]).sort()).toEqual(["⏹ Copy stopped", "💵 Funds returned after stop", "💵 Funds withdrawn"].sort());
    expect(texts().find(text => text.includes("Funds returned"))).toContain("Amount $24");
    for (const text of texts()) expect(text).not.toMatch(/0x[0-9a-f]{40}/);
  });

  it("never backfills: rows before the opt-in, older than the cut-off, or of an owner without copy alerts are not sent or projected", async () => {
    await settledLeg("leg-before", "open", [{ side: "B", size: "0.1", price: "50000", raw: { startPosition: "0" } }], at(-1000));
    await stop("stopped", at(-1000));
    await service().deliverAction(); // copy alerts off
    expect(await db.select().from(copyEvents)).toEqual([]);
    await link.setCopyAlerts(1, true);
    await db.update(notificationChannels).set({ copyAlertsSince: at(-500) });
    await service().deliverAction(); // before the opt-in
    expect(await db.select().from(copyEvents)).toEqual([]);
    const old = at(-ALERT_MAX_AGE_MS - 60_000);
    await db.update(notificationChannels).set({ copyAlertsSince: at(-ALERT_MAX_AGE_MS * 2) });
    await db.update(copyLiveStopOperations).set({ createdAt: new Date(old.getTime() - 1000), updatedAt: old, flatVerifiedAt: old });
    await db.update(copyLiveDispatches).set({ settledAt: old, updatedAt: old });
    await dispatch("leg-old", { leg: "close", state: "refused", reason: "live_source_price_deviation", updatedAt: old });
    await service().deliverAction(); // older than the cut-off
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await db.select().from(copyEvents)).toEqual([]);
    // A hand-written actual-mode event that is not projected from live rows is still never sent.
    await db.insert(copyEvents).values({ userId: 1, strategyId: 9, type: "order_filled", payload: { mode: "live", coin: "BTC" } });
    await service().deliverAction();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(notificationOutbox))[0]!.n).toBe(0);
  });
});
