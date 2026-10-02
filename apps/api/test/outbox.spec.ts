import { RulesSeedRepository } from "../src/rules/rules-seed.repository.js";
import { RulesRepository } from "../src/rules/rules.repository.js";
import { NotifyRepository } from "../src/notify/notify.repository.js";
import { OutboxRepository } from "../src/outbox/outbox.repository.js";
import { testConfig } from "./config-test-utils.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  actions,
  actionOutbox,
  alerts,
  leaders,
  notificationChannels,
  notificationCooldowns,
  notificationOutbox,
  userFavorites,
} from "@trading-dashboard/shared/database";
import { NotifyService } from "../src/notify/notify.service.js";
import type { TelegramHttpClient } from "../src/notify/telegram-http.client.js";
import { OutboxService } from "../src/outbox/outbox.service.js";
import { RulesService } from "../src/rules/rules.service.js";
import { SettingsService } from "../src/settings/settings.service.js";
import type { WatcherService } from "../src/watcher/watcher.service.js";
import { insertActions, withActionLock } from "../src/watcher/action-store.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const db = getTestDb();
const address = "0x" + "ab".repeat(20);
const sendMessage = vi.fn(async () => {});
let userId: number;
const notify = () => new NotifyService(testConfig(), new NotifyRepository(db), new UnitOfWork(db), { sendMessage } as unknown as TelegramHttpClient);
const rules = (sender = notify()) => new RulesService(new RulesRepository(), new UnitOfWork(db), { getEquityUsd: () => null } as unknown as WatcherService, sender, new SettingsService(new SettingsRepository(db), new UnitOfWork(db)));
const create = () => withActionLock(db, address, (tx) => insertActions(tx, address, [{
  coin: "BTC", kind: "open", side: "long", notionalUsd: "60000", avgPx: "60000", leverage: null, fillIds: [], ts: new Date(),
}], true)).then(([row]) => row);

beforeEach(async () => {
  await truncateAll(db); sendMessage.mockClear();
  vi.stubEnv("TELEGRAM_DRY_RUN", "false");
  userId = (await insertUser(db)).id;
  await db.insert(leaders).values({ address, source: "favorite" });
  await db.insert(userFavorites).values({ userId, address, alertEnabled: true, alertSides: "both" });
  await db.insert(notificationChannels).values({ userId, kind: "telegram", target: "chat", enabled: true });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(closeTestDb);

it("recovers an action whose in-memory event was lost and sends only one persisted delivery", async () => {
  const action = await create();
  expect(await db.select().from(actionOutbox)).toMatchObject([{ actionId: action.id, status: "pending" }]);
  const sender = notify();
  await new OutboxService(testConfig(), new OutboxRepository(db), rules(sender), sender).drain();
  await new OutboxService(testConfig(), new OutboxRepository(db), rules(), notify()).drain();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(await db.select().from(notificationOutbox)).toMatchObject([{ status: "sent", attempts: 1 }]);
  expect(await db.select().from(alerts)).toHaveLength(1);
  expect(await db.select().from(actionOutbox)).toMatchObject([{ status: "done" }]);
});

it("rolls back actions and their delivery intent together", async () => {
  await expect(withActionLock(db, address, async (tx) => {
    await insertActions(tx, address, [{ coin: "BTC", kind: "open", side: "long", notionalUsd: "1", avgPx: "1", leverage: null, fillIds: [], ts: new Date() }], true);
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(await db.select().from(actions)).toHaveLength(0);
  expect(await db.select().from(actionOutbox)).toHaveLength(0);
});

it("keeps cooldown reservation and enqueue atomic when enqueue fails", async () => {
  const action = await create();
  const sender = notify();
  const broken = vi.spyOn(sender, "notifyAlert").mockRejectedValueOnce(new Error("write failed"));
  await expect(rules(sender).evaluateAction(action)).rejects.toThrow("write failed");
  expect(await db.select().from(notificationCooldowns)).toHaveLength(0);
  expect(await db.select().from(notificationOutbox)).toHaveLength(0);
  expect(await db.select().from(actionOutbox)).toMatchObject([{ status: "pending" }]);
  broken.mockRestore();
  await rules().evaluateAction(action);
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it("shares durable cooldowns across service instances and concurrent actions", async () => {
  const first = await create(); const second = await create();
  await Promise.all([rules().evaluateAction(first), rules().evaluateAction(second)]);
  await rules().evaluateAction(first);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(await db.select().from(notificationOutbox)).toHaveLength(1);
  expect(await db.select().from(actionOutbox)).toMatchObject([{ status: "done" }, { status: "done" }]);
});

it("recovers an expired delivery lease, and never sends to an unlinked destination", async () => {
  const action = await create();
  const sender = notify();
  await db.transaction((tx) => sender.notifyAlert({ action, traderName: null, recipient: { userId, telegramChatId: "chat", locale: "en" }, favorite: true, rules: [] }, tx));
  await db.update(notificationOutbox).set({ status: "processing", lockedUntil: new Date(0), leaseToken: "old-worker" });
  await db.update(notificationChannels).set({ enabled: false }).where(eq(notificationChannels.userId, userId));
  await notify().deliverAction();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(await db.select().from(notificationOutbox)).toMatchObject([{ status: "failed", lastError: "no enabled Telegram channel" }]);
});

it("does not deliver a queued favorite alert after the user disables it", async () => {
  const action = await create();
  await db.transaction((tx) => notify().notifyAlert({ action, traderName: null, recipient: { userId, telegramChatId: "chat", locale: "en" }, favorite: true, rules: [] }, tx));
  await db.update(userFavorites).set({ alertEnabled: false });
  await notify().deliverAction();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(await db.select().from(notificationOutbox)).toMatchObject([{ status: "failed", lastError: "alert authorization withdrawn" }]);
});

it("preserves long Retry-After across restarts and updates the existing alert on success", async () => {
  const { TelegramApiError } = await import("../src/notify/telegram-http.client.js");
  const action = await create();
  const before = Date.now();
  sendMessage.mockRejectedValueOnce(new TelegramApiError("sendMessage", 429, "retry later", 120));
  await rules().evaluateAction(action);
  const [pending] = await db.select().from(notificationOutbox);
  expect(pending.status).toBe("pending");
  expect(pending.availableAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
  await notify().deliverAction();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  await db.update(notificationOutbox).set({ availableAt: new Date(0) });
  await notify().deliverAction();
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(await db.select().from(alerts)).toMatchObject([{ sendStatus: "sent" }]);
  expect(await db.select().from(alerts)).toHaveLength(1);
});

it("claims a delivery once even when another sender polls while Telegram is pending", async () => {
  const action = await create();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  sendMessage.mockImplementationOnce(async () => { entered(); await pending; });
  const first = rules().evaluateAction(action);
  await started;
  await notify().deliverAction();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  release(); await first;
  expect(await db.select().from(notificationOutbox)).toMatchObject([{ status: "sent" }]);
});

it("replays percentage rules using the equity captured with the action", async () => {
  const { users } = await import("@trading-dashboard/shared/database");
  const { RulesSeedService } = await import("../src/rules/rules-seed.service.js");
  await db.update(users).set({ role: "admin" });
  await db.delete(userFavorites);
  await db.update(leaders).set({ source: "import", tier: "A" });
  await new RulesSeedService(testConfig(), new RulesSeedRepository(db)).seedDefaultRules();
  const [action] = await withActionLock(db, address, (tx) => insertActions(tx, address, [{
    coin: "BTC", kind: "open", side: "long", notionalUsd: "10000", avgPx: "60000", leverage: null, fillIds: [], ts: new Date(),
  }], true, 50000));
  expect(await db.select().from(actionOutbox)).toMatchObject([{ equityUsd: "50000" }]);
  await new OutboxService(testConfig(), new OutboxRepository(db), rules(), notify()).drain();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const [delivery] = await db.select().from(notificationOutbox);
  expect(delivery.payloadJson).toMatchObject({ reasons: { rules: ["R1", "R3"] } });
  expect(delivery.actionId).toBe(action.id);
});

it("preserves Retry-After from the final immediate attempt", async () => {
  const { TelegramApiError } = await import("../src/notify/telegram-http.client.js");
  const action = await create();
  sendMessage.mockRejectedValueOnce(new Error("network"))
    .mockRejectedValueOnce(new Error("network"))
    .mockRejectedValueOnce(new Error("network"))
    .mockRejectedValueOnce(new TelegramApiError("sendMessage", 429, "retry later", 3600));
  const before = Date.now();
  await rules().evaluateAction(action);
  const [pending] = await db.select().from(notificationOutbox);
  expect(sendMessage).toHaveBeenCalledTimes(4);
  expect(pending.availableAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
}, 15000);

it("checks authorization again when a retry follows revocation", async () => {
  const action = await create();
  sendMessage.mockImplementationOnce(async () => {
    await db.update(userFavorites).set({ alertEnabled: false });
    throw new Error("temporary failure");
  });
  await rules().evaluateAction(action);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(await db.select().from(notificationOutbox)).toMatchObject([{ status: "failed" }]);
});

it("ignores a stale worker failure after another worker reclaims the action", async () => {
  const action = await create();
  const repository = new OutboxRepository(db);
  const now = new Date();
  const first = await repository.claim(action.id, now, new Date(now.getTime() - 1));
  expect(first).toBeDefined();
  const second = await repository.claim(action.id, now, new Date(now.getTime() + 300_000));
  expect(second?.attempts).toBe(first!.attempts + 1);
  await repository.recordFailure(action.id, "pending", now, first!.attempts);
  expect(await db.select().from(actionOutbox)).toMatchObject([
    { actionId: action.id, status: "processing", attempts: second!.attempts, lockedUntil: second!.lockedUntil },
  ]);
  await repository.recordFailure(action.id, "pending", now, second!.attempts);
  expect(await db.select().from(actionOutbox)).toMatchObject([
    { actionId: action.id, status: "pending", lockedUntil: null, lastError: "evaluation failed" },
  ]);
});

// --- review round 4, findings 49 and 51 ---------------------------------------------------

/** `count` more users who favorited the trader with alerts on, each with their own chat. */
async function recipients(count: number): Promise<void> {
  const { users } = await import("@trading-dashboard/shared/database");
  const rows = await db.insert(users).values(Array.from({ length: count }, (_, i) => ({ privyUserId: `did:privy:many-${i}-${Date.now()}` }))).returning({ id: users.id });
  await db.insert(userFavorites).values(rows.map((r) => ({ userId: r.id, address, alertEnabled: true, alertSides: "both" as const })));
  await db.insert(notificationChannels).values(rows.map((r) => ({ userId: r.id, kind: "telegram" as const, target: `chat-${r.id}`, enabled: true })));
}

it("an action with 200 recipients is delivered in full by the drain it triggers, not 20 now and 20 every 5 seconds", async () => {
  await recipients(199);
  const started = Date.now();
  await rules().evaluateAction(await create());
  // One evaluation, one drain: every recipient's message has been handed to Telegram.
  expect(sendMessage).toHaveBeenCalledTimes(200);
  expect(new Set(sendMessage.mock.calls.map((c) => (c as unknown as [string])[0])).size).toBe(200);
  expect(Date.now() - started).toBeLessThan(10_000);
  const statuses = await db.execute(sql`select status, count(*)::int as n from notification_outbox group by 1`);
  expect(statuses.rows).toEqual([{ status: "sent", n: 200 }]);
  expect((await db.execute(sql`select count(*)::int as n from alerts where send_status = 'sent'`)).rows).toEqual([{ n: 200 }]);
}, 30_000);

it("the background drain empties a backlog of several actions in one pass", async () => {
  await recipients(59);
  const sender = notify();
  for (let i = 0; i < 4; i++) {
    const action = await create();
    const { users } = await import("@trading-dashboard/shared/database");
    for (const user of await db.select({ id: users.id }).from(users)) {
      await db.transaction((tx) => sender.notifyAlert({ action, traderName: null, recipient: { userId: user.id, telegramChatId: user.id === userId ? "chat" : `chat-${user.id}`, locale: "en" }, favorite: true, rules: [] }, tx));
    }
  }
  // 240 queued (more than two batches); nothing sent yet.
  expect(sendMessage).not.toHaveBeenCalled();
  await notify().deliverAction();
  expect(sendMessage).toHaveBeenCalledTimes(240);
  expect((await db.execute(sql`select count(*)::int as n from notification_outbox where status <> 'sent'`)).rows).toEqual([{ n: 0 }]);
}, 30_000);

it("a queued alert is due at once: the drain right after the commit sends it, with no wait for the next poll", async () => {
  // available_at carries the database's microseconds; a millisecond JS clock read after the commit could be behind it.
  for (let i = 0; i < 20; i++) {
    sendMessage.mockClear();
    const action = await create();
    await db.transaction((tx) => notify().notifyAlert({ action, traderName: null, recipient: { userId, telegramChatId: "chat", locale: "en" }, favorite: true, rules: [] }, tx));
    await notify().deliverAction(action.id);
    expect(sendMessage, `round ${i}`).toHaveBeenCalledTimes(1);
  }
});

it("a delivery that waited past the age limit is dropped as expired, not sent as if the trade were fresh", async () => {
  const { ALERT_MAX_AGE_MS } = await import("../src/notify/notify.service.js");
  const action = await create();
  await db.transaction((tx) => notify().notifyAlert({ action, traderName: null, recipient: { userId, telegramChatId: "chat", locale: "en" }, favorite: true, rules: [] }, tx));
  // Just inside the limit it would still go; the worker was down for longer.
  await db.update(notificationOutbox).set({ createdAt: new Date(Date.now() - ALERT_MAX_AGE_MS - 1_000), availableAt: new Date(0) });
  await notify().deliverAction();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(await db.select().from(notificationOutbox)).toMatchObject([{ status: "failed", lastError: "expired" }]);
  expect(await db.select().from(alerts)).toMatchObject([{ sendStatus: "failed", payloadJson: { reason: "expired" } }]);

  // Inside the limit: sent.
  const fresh = await create();
  await db.update(notificationCooldowns).set({ reservedAt: new Date(0) });
  await db.transaction((tx) => notify().notifyAlert({ action: fresh, traderName: null, recipient: { userId, telegramChatId: "chat", locale: "en" }, favorite: true, rules: [] }, tx));
  await db.update(notificationOutbox).set({ createdAt: new Date(Date.now() - ALERT_MAX_AGE_MS + 60_000) }).where(eq(notificationOutbox.actionId, fresh.id));
  await notify().deliverAction();
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it("a replayed evaluation of an old action is closed without alerting anyone", async () => {
  const { ALERT_MAX_AGE_MS } = await import("../src/notify/notify.service.js");
  // Queued while it was fresh; the worker then stayed down past the limit.
  const queued = await create();
  await db.update(actions).set({ ts: new Date(Date.now() - ALERT_MAX_AGE_MS - 60_000) });
  const [old] = await db.select().from(actions);
  expect(await db.select().from(actionOutbox)).toMatchObject([{ actionId: queued.id, status: "pending" }]);

  // The outbox replay (a worker that was down, a restored backup).
  const service = new OutboxService(testConfig(), new OutboxRepository(db), rules(), notify());
  await service.drain();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(await db.select().from(notificationOutbox)).toHaveLength(0);
  expect(await db.select().from(alerts)).toHaveLength(0);
  expect(await db.select().from(actionOutbox)).toMatchObject([{ actionId: old.id, status: "done", lastError: "expired" }]);

  // The same through the event path (a fill a late sweep found).
  await db.update(actionOutbox).set({ status: "pending", lastError: null });
  await rules().evaluateAction(old);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(await db.select().from(actionOutbox)).toMatchObject([{ status: "done", lastError: "expired" }]);

  // A recent action still alerts.
  await rules().evaluateAction(await create());
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it("the evaluation drain reads 200 actions a pass, oldest first", async () => {
  const { EVALUATION_BATCH } = await import("../src/outbox/outbox.repository.js");
  expect(EVALUATION_BATCH).toBe(200);
  const made = [];
  for (let i = 0; i < 25; i++) made.push(await create());
  const due = await new OutboxRepository(db).findDue(new Date(Date.now() + 1_000));
  // 25 waiting: all of them in one read (it was 20).
  expect(due.map((r) => r.id)).toEqual(made.map((a) => a.id));
});

it("end to end with the real Telegram client: 200 recipients are sent in about 8 seconds, never above Telegram's 30 a second", async () => {
  const { TelegramHttpClient } = await import("../src/notify/telegram-http.client.js");
  const { AppConfig } = await import("../src/config/app-config.js");
  const { validateEnvironment } = await import("../src/config/runtime-config.js");
  const sent: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => { sent.push(Date.now()); return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); }));
  try {
    await recipients(199);
    const config = new AppConfig(validateEnvironment({ DATABASE_URL: "postgres://test@localhost/test", TELEGRAM_BOT_TOKEN: "123:token", TELEGRAM_BOT_USERNAME: "orbie_test_bot", TELEGRAM_DRY_RUN: "false" }));
    const sender = new NotifyService(config, new NotifyRepository(db), new UnitOfWork(db), new TelegramHttpClient(config));
    const started = Date.now();
    await rules(sender).evaluateAction(await create());
    const elapsed = Date.now() - started;
    expect(sent).toHaveLength(200);
    // 199 intervals of 40 ms; before, 200 recipients took 45 seconds.
    expect(elapsed).toBeGreaterThanOrEqual(199 * 40 - 100);
    expect(elapsed).toBeLessThan(15_000);
    const peak = Math.max(...sent.map((t, i) => sent.filter((u, j) => j >= i && u < t + 1_000).length));
    expect(peak).toBeLessThanOrEqual(27);
    expect((await db.execute(sql`select count(*)::int as n from notification_outbox where status = 'sent'`)).rows).toEqual([{ n: 200 }]);
  } finally {
    vi.unstubAllGlobals();
  }
}, 40_000);
