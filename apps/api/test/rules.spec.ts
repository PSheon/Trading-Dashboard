import {
  actions,
  alertRules,
  alerts,
  leaders,
  notificationChannels,
  userFavorites,
  users,
  type LeaderSource,
} from "@trading-dashboard/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoundTripService } from "../src/analytics/round-trip.service.js";
import { AuthService } from "../src/common/auth/auth.service.js";
import type { PrivyVerifier } from "../src/common/auth/privy-verifier.js";
import { NotifyService, type RulesFireContext } from "../src/notify/notify.service.js";
import type { TelegramHttpClient } from "../src/notify/telegram-http.client.js";
import { RulesService } from "../src/rules/rules.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import { SettingsService } from "../src/settings/settings.service.js";
import type { WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const CHAIN = "hyperliquid";
const ADDRESS = "0xrulestest";

let nextActionId = 1n;
function actionRow(overrides: {
  kind?: "open" | "add" | "reduce" | "close" | "flip" | "liquidation";
  side?: "long" | "short";
  coin?: string;
  notionalUsd?: string;
  ts?: Date;
} = {}) {
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
    ts: overrides.ts ?? new Date(),
  };
}

function fakeWatcher(equityUsd: number | null): WatcherService {
  return { getEquityUsd: vi.fn().mockReturnValue(equityUsd) } as unknown as WatcherService;
}

function fakeNotify() {
  const notifyRulesFire = vi.fn(async (_ctx: RulesFireContext) => {});
  return { notify: { notifyRulesFire } as unknown as NotifyService, notifyRulesFire };
}

/** Kinds per recipient user id, from the notifyRulesFire calls. */
function callsByUser(mock: ReturnType<typeof fakeNotify>["notifyRulesFire"]): Map<number, string[]> {
  return new Map(
    mock.mock.calls.map(([ctx]) => [ctx.recipient.userId, ctx.rules.map((r) => r.kind).sort()]),
  );
}

const db = getTestDb();
const noProfile: PrivyVerifier = {
  verifyAccessToken: async () => {
    throw new Error("unused");
  },
  fetchProfile: async () => null,
};
const settings = new SettingsService(db);
const auth = new AuthService(db, noProfile, settings);
let didSeq = 0;

/** A user signed in through the real first-login path (so they own a copy
 * of the default rules), optionally an admin, favoriting ADDRESS, with a
 * Telegram channel. */
async function signedInUser(opts: { admin?: boolean; favorite?: boolean; chatId?: string } = {}) {
  const result = await auth.signIn(`did:privy:rules-${++didSeq}`);
  if (result.status !== "ok") throw new Error(`sign-in failed: ${result.status}`);
  const user = result.user;
  if (opts.admin) await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
  if (opts.favorite ?? true) await db.insert(userFavorites).values({ userId: user.id, chain: CHAIN, address: ADDRESS });
  if (opts.chatId) {
    await db.insert(notificationChannels).values({ userId: user.id, kind: "telegram", target: opts.chatId });
  }
  return user;
}

async function ruleOf(userId: number, kind: "R1" | "R2" | "R3") {
  const [row] = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.userId, userId), eq(alertRules.kind, kind)));
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
  await new RulesSeedService(db).seedDefaultRules();
}

describe("RulesService — rule semantics, evaluated on a favoriting user's own rules", () => {
  let userId: number;

  beforeEach(async () => {
    await resetWithLeader();
    userId = (await signedInUser()).id;
  });

  it("R1 fires on an 'open' whose notional meets min(flatThresholdUsd, equity*pct) — seeded flat=50000, pct=0.10", async () => {
    const { notify, notifyRulesFire } = fakeNotify();
    // equity=1,000,000 -> pct branch = 100,000 > flat 50,000 -> min is 50,000.
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "49999" }));
    expect(notifyRulesFire).not.toHaveBeenCalled();

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "50000" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(1);
    const ctx = notifyRulesFire.mock.calls[0][0];
    expect(ctx.rules.map((r) => r.kind)).toEqual(["R1"]);
    expect(ctx.rules[0].userId).toBe(userId);
    expect(ctx.recipient).toEqual({ userId, telegramChatId: null });
  });

  it("R1's equity% branch can be lower than the flat threshold — min(X,Y) semantics, not just X", async () => {
    const { notify, notifyRulesFire } = fakeNotify();
    // equity=100,000 -> pct branch = 10,000, well under flat 50,000 -> min is 10,000.
    const rules = new RulesService(db, fakeWatcher(100_000), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "9999" }));
    expect(notifyRulesFire).not.toHaveBeenCalled();

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "10000" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(1);
  });

  it("R2 fires on any 'flip' regardless of size, and only on 'flip'", async () => {
    const { notify, notifyRulesFire } = fakeNotify();
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "1" }));
    expect(notifyRulesFire).not.toHaveBeenCalled();

    await rules.evaluateAction(await insertAction({ kind: "flip", notionalUsd: "1" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(1);
    expect(notifyRulesFire.mock.calls[0][0].rules.map((r) => r.kind)).toEqual(["R2"]);
  });

  it("R3 fires on ANY action kind once notional meets min(flatThresholdUsd, equity*pct) — seeded flat=100000, pct=0.20", async () => {
    const { notify, notifyRulesFire } = fakeNotify();
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "reduce", notionalUsd: "99999" }));
    expect(notifyRulesFire).not.toHaveBeenCalled();

    await rules.evaluateAction(await insertAction({ kind: "reduce", notionalUsd: "100000" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(1);
  });

  it("sends ONE combined message per recipient when R1 and R3 both match the same 'open'", async () => {
    const { notify, notifyRulesFire } = fakeNotify();
    const rules = new RulesService(db, fakeWatcher(10_000_000), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "150000" }));

    expect(notifyRulesFire).toHaveBeenCalledTimes(1);
    expect(notifyRulesFire.mock.calls[0][0].rules.map((r) => r.kind).sort()).toEqual(["R1", "R3"]);
  });

  it("falls back to the flat threshold alone when equityUsd is unavailable (no cached poll state yet)", async () => {
    const { notify, notifyRulesFire } = fakeNotify();
    const rules = new RulesService(db, fakeWatcher(null), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "49999" }));
    expect(notifyRulesFire).not.toHaveBeenCalled();

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "50000" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(1);
  });

  it("does not fire a rule scoped to tiers that exclude this leader's current tier", async () => {
    await db.update(alertRules).set({ tiers: ["A"] }).where(eq(alertRules.id, (await ruleOf(userId, "R2")).id));
    const { notify, notifyRulesFire } = fakeNotify();
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "flip" }));
    expect(notifyRulesFire).not.toHaveBeenCalled();
  });

  it("does not fire a disabled rule", async () => {
    await db.update(alertRules).set({ enabled: false }).where(eq(alertRules.id, (await ruleOf(userId, "R2")).id));
    const { notify, notifyRulesFire } = fakeNotify();
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "flip" }));
    expect(notifyRulesFire).not.toHaveBeenCalled();
  });

  it("never evaluates the default (ownerless) rules themselves", async () => {
    await db.delete(userFavorites);
    const { notify, notifyRulesFire } = fakeNotify();
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify, settings);

    // Imported leader, no favoriters, no admins: nobody to notify.
    await rules.evaluateAction(await insertAction({ kind: "flip" }));
    expect(notifyRulesFire).not.toHaveBeenCalled();
    expect(await db.select().from(alerts)).toHaveLength(0);
  });

  it("suppresses a re-fire within the same rule/address/coin's cooldown window, and allows it again after cooldown expires", async () => {
    const r1 = await ruleOf(userId, "R1");
    await db.update(alertRules).set({ cooldownS: 1 }).where(eq(alertRules.id, r1.id));

    const { notify, notifyRulesFire } = fakeNotify();
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify, settings);

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "60000" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(1);

    // Simulate N2 having logged the resulting alert (cooldown reads
    // `alerts.sent_at`, not in-memory state).
    await db.insert(alerts).values({
      ruleId: r1.id,
      userId,
      chain: CHAIN,
      address: ADDRESS,
      coin: "BTC",
      payloadJson: {},
      sentAt: new Date(),
      sendStatus: "dry_run",
    });

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "60000" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(1);

    // Another coin isn't in cooldown.
    await rules.evaluateAction(await insertAction({ kind: "open", coin: "ETH", notionalUsd: "60000" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "60000" }));
    expect(notifyRulesFire).toHaveBeenCalledTimes(3);
  }, 10_000);
});

describe("RulesService — recipients, per-user cooldown and channel routing", () => {
  it("imported leader: favoriters plus every admin; non-favoriting users are not notified", async () => {
    await resetWithLeader("import");
    const favoriter = await signedInUser({ chatId: "111" });
    const admin = await signedInUser({ admin: true, favorite: false, chatId: "999" });
    await signedInUser({ favorite: false }); // bystander

    const { notify, notifyRulesFire } = fakeNotify();
    await new RulesService(db, fakeWatcher(1_000_000), notify, settings).evaluateAction(await insertAction({ kind: "flip" }));

    const byUser = callsByUser(notifyRulesFire);
    expect([...byUser.keys()].sort()).toEqual([favoriter.id, admin.id].sort());
    const chats = new Map(notifyRulesFire.mock.calls.map(([ctx]) => [ctx.recipient.userId, ctx.recipient.telegramChatId]));
    expect(chats.get(favoriter.id)).toBe("111");
    expect(chats.get(admin.id)).toBe("999");
  });

  it("favorite-sourced leader: only its favoriters, not admins", async () => {
    await resetWithLeader("favorite");
    const favoriter = await signedInUser();
    await signedInUser({ admin: true, favorite: false });

    const { notify, notifyRulesFire } = fakeNotify();
    await new RulesService(db, fakeWatcher(1_000_000), notify, settings).evaluateAction(await insertAction({ kind: "flip" }));

    expect([...callsByUser(notifyRulesFire).keys()]).toEqual([favoriter.id]);
  });

  it("an admin who also favorites gets one message, not two", async () => {
    await resetWithLeader("import");
    const admin = await signedInUser({ admin: true });

    const { notify, notifyRulesFire } = fakeNotify();
    await new RulesService(db, fakeWatcher(1_000_000), notify, settings).evaluateAction(await insertAction({ kind: "flip" }));

    expect(notifyRulesFire).toHaveBeenCalledTimes(1);
    expect(notifyRulesFire.mock.calls[0][0].recipient.userId).toBe(admin.id);
  });

  it("each user's own rules decide: one user's disabled rule doesn't affect another", async () => {
    await resetWithLeader();
    const a = await signedInUser();
    const b = await signedInUser();
    await db.update(alertRules).set({ enabled: false }).where(eq(alertRules.id, (await ruleOf(a.id, "R2")).id));

    const { notify, notifyRulesFire } = fakeNotify();
    await new RulesService(db, fakeWatcher(1_000_000), notify, settings).evaluateAction(await insertAction({ kind: "flip" }));

    expect([...callsByUser(notifyRulesFire).keys()]).toEqual([b.id]);
  });

  it("cooldown is per user: A's recent alert doesn't silence B", async () => {
    await resetWithLeader();
    const a = await signedInUser();
    const b = await signedInUser();
    await db.insert(alerts).values({
      ruleId: (await ruleOf(a.id, "R2")).id,
      userId: a.id,
      chain: CHAIN,
      address: ADDRESS,
      coin: "BTC",
      payloadJson: {},
      sentAt: new Date(),
      sendStatus: "sent",
    });

    const { notify, notifyRulesFire } = fakeNotify();
    await new RulesService(db, fakeWatcher(1_000_000), notify, settings).evaluateAction(await insertAction({ kind: "flip" }));

    expect([...callsByUser(notifyRulesFire).keys()]).toEqual([b.id]);
  });

  it("a disabled channel counts as no channel", async () => {
    await resetWithLeader();
    const user = await signedInUser({ chatId: "111" });
    await db.update(notificationChannels).set({ enabled: false });

    const { notify, notifyRulesFire } = fakeNotify();
    await new RulesService(db, fakeWatcher(1_000_000), notify, settings).evaluateAction(await insertAction({ kind: "flip" }));

    expect(notifyRulesFire.mock.calls[0][0].recipient).toEqual({ userId: user.id, telegramChatId: null });
  });
});

describe("RulesService + NotifyService — real sends routed per user (mocked Telegram)", () => {
  beforeEach(() => {
    process.env.TELEGRAM_DRY_RUN = "false";
    process.env.TELEGRAM_SYSTEM_CHAT_ID = "env-chat";
  });
  afterEach(() => {
    delete process.env.TELEGRAM_DRY_RUN;
    delete process.env.TELEGRAM_SYSTEM_CHAT_ID;
  });

  it("sends each user's message to their own chat; a user without a channel gets a 'failed' row saying why", async () => {
    await resetWithLeader();
    const withChannel = await signedInUser({ chatId: "111" });
    const withoutChannel = await signedInUser();

    const telegram = { sendMessage: vi.fn(async () => {}) } as unknown as TelegramHttpClient;
    const notify = new NotifyService(db, new RoundTripService(db), telegram);
    const rules = new RulesService(db, fakeWatcher(10_000_000), notify, settings);

    // R1 + R3 both match: one message per recipient, one row per rule.
    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "150000" }));

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("111", expect.stringContaining("R1+R3"));

    const rows = await db.select().from(alerts);
    const sent = rows.filter((r) => r.userId === withChannel.id);
    const failed = rows.filter((r) => r.userId === withoutChannel.id);
    expect(sent).toHaveLength(2);
    expect(sent.every((r) => r.sendStatus === "sent")).toBe(true);
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.sendStatus === "failed")).toBe(true);
    expect(failed[0].payloadJson).toMatchObject({ reason: "no enabled Telegram channel" });
    // Rows reference each user's own rule copies.
    expect(new Set(sent.map((r) => r.ruleId))).toEqual(
      new Set([(await ruleOf(withChannel.id, "R1")).id, (await ruleOf(withChannel.id, "R3")).id]),
    );
  });

  it("alert kill switch (notifications.alertsEnabled=false): no sends, no alert rows; system messages still go out", async () => {
    await resetWithLeader();
    await signedInUser({ chatId: "111" });
    await signedInUser();

    const telegram = { sendMessage: vi.fn(async () => {}) } as unknown as TelegramHttpClient;
    const notify = new NotifyService(db, new RoundTripService(db), telegram);
    const rules = new RulesService(db, fakeWatcher(10_000_000), notify, settings);

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

    // Switched back on: the next action alerts again.
    await rules.evaluateAction(await insertAction({ kind: "open", notionalUsd: "150000" }));
    expect(telegram.sendMessage).toHaveBeenCalledWith("111", expect.any(String));
    expect(await db.select().from(alerts)).toHaveLength(4);
  });
});

describe("RulesSeedService — real Postgres", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("seeds R1/R2/R3 with the documented defaults", async () => {
    await new RulesSeedService(db).seedDefaultRules();
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

    const r3 = rows.find((r) => r.kind === "R3")!;
    expect(r3.paramsJson).toEqual({ flatThresholdUsd: 100_000, pctThreshold: 0.2 });
  });

  it("is idempotent — running it again never duplicates rows or clobbers edited params", async () => {
    const seed = new RulesSeedService(db);
    await seed.seedDefaultRules();

    await db.update(alertRules).set({ cooldownS: 1234 }).where(eq(alertRules.kind, "R1"));

    await seed.seedDefaultRules();
    const rows = await db.select().from(alertRules);
    expect(rows).toHaveLength(3);
    const r1 = rows.find((r) => r.kind === "R1")!;
    expect(r1.cooldownS).toBe(1234);
  });
});
