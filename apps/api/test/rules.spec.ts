import { testConfig } from "./config-test-utils.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import {
  actions,
  alertRules,
  alerts,
  leaders,
  notificationChannels,
  traderStats,
  userFavorites,
  users,
} from "@trading-dashboard/shared/database";
import { type AlertSides, type LeaderSource } from "@trading-dashboard/shared/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotifyService, type AlertContext } from "../src/notify/notify.service.js";
import type { TelegramHttpClient } from "../src/notify/telegram-http.client.js";
import { FAVORITE_BURST_GUARD_MS, RulesService } from "../src/rules/rules.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import { SettingsService } from "../src/settings/settings.service.js";
import type { WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const CHAIN = "hyperliquid";
const ADDRESS = "0x" + "12".repeat(20);

let nextActionId = 1n;
function actionRow(
  overrides: {
    kind?: "open" | "add" | "reduce" | "close" | "flip" | "liquidation";
    side?: "long" | "short";
    coin?: string;
    notionalUsd?: string;
  } = {},
) {
  return {
    chain: CHAIN,
    address: ADDRESS,
    coin: overrides.coin ?? "BTC",
    kind: overrides.kind ?? "open",
    side: overrides.side ?? "long",
    notionalUsd: overrides.notionalUsd ?? "10000",
    avgPx: "60000",
    leverage: "5",
    fillIds: [nextActionId++],
    ts: new Date(),
  };
}

function fakeWatcher(equityUsd: number | null): WatcherService {
  return { getEquityUsd: vi.fn().mockReturnValue(equityUsd) } as unknown as WatcherService;
}

function fakeNotify() {
  const notifyAlert = vi.fn(async (_ctx: AlertContext) => {});
  return { notify: { notifyAlert, deliverAction: async () => {} } as unknown as NotifyService, notifyAlert };
}

type NotifyMock = ReturnType<typeof fakeNotify>["notifyAlert"];

/** Per recipient: favorite flag and the rule kinds, from the notifyAlert calls. */
function byUser(mock: NotifyMock): Map<number, { favorite: boolean; rules: string[] }> {
  return new Map(
    mock.mock.calls.map(([ctx]) => [
      ctx.recipient.userId,
      { favorite: ctx.favorite, rules: ctx.rules.map((r) => r.kind).sort() },
    ]),
  );
}

const db = getTestDb();
const settings = new SettingsService(new SettingsRepository(db), new UnitOfWork(db));

/** A user, optionally an admin, with an optional alert on ADDRESS and a
 * linked Telegram chat. */
async function user(
  opts: {
    admin?: boolean;
    alert?: { sides?: AlertSides; minUsd?: number | null; enabled?: boolean };
    favorite?: boolean;
    chatId?: string;
    locale?: "zh-TW" | "en";
  } = {},
) {
  const row = await insertUser(db, { role: opts.admin ? "admin" : "user", locale: opts.locale ?? "zh-TW" });
  if (opts.alert || opts.favorite) {
    await db.insert(userFavorites).values({
      userId: row.id,
      chain: CHAIN,
      address: ADDRESS,
      alertEnabled: opts.alert ? (opts.alert.enabled ?? true) : false,
      alertSides: opts.alert?.sides ?? "both",
      alertMinUsd: opts.alert?.minUsd == null ? null : String(opts.alert.minUsd),
    });
  }
  if (opts.chatId) {
    await db.insert(notificationChannels).values({ userId: row.id, kind: "telegram", target: opts.chatId });
  }
  return row;
}

async function defaultRule(kind: "R1" | "R2" | "R3") {
  const [row] = await db
    .select()
    .from(alertRules)
    .where(and(isNull(alertRules.userId), eq(alertRules.kind, kind)));
  return row;
}

async function insertAction(overrides: Parameters<typeof actionRow>[0] = {}) {
  const [row] = await db.insert(actions).values(actionRow(overrides)).returning();
  return row;
}

async function resetWithLeader(source: LeaderSource = "import") {
  await truncateAll(db);
  nextActionId = 1n;
  await db.insert(leaders).values({ chain: CHAIN, address: ADDRESS, active: true, tier: "B", source });
  await new RulesSeedService(testConfig(), db).seedDefaultRules();
}

function rulesWith(notify: NotifyService, equity: number | null = 1_000_000) {
  return new RulesService(db, fakeWatcher(equity), notify, settings);
}

afterAll(async () => {
  await closeTestDb();
});

describe("RulesService — favorite alerts (CopyDog-style)", () => {
  beforeEach(async () => {
    await resetWithLeader("favorite");
  });

  it("only users with an alert switched on are notified; plain favorites and bystanders are not", async () => {
    const alerting = await user({ alert: {}, chatId: "111" });
    await user({ favorite: true, chatId: "222" }); // favorite, alert off
    await user({ alert: { enabled: false } });
    await user(); // bystander

    const { notify, notifyAlert } = fakeNotify();
    await rulesWith(notify).evaluateAction(await insertAction());

    expect(notifyAlert).toHaveBeenCalledTimes(1);
    const ctx = notifyAlert.mock.calls[0][0];
    expect(ctx).toMatchObject({ favorite: true, rules: [] });
    expect(ctx.recipient).toEqual({ userId: alerting.id, telegramChatId: "111", locale: "zh-TW" });
  });

  it("filters by side: buy = B-side actions (open/add long, cover a short), sell = A-side", async () => {
    const buyer = await user({ alert: { sides: "buy" } });
    const seller = await user({ alert: { sides: "sell" } });
    const both = await user({ alert: { sides: "both" } });
    const rules = rulesWith(fakeNotify().notify);

    const cases: [Parameters<typeof actionRow>[0], number[]][] = [
      [{ kind: "open", side: "long" }, [buyer.id, both.id]],
      [{ kind: "close", side: "short", coin: "ETH" }, [buyer.id, both.id]],
      [{ kind: "flip", side: "long", coin: "SOL" }, [buyer.id, both.id]],
      [{ kind: "open", side: "short", coin: "HYPE" }, [seller.id, both.id]],
      [{ kind: "reduce", side: "long", coin: "DOGE" }, [seller.id, both.id]],
      [{ kind: "liquidation", side: "long", coin: "XRP" }, [seller.id, both.id]],
    ];
    for (const [action, expected] of cases) {
      const { notify, notifyAlert } = fakeNotify();
      Object.assign(rules, { notify });
      await rules.evaluateAction(await insertAction(action));
      expect([...byUser(notifyAlert).keys()].sort(), JSON.stringify(action)).toEqual(expected.sort());
    }
  });

  it("filters by minimum notional; null means any size", async () => {
    const big = await user({ alert: { minUsd: 100_000 } });
    const any = await user({ alert: { minUsd: null } });

    const { notify, notifyAlert } = fakeNotify();
    const rules = rulesWith(notify);
    await rules.evaluateAction(await insertAction({ notionalUsd: "99999.99" }));
    expect([...byUser(notifyAlert).keys()]).toEqual([any.id]);

    notifyAlert.mockClear();
    await rules.evaluateAction(await insertAction({ notionalUsd: "100000", coin: "ETH" }));
    expect([...byUser(notifyAlert).keys()].sort()).toEqual([big.id, any.id].sort());
  });

  it("burst guard: one alert per (user, trader, coin) within ~10 s; another coin or user is unaffected", async () => {
    const a = await user({ alert: {} });
    const { notify, notifyAlert } = fakeNotify();
    const rules = rulesWith(notify);

    await rules.evaluateAction(await insertAction());
    await rules.evaluateAction(await insertAction({ kind: "add" }));
    expect(notifyAlert).toHaveBeenCalledTimes(1);

    await rules.evaluateAction(await insertAction({ coin: "ETH" }));
    expect(notifyAlert).toHaveBeenCalledTimes(2);

    const b = await user({ alert: {} });
    await rules.evaluateAction(await insertAction({ kind: "reduce" }));
    expect(notifyAlert.mock.calls[2][0].recipient.userId).toBe(b.id);
    expect(notifyAlert).toHaveBeenCalledTimes(3);

    // After the window, `a` hears about BTC again.
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + FAVORITE_BURST_GUARD_MS + 1);
    try {
      await rules.evaluateAction(await insertAction({ kind: "close" }));
    } finally {
      spy.mockRestore();
    }
    expect(byUser(notifyAlert).has(a.id)).toBe(true);
    expect(notifyAlert).toHaveBeenCalledTimes(5);
  });

  it("concurrent evaluations of two actions on the same coin alert once", async () => {
    await user({ alert: {} });
    const { notify, notifyAlert } = fakeNotify();
    const rules = rulesWith(notify);
    const [x, y] = [await insertAction(), await insertAction({ kind: "add" })];
    await Promise.all([rules.evaluateAction(x), rules.evaluateAction(y)]);
    expect(notifyAlert).toHaveBeenCalledTimes(1);
  });

  it("a disabled user gets nothing; recipients carry their locale and trader name", async () => {
    const off = await user({ alert: {} });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, off.id));
    const en = await user({ alert: {}, locale: "en" });
    await db.insert(traderStats).values({
      address: ADDRESS,
      displayName: "LeaderboardName",
      accountValue: "1",
      pnlDay: "0",
      pnlWeek: "0",
      pnlMonth: "0",
      pnlAllTime: "0",
      roiDay: "0",
      roiWeek: "0",
      roiMonth: "0",
      roiAllTime: "0",
      volumeDay: "0",
      volumeWeek: "0",
      volumeMonth: "0",
      volumeAllTime: "0",
      updatedAt: new Date(),
    });

    const { notify, notifyAlert } = fakeNotify();
    await rulesWith(notify).evaluateAction(await insertAction());
    expect(notifyAlert).toHaveBeenCalledTimes(1);
    expect(notifyAlert.mock.calls[0][0]).toMatchObject({
      traderName: "LeaderboardName",
      recipient: { userId: en.id, locale: "en", telegramChatId: null },
    });
  });

  it("favorite-sourced leader: admins get nothing from the default rules", async () => {
    await user({ admin: true, chatId: "999" });
    const { notify, notifyAlert } = fakeNotify();
    await rulesWith(notify).evaluateAction(await insertAction({ kind: "flip" }));
    expect(notifyAlert).not.toHaveBeenCalled();
  });
});

describe("RulesService — admins on imported leaders: the default rules, as before", () => {
  let adminId: number;

  beforeEach(async () => {
    await resetWithLeader("import");
    adminId = (await user({ admin: true, chatId: "999" })).id;
  });

  it("R1 fires on an 'open' whose notional meets min(flatThresholdUsd, equity*pct) — seeded flat=50000, pct=0.10", async () => {
    const { notify, notifyAlert } = fakeNotify();
    const rules = rulesWith(notify, 1_000_000);

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "49999" }));
    expect(notifyAlert).not.toHaveBeenCalled();

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "50000" }));
    expect(notifyAlert).toHaveBeenCalledTimes(1);
    const ctx = notifyAlert.mock.calls[0][0];
    expect(ctx.rules.map((r) => r.kind)).toEqual(["R1"]);
    expect(ctx.rules[0].userId).toBeNull(); // the default itself, no copy
    expect(ctx).toMatchObject({ favorite: false, recipient: { userId: adminId, telegramChatId: "999" } });
  });

  it("R1's equity% branch can be lower than the flat threshold", async () => {
    const { notify, notifyAlert } = fakeNotify();
    const rules = rulesWith(notify, 100_000);
    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "9999" }));
    expect(notifyAlert).not.toHaveBeenCalled();
    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "10000" }));
    expect(notifyAlert).toHaveBeenCalledTimes(1);
  });

  it("R2 fires on any 'flip' regardless of size; R3 on any kind over its threshold", async () => {
    const { notify, notifyAlert } = fakeNotify();
    const rules = rulesWith(notify, 1_000_000);

    await rules.evaluateAction(await insertAction({ kind: "flip", notionalUsd: "1" }));
    expect(notifyAlert.mock.calls[0][0].rules.map((r) => r.kind)).toEqual(["R2"]);

    await rules.evaluateAction(await insertAction({ kind: "reduce", notionalUsd: "99999", coin: "ETH" }));
    expect(notifyAlert).toHaveBeenCalledTimes(1);
    await rules.evaluateAction(await insertAction({ kind: "reduce", notionalUsd: "100000", coin: "ETH" }));
    expect(notifyAlert.mock.calls[1][0].rules.map((r) => r.kind)).toEqual(["R3"]);
  });

  it("R1 and R3 on the same 'open': one message; flat threshold alone without equity", async () => {
    const { notify, notifyAlert } = fakeNotify();
    await rulesWith(notify, null).evaluateAction(await insertAction({ kind: "open", notionalUsd: "150000" }));
    expect(notifyAlert).toHaveBeenCalledTimes(1);
    expect(notifyAlert.mock.calls[0][0].rules.map((r) => r.kind).sort()).toEqual(["R1", "R3"]);
  });

  it("tiers and the enabled flag of the default rule apply", async () => {
    await db.update(alertRules).set({ tiers: ["A"] }).where(eq(alertRules.id, (await defaultRule("R2")).id));
    const { notify, notifyAlert } = fakeNotify();
    const rules = rulesWith(notify);
    await rules.evaluateAction(await insertAction({ kind: "flip" }));
    expect(notifyAlert).not.toHaveBeenCalled();

    await db.update(alertRules).set({ tiers: ["B"], enabled: false }).where(eq(alertRules.kind, "R2"));
    await rules.evaluateAction(await insertAction({ kind: "flip" }));
    expect(notifyAlert).not.toHaveBeenCalled();
  });

  it("every admin is a recipient; the cooldown is per admin, rule, address and coin", async () => {
    const other = await user({ admin: true });
    const r2 = await defaultRule("R2");
    await db.insert(alerts).values({
      ruleId: r2.id,
      userId: adminId,
      chain: CHAIN,
      address: ADDRESS,
      coin: "BTC",
      payloadJson: {},
      sentAt: new Date(),
      sendStatus: "sent",
    });

    const { notify, notifyAlert } = fakeNotify();
    const rules = rulesWith(notify);
    await rules.evaluateAction(await insertAction({ kind: "flip" }));
    expect([...byUser(notifyAlert).keys()]).toEqual([other.id]); // adminId is cooling down

    await rules.evaluateAction(await insertAction({ kind: "flip", coin: "ETH" }));
    expect([...byUser(notifyAlert).keys()].sort()).toEqual([adminId, other.id].sort());

    await db.update(alertRules).set({ cooldownS: 0 }).where(eq(alertRules.id, r2.id));
    notifyAlert.mockClear();
    await rules.evaluateAction(await insertAction({ kind: "flip" }));
    expect(byUser(notifyAlert).has(adminId)).toBe(true);
  });

  it("an admin who also has a favorite alert gets one message carrying both reasons", async () => {
    const admin2 = await user({ admin: true, alert: { sides: "both" }, chatId: "777" });
    const fan = await user({ alert: {} });

    const { notify, notifyAlert } = fakeNotify();
    await rulesWith(notify).evaluateAction(await insertAction({ kind: "flip" }));

    expect(notifyAlert).toHaveBeenCalledTimes(3);
    const calls = byUser(notifyAlert);
    expect(calls.get(admin2.id)).toEqual({ favorite: true, rules: ["R2"] });
    expect(calls.get(adminId)).toEqual({ favorite: false, rules: ["R2"] });
    expect(calls.get(fan.id)).toEqual({ favorite: true, rules: [] });
  });

  it("an admin's favorite alert still fires when no rule does", async () => {
    await db.delete(users).where(eq(users.id, adminId));
    const admin2 = await user({ admin: true, alert: { minUsd: 5 } });
    const { notify, notifyAlert } = fakeNotify();
    await rulesWith(notify).evaluateAction(await insertAction({ kind: "add", notionalUsd: "10" }));
    expect(byUser(notifyAlert).get(admin2.id)).toEqual({ favorite: true, rules: [] });
  });
});

describe("RulesService + NotifyService — real sends (mocked Telegram)", () => {
  beforeEach(async () => {
    await resetWithLeader("import");
    process.env.TELEGRAM_DRY_RUN = "false";
    process.env.TELEGRAM_SYSTEM_CHAT_ID = "env-chat";
  });
  afterEach(() => {
    delete process.env.TELEGRAM_DRY_RUN;
    delete process.env.TELEGRAM_SYSTEM_CHAT_ID;
  });

  function realNotify() {
    const telegram = { sendMessage: vi.fn(async () => {}) } as unknown as TelegramHttpClient;
    return { telegram, notify: new NotifyService(testConfig(), db, telegram) };
  }

  it("each recipient's message goes to their own chat; no linked chat → a 'failed' row saying why", async () => {
    const linked = await user({ alert: {}, chatId: "111", locale: "en" });
    const unlinked = await user({ alert: {} });
    const admin = await user({ admin: true, alert: {}, chatId: "999" });

    const { telegram, notify } = realNotify();
    await rulesWith(notify, 10_000_000).evaluateAction(await insertAction({ kind: "open", notionalUsd: "150000" }));

    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.sendMessage).toHaveBeenCalledWith("111", expect.stringContaining("🟢 Buy · Open long BTC"));
    expect(telegram.sendMessage).toHaveBeenCalledWith("999", expect.stringContaining("規則 R1+R3"));

    const rows = await db.select().from(alerts);
    const of = (id: number) => rows.filter((r) => r.userId === id);
    expect(of(linked.id)).toMatchObject([{ sendStatus: "sent", ruleId: null }]);
    expect(of(unlinked.id)).toMatchObject([{ sendStatus: "failed", ruleId: null }]);
    expect(of(unlinked.id)[0].payloadJson).toMatchObject({ reason: "no enabled Telegram channel" });
    // The admin: one message, one row per matched default rule.
    expect(of(admin.id).map((r) => r.ruleId).sort()).toEqual(
      [(await defaultRule("R1")).id, (await defaultRule("R3")).id].sort(),
    );
    expect(of(admin.id).every((r) => r.sendStatus === "sent")).toBe(true);
  });

  it("a paused (disabled) channel counts as none", async () => {
    await user({ alert: {}, chatId: "111" });
    await db.update(notificationChannels).set({ enabled: false });
    const { telegram, notify } = realNotify();
    await rulesWith(notify).evaluateAction(await insertAction());
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect((await db.select().from(alerts))[0].sendStatus).toBe("failed");
  });

  it("TELEGRAM_DRY_RUN: nothing is sent, every recipient gets a 'dry_run' row", async () => {
    process.env.TELEGRAM_DRY_RUN = "true";
    await user({ alert: {}, chatId: "111" });
    await user({ alert: {} });
    const { telegram, notify } = realNotify();
    await rulesWith(notify).evaluateAction(await insertAction());
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sendStatus === "dry_run")).toBe(true);
  });

  it("alert kill switch (notifications.alertsEnabled=false): no sends, no rows; system messages still go out", async () => {
    await user({ alert: {}, chatId: "111" });
    await user({ admin: true, chatId: "999" });
    const { telegram, notify } = realNotify();
    const rules = rulesWith(notify, 10_000_000);

    await settings.patch({ notifications: { alertsEnabled: false } }, null);
    try {
      await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "150000" }));
      expect(telegram.sendMessage).not.toHaveBeenCalled();
      expect(await db.select().from(alerts)).toHaveLength(0);

      await notify.sendSystemMessage("feed down");
      expect(telegram.sendMessage).toHaveBeenCalledWith("env-chat", "feed down");
    } finally {
      await settings.patch({ notifications: { alertsEnabled: true } }, null);
    }

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "150000", coin: "ETH" }));
    expect(telegram.sendMessage).toHaveBeenCalledWith("111", expect.any(String));
    expect(telegram.sendMessage).toHaveBeenCalledWith("999", expect.any(String));
  });

  it("onActionCreated never rejects, even when evaluation throws", async () => {
    const { notify } = realNotify();
    const rules = rulesWith(notify);
    vi.spyOn(rules, "evaluateAction").mockRejectedValueOnce(new Error("db down"));
    await expect(rules.onActionCreated(await insertAction())).resolves.toBeUndefined();
  });
});

describe("RulesSeedService — real Postgres", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("seeds R1/R2/R3 with the documented defaults", async () => {
    await new RulesSeedService(testConfig(), db).seedDefaultRules();
    const rows = await db.select().from(alertRules);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.userId === null)).toBe(true);

    const r1 = rows.find((r) => r.kind === "R1")!;
    expect(r1).toMatchObject({
      scope: "address",
      cooldownS: 900,
      enabled: true,
      paramsJson: { flatThresholdUsd: 50_000, pctThreshold: 0.1 },
    });
    expect(r1.tiers.sort()).toEqual(["A", "B", "C"]);
    expect(rows.find((r) => r.kind === "R3")!.paramsJson).toEqual({ flatThresholdUsd: 100_000, pctThreshold: 0.2 });
  });

  it("is idempotent — running it again never duplicates rows or clobbers edited params", async () => {
    const seed = new RulesSeedService(testConfig(), db);
    await seed.seedDefaultRules();
    await db.update(alertRules).set({ cooldownS: 1234 }).where(eq(alertRules.kind, "R1"));
    await seed.seedDefaultRules();
    const rows = await db.select().from(alertRules);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.kind === "R1")!.cooldownS).toBe(1234);
  });
});
