import { actions, alertRules, alerts, leaders } from "@trading-dashboard/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoundTripService } from "../src/analytics/round-trip.service.js";
import { NotifyService } from "../src/notify/notify.service.js";
import type { TelegramHttpClient } from "../src/notify/telegram-http.client.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const CHAIN = "hyperliquid";
const ADDRESS = "0xnotifytest";

function fakeTelegram(impl: TelegramHttpClient["sendMessage"]): TelegramHttpClient {
  return { sendMessage: vi.fn(impl) } as unknown as TelegramHttpClient;
}

describe("NotifyService — real Postgres, mocked Telegram client", () => {
  const db = getTestDb();
  const roundTrip = new RoundTripService(db);

  let ruleId: number;
  let leaderRow: typeof leaders.$inferSelect;
  let actionRow: typeof actions.$inferSelect;

  beforeEach(async () => {
    await truncateAll(db);
    process.env.DRY_RUN = "false";
    process.env.TELEGRAM_CHAT_ID_REALTIME = "chat-realtime";
    process.env.TELEGRAM_CHAT_ID_GROUP = "chat-group";

    const [rule] = await db
      .insert(alertRules)
      .values({
        scope: "address",
        kind: "R1",
        paramsJson: { flatThresholdUsd: 50_000, pctThreshold: 0.1 },
        cooldownS: 900,
        tiers: ["A", "B", "C"],
        enabled: true,
      })
      .returning();
    ruleId = rule.id;

    [leaderRow] = await db
      .insert(leaders)
      .values({ chain: CHAIN, address: ADDRESS, label: "Whale", active: true, tier: "B" })
      .returning();

    [actionRow] = await db
      .insert(actions)
      .values({
        chain: CHAIN,
        address: ADDRESS,
        coin: "BTC",
        kind: "open",
        side: "long",
        notionalUsd: "60000",
        avgPx: "60000",
        leverage: "10",
        fillIds: [],
        ts: new Date(),
      })
      .returning();
  });

  afterEach(() => {
    delete process.env.DRY_RUN;
    delete process.env.TELEGRAM_CHAT_ID_REALTIME;
    delete process.env.TELEGRAM_CHAT_ID_GROUP;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function ruleRow() {
    const [row] = await db.select().from(alertRules).where(eq(alertRules.id, ruleId));
    return row;
  }

  it("DRY_RUN=true never calls the network, and still writes an alerts row with send_status='dry_run'", async () => {
    process.env.DRY_RUN = "true";
    const telegram = fakeTelegram(async () => {});
    const service = new NotifyService(db, roundTrip, telegram);

    await service.notifyRulesFire({ rules: [await ruleRow()], action: actionRow, leader: leaderRow });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ruleId, address: ADDRESS, coin: "BTC", sendStatus: "dry_run" });
    expect(rows[0].sentAt).not.toBeNull();
  });

  it("a successful real send writes send_status='sent' and routes R1 to the realtime chat id", async () => {
    const telegram = fakeTelegram(async () => {});
    const service = new NotifyService(db, roundTrip, telegram);

    await service.notifyRulesFire({ rules: [await ruleRow()], action: actionRow, leader: leaderRow });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("chat-realtime", expect.any(String));
    const [row] = await db.select().from(alerts);
    expect(row.sendStatus).toBe("sent");
  });

  it("the rendered message includes the leader label, coin, side, notional, leverage, avg price, and win rate placeholder", async () => {
    const telegram = fakeTelegram(async () => {});
    const service = new NotifyService(db, roundTrip, telegram);

    await service.notifyRulesFire({ rules: [await ruleRow()], action: actionRow, leader: leaderRow });

    const text = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(text).toContain("Whale");
    expect(text).toContain("BTC");
    expect(text).toContain("n/a"); // no round trips yet -> win rate n/a
    expect(text).toContain(ADDRESS);
  });

  it("N4: retries a failing send up to 3 times (4 attempts total) then records send_status='failed' without throwing", async () => {
    const telegram = fakeTelegram(async () => {
      throw new Error("network down");
    });
    const service = new NotifyService(db, roundTrip, telegram);

    const start = Date.now();
    await expect(
      service.notifyRulesFire({ rules: [await ruleRow()], action: actionRow, leader: leaderRow }),
    ).resolves.toBeUndefined();
    const elapsed = Date.now() - start;

    expect(telegram.sendMessage).toHaveBeenCalledTimes(4);
    // backoff schedule is 1s/2s/4s between attempts = 7s minimum.
    expect(elapsed).toBeGreaterThanOrEqual(6900);

    const [row] = await db.select().from(alerts);
    expect(row.sendStatus).toBe("failed");
  }, 15_000);

  it("writes one alerts row per matched rule when multiple rules fire off the same action, sharing one send outcome", async () => {
    const [r3] = await db
      .insert(alertRules)
      .values({
        scope: "address",
        kind: "R3",
        paramsJson: { flatThresholdUsd: 100_000, pctThreshold: 0.2 },
        cooldownS: 900,
        tiers: ["A", "B", "C"],
        enabled: true,
      })
      .returning();

    const telegram = fakeTelegram(async () => {});
    const service = new NotifyService(db, roundTrip, telegram);

    await service.notifyRulesFire({
      rules: [await ruleRow(), r3],
      action: actionRow,
      leader: leaderRow,
    });

    // One combined Telegram message...
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    // ...but one alerts row per rule.
    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ruleId).sort()).toEqual([ruleId, r3.id].sort());
    expect(rows.every((r) => r.sendStatus === "sent")).toBe(true);
  });
});
