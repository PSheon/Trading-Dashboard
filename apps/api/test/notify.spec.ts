import { actions, alertRules, alerts, notificationOutbox, notificationChannels, userFavorites, readAlertDisplayValues } from "@trading-dashboard/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderAlertMessage, tradeSideOf } from "../src/notify/message-template.js";
import { NotifyService, type AlertContext } from "../src/notify/notify.service.js";
import { TelegramApiError, type TelegramHttpClient } from "../src/notify/telegram-http.client.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const CHAIN = "hyperliquid";
const ADDRESS = "0x" + "ab".repeat(20);

function fakeTelegram(impl: TelegramHttpClient["sendMessage"]): TelegramHttpClient {
  return { sendMessage: vi.fn(impl) } as unknown as TelegramHttpClient;
}

describe("alert display contract", () => {
  it("reads versioned and historical payloads without trusting unknown versions", () => {
    const values = { actionKind: "open", notionalUsd: "60000" };
    expect(readAlertDisplayValues({ version: 1, values })).toEqual(values);
    expect(readAlertDisplayValues({ values })).toEqual(values);
    expect(readAlertDisplayValues({ kind: "open", notionalUsd: "60000" })).toEqual(values);
    expect(readAlertDisplayValues({ version: 2, values })).toBeUndefined();
    expect(readAlertDisplayValues({ values: { actionKind: "bad", notionalUsd: {} } })).toBeUndefined();
    expect(readAlertDisplayValues({})).toBeUndefined();
  });
});

describe("message template", () => {
  const base = { address: ADDRESS, coin: "BTC", notionalUsd: "1250000", avgPx: "60123.5" };

  it("buy = opening/adding/flipping into a long or closing a short; sell = the mirror", () => {
    expect(tradeSideOf({ kind: "open", side: "long" })).toBe("buy");
    expect(tradeSideOf({ kind: "add", side: "long" })).toBe("buy");
    expect(tradeSideOf({ kind: "flip", side: "long" })).toBe("buy");
    expect(tradeSideOf({ kind: "reduce", side: "short" })).toBe("buy");
    expect(tradeSideOf({ kind: "close", side: "short" })).toBe("buy");
    expect(tradeSideOf({ kind: "liquidation", side: "short" })).toBe("buy");
    expect(tradeSideOf({ kind: "open", side: "short" })).toBe("sell");
    expect(tradeSideOf({ kind: "flip", side: "short" })).toBe("sell");
    expect(tradeSideOf({ kind: "close", side: "long" })).toBe("sell");
    expect(tradeSideOf({ kind: "liquidation", side: "long" })).toBe("sell");
  });

  it("renders a concise zh-TW / en message with side, action, coin, size, price and the trader link", () => {
    const url = `https://app.orbie.fun/trader/${ADDRESS}`;
    const zh = renderAlertMessage({
      locale: "zh-TW",
      traderName: "Whale",
      action: { ...base, kind: "open", side: "long" },
      dashboardUrl: url,
    });
    expect(zh).toBe(
      ["🟢 買入 · 開多 BTC", "Whale · 0xabab…abab", "名目 $1,250,000 · 價格 $60,123.5", url].join("\n"),
    );

    const en = renderAlertMessage({
      locale: "en",
      traderName: null,
      action: { ...base, kind: "close", side: "long", avgPx: "0.0000123456" },
      dashboardUrl: url,
      ruleKinds: ["R3"],
    });
    expect(en).toBe(
      ["🔴 Sell · Close long BTC", "0xabab…abab", "Size $1,250,000 · Price $0.0000123456", "Rules R3", url].join("\n"),
    );
    expect(
      renderAlertMessage({ locale: "zh-TW", traderName: null, action: { ...base, kind: "flip", side: "short" }, dashboardUrl: url }),
    ).toContain("🔴 賣出 · 翻倉 多→空 BTC");
  });
});

describe("NotifyService — real Postgres, mocked Telegram client", () => {
  const db = getTestDb();

  let userId: number;
  let actionRow: typeof actions.$inferSelect;

  beforeEach(async () => {
    await truncateAll(db);
    process.env.TELEGRAM_DRY_RUN = "false";
    // The system chat is for system messages only; alerts never go there.
    process.env.TELEGRAM_SYSTEM_CHAT_ID = "chat-system";

    userId = (await insertUser(db)).id;
    await db.insert(userFavorites).values({ userId, address: ADDRESS, alertEnabled: true });
    await db.insert(notificationChannels).values({ userId, kind: "telegram", target: "chat-user", enabled: true });
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
    delete process.env.TELEGRAM_DRY_RUN;
    delete process.env.TELEGRAM_SYSTEM_CHAT_ID;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function defaultRule(kind: "R1" | "R3") {
    const [rule] = await db
      .insert(alertRules)
      .values({
        scope: "address",
        kind,
        paramsJson: { flatThresholdUsd: 50_000, pctThreshold: 0.1 },
        cooldownS: 900,
        tiers: ["A", "B", "C"],
      })
      .returning();
    return rule;
  }

  function ctx(overrides: Partial<AlertContext> = {}): AlertContext {
    return {
      action: actionRow,
      traderName: "Whale",
      recipient: { userId, telegramChatId: "chat-user", locale: "zh-TW" },
      rules: [],
      favorite: true,
      ...overrides,
    };
  }

  it("TELEGRAM_DRY_RUN=true never calls the network, and still writes an alerts row with send_status='dry_run'", async () => {
    process.env.TELEGRAM_DRY_RUN = "true";
    const telegram = fakeTelegram(async () => {});
    await new NotifyService(db, telegram).notifyAlert(ctx());

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ruleId: null, userId, address: ADDRESS, coin: "BTC", sendStatus: "dry_run" });
    expect(rows[0].sentAt).not.toBeNull();
    expect(await db.select().from(notificationOutbox)).toMatchObject([{ actionId: actionRow.id, userId, status: "dry_run" }]);
    expect(readAlertDisplayValues(JSON.parse(JSON.stringify(rows[0].payloadJson)))).toEqual({ actionKind: "open", notionalUsd: "60000" });
    expect(JSON.parse(JSON.stringify(rows[0].payloadJson))).toMatchObject({ version: 1, values: { actionKind: "open", notionalUsd: "60000" } });
  });

  it("waits for Telegram retry_after instead of retrying early", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(new TelegramApiError("sendMessage", 429, "rate limited", 10)).mockResolvedValue(undefined);
    const service = new NotifyService(db, fakeTelegram(send));
    try {
      const pending = service.sendSystemMessage("test retry");
      await vi.advanceTimersByTimeAsync(9999);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(send).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("a favorite alert goes to the recipient's own chat in their language: one row, no rule", async () => {
    const telegram = fakeTelegram(async () => {});
    await new NotifyService(db, telegram).notifyAlert(
      ctx({ recipient: { userId, telegramChatId: "chat-user", locale: "en" } }),
    );

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chat, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(chat).toBe("chat-user");
    expect(text).toContain("🟢 Buy · Open long BTC");
    expect(text).toContain("Whale");
    expect(text).toContain(`/trader/${ADDRESS}`);
    const [row] = await db.select().from(alerts);
    expect(row).toMatchObject({ sendStatus: "sent", userId, ruleId: null });
    expect(row.payloadJson).toMatchObject({ chatId: "chat-user", locale: "en", reasons: { favorite: true, rules: [] } });
  });

  it("an admin's rule alert: one message, one row per matched rule, rules named in the message", async () => {
    const [r1, r3] = [await defaultRule("R1"), await defaultRule("R3")];
    const telegram = fakeTelegram(async () => {});
    await new NotifyService(db, telegram).notifyAlert(ctx({ rules: [r1, r3], favorite: true }));

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("chat-user", expect.stringContaining("規則 R1+R3"));
    const rows = await db.select().from(alerts);
    expect(rows.map((r) => r.ruleId).sort()).toEqual([r1.id, r3.id].sort());
    expect(rows.every((r) => r.sendStatus === "sent")).toBe(true);
    expect(rows[0].payloadJson).toMatchObject({ reasons: { favorite: true, rules: ["R1", "R3"] } });
  });

  it("a recipient with no Telegram channel gets a 'failed' row with the reason, and nothing is sent", async () => {
    const telegram = fakeTelegram(async () => {});
    await new NotifyService(db, telegram).notifyAlert(
      ctx({ recipient: { userId, telegramChatId: null, locale: "zh-TW" } }),
    );

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    const [row] = await db.select().from(alerts);
    expect(row).toMatchObject({ sendStatus: "failed", userId });
    expect(row.payloadJson).toMatchObject({ reason: "no enabled Telegram channel" });
  });

  it("N4: retries a failing send up to 3 times (4 attempts) then records 'failed' without throwing", async () => {
    const telegram = fakeTelegram(async () => {
      throw new Error("network down");
    });
    const start = Date.now();
    await expect(new NotifyService(db, telegram).notifyAlert(ctx())).resolves.toBeUndefined();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(4);
    // backoff schedule is 1s/2s/4s between attempts = 7s minimum.
    expect(Date.now() - start).toBeGreaterThanOrEqual(6900);
    const [row] = await db.select().from(alerts);
    expect(row.sendStatus).toBe("failed");
  }, 15_000);

  it("a permanent Telegram error (bot blocked) is not retried", async () => {
    const telegram = fakeTelegram(async () => {
      throw new TelegramApiError("sendMessage", 403, "Forbidden: bot was blocked by the user");
    });
    await new NotifyService(db, telegram).notifyAlert(ctx());

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(alerts);
    expect(row.sendStatus).toBe("failed");
  });

  it("test messages honor dry run and report the outcome", async () => {
    const telegram = fakeTelegram(async () => {});
    const service = new NotifyService(db, telegram);
    expect(await service.sendTestMessage("chat-user", "en")).toEqual({ sent: true, dryRun: false });
    expect(telegram.sendMessage).toHaveBeenCalledWith("chat-user", expect.stringContaining("Orbie test message"));

    process.env.TELEGRAM_DRY_RUN = "true";
    expect(await service.sendTestMessage("chat-user", "zh-TW")).toEqual({ sent: false, dryRun: true });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(await db.select().from(alerts)).toHaveLength(0);
  });

  it("system messages still go to TELEGRAM_SYSTEM_CHAT_ID", async () => {
    const telegram = fakeTelegram(async () => {});
    await new NotifyService(db, telegram).sendSystemMessage("feed down");

    expect(telegram.sendMessage).toHaveBeenCalledWith("chat-system", "feed down");
    expect(await db.select().from(alerts)).toHaveLength(0);
  });
});
