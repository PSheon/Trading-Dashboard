import { copyEvents, notificationChannels, notificationOutbox } from "@trading-dashboard/shared/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { NotifyRepository } from "../src/notify/notify.repository.js";
import { NotifyService } from "../src/notify/notify.service.js";
import { TelegramApiError, type TelegramHttpClient } from "../src/notify/telegram-http.client.js";
import { TelegramLinkRepository } from "../src/telegram/telegram-link.repository.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

describe("confirmed copy notifications with durable delivery", () => {
  const db = getTestDb();
  const repository = new NotifyRepository(db);
  const link = new TelegramLinkRepository(db);
  const sendMessage = vi.fn(async (_chat: string, _text: string) => {});
  const service = () => new NotifyService(testConfig(), repository, new UnitOfWork(db), { sendMessage } as unknown as TelegramHttpClient);
  let owner: number;
  beforeEach(async () => {
    await truncateAll(db);
    sendMessage.mockReset();
    vi.stubEnv("TELEGRAM_DRY_RUN", "false");
    owner = (await insertUser(db)).id;
    await db.insert(notificationChannels).values({ userId: owner, kind: "telegram", target: "123" });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(closeTestDb);
  const event = async (type = "order_filled", extra: Record<string, unknown> = {}) => (await db.insert(copyEvents).values({
    userId: owner, type, payload: { mode: "paper", coin: "BTC", side: "B", size: "0.1", px: "50000", ...extra },
  }).returning())[0];

  it("opts in to future confirmed paper events only and deduplicates concurrent drains and restarts", async () => {
    await event();
    await service().deliverAction();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await link.setCopyAlerts(owner, true)).toBe(true);
    const confirmed = await event();
    await event("unconfirmed");
    await event("order_filled", { mode: "live" });
    await Promise.all([service().deliverAction(), service().deliverAction()]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe("123");
    expect(sendMessage.mock.calls[0][1]).toContain("PAPER / simulated funds");
    expect(sendMessage.mock.calls[0][1]).toContain(`Event #${confirmed.id}`);
    expect((await db.select().from(notificationOutbox))[0]).toMatchObject({ actionId: null, copyEventId: confirmed.id, status: "sent" });
    await db.delete(notificationOutbox); // retention cannot erase the event's dedup marker
    await service().deliverAction();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("recovers rate-limited deliveries after restart and respects opt-out before retry", async () => {
    await link.setCopyAlerts(owner, true);
    await event("funds_added", { amount: "500" });
    sendMessage.mockRejectedValueOnce(new TelegramApiError("sendMessage", 429, "limited", 120));
    await service().deliverAction();
    const [pending] = await db.select().from(notificationOutbox);
    expect(pending.status).toBe("pending");
    expect(pending.availableAt.getTime() - Date.now()).toBeGreaterThan(100_000);
    await db.update(notificationOutbox).set({ availableAt: sql`now()` });
    await service().deliverAction();
    expect((await db.select().from(notificationOutbox))[0].status).toBe("sent");
    await event("funds_withdrawn", { amount: "200" });
    sendMessage.mockRejectedValueOnce(new TelegramApiError("sendMessage", 429, "limited", 120));
    await service().deliverAction();
    await link.setCopyAlerts(owner, false);
    await db.update(notificationOutbox).set({ availableAt: sql`now()` });
    const count = sendMessage.mock.calls.length;
    await service().deliverAction();
    expect(sendMessage).toHaveBeenCalledTimes(count);
    const rows = await db.select().from(notificationOutbox);
    expect(rows.find(row => row.status === "failed")?.lastError).toContain("authorization withdrawn");
  });

  it("rechecks ownership and channel target, and exposes only allowlisted payload fields", async () => {
    await link.setCopyAlerts(owner, true);
    const e = await event("strategy_stopped", { secret: "DO_NOT_RENDER" });
    const candidates = await repository.copyCandidates();
    expect(candidates).toHaveLength(1);
    await service().deliverAction();
    expect(sendMessage.mock.calls[0][1]).not.toContain("DO_NOT_RENDER");
    await db.update(notificationOutbox).set({ status: "pending", availableAt: sql`now()` });
    await db.update(notificationChannels).set({ target: "other-chat" });
    await service().deliverAction();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const other = await insertUser(db);
    expect(await repository.copyEvent(e.id, other.id)).toBeUndefined();
    expect(await link.setCopyAlerts(other.id, true)).toBe(false);
    expect((await db.select().from(copyEvents).where(eq(copyEvents.id, e.id)))[0].notificationQueuedAt).not.toBeNull();
  });
});
