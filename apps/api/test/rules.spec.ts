import { actions, alertRules, alerts, leaders } from "@trading-dashboard/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NotifyService } from "../src/notify/notify.service.js";
import { RulesService } from "../src/rules/rules.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
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

describe("RulesService — real Postgres, mocked NotifyService", () => {
  const db = getTestDb();

  beforeEach(async () => {
    await truncateAll(db);
    nextActionId = 1n;
    await db.insert(leaders).values({ chain: CHAIN, address: ADDRESS, active: true, tier: "B" });
    await new RulesSeedService(db).seedDefaultRules();
  });

  // closeTestDb() is called once, from the last describe block in this
  // file — db-test-utils' pool is a module-level singleton shared by every
  // describe in the process, so ending it here would break the
  // RulesSeedService describe below (same file, same pool).

  async function insertAction(overrides: Parameters<typeof actionRow>[0] = {}) {
    const [row] = await db.insert(actions).values(actionRow(overrides)).returning();
    return row;
  }

  it("R1 fires on an 'open' whose notional meets min(flatThresholdUsd, equity*pct) — seeded flat=50000, pct=0.10", async () => {
    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    // equity=1,000,000 -> pct branch = 100,000 > flat 50,000 -> min is 50,000.
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify);

    const belowThreshold = await insertAction({ kind: "open", notionalUsd: "49999" });
    await rules.evaluateAction(belowThreshold);
    expect(notify.notifyRulesFire).not.toHaveBeenCalled();

    const atThreshold = await insertAction({ kind: "open", notionalUsd: "50000" });
    await rules.evaluateAction(atThreshold);
    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(1);
    const call = (notify.notifyRulesFire as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.rules.map((r: { kind: string }) => r.kind)).toEqual(["R1"]);
  });

  it("R1's equity% branch can be lower than the flat threshold — min(X,Y) semantics, not just X", async () => {
    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    // equity=100,000 -> pct branch = 10,000, well under flat 50,000 -> min is 10,000.
    const rules = new RulesService(db, fakeWatcher(100_000), notify);

    const belowEquityPct = await insertAction({ kind: "open", notionalUsd: "9999" });
    await rules.evaluateAction(belowEquityPct);
    expect(notify.notifyRulesFire).not.toHaveBeenCalled();

    const atEquityPct = await insertAction({ kind: "open", notionalUsd: "10000" });
    await rules.evaluateAction(atEquityPct);
    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(1);
  });

  it("R2 fires on any 'flip' regardless of size, and only on 'flip'", async () => {
    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify);

    const openAction = await insertAction({ kind: "open", notionalUsd: "1" });
    await rules.evaluateAction(openAction);
    expect(notify.notifyRulesFire).not.toHaveBeenCalled();

    const flipAction = await insertAction({ kind: "flip", notionalUsd: "1" });
    await rules.evaluateAction(flipAction);
    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(1);
    const call = (notify.notifyRulesFire as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.rules.map((r: { kind: string }) => r.kind)).toEqual(["R2"]);
  });

  it("R3 fires on ANY action kind once notional meets min(flatThresholdUsd, equity*pct) — seeded flat=100000, pct=0.20", async () => {
    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    // equity=1,000,000 -> pct branch = 200,000 > flat 100,000 -> min is 100,000.
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify);

    const reduceBelow = await insertAction({ kind: "reduce", notionalUsd: "99999" });
    await rules.evaluateAction(reduceBelow);
    expect(notify.notifyRulesFire).not.toHaveBeenCalled();

    const reduceAt = await insertAction({ kind: "reduce", notionalUsd: "100000" });
    await rules.evaluateAction(reduceAt);
    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(1);
  });

  it("sends ONE combined message (grouped by chat destination) when R1 and R3 both match the same 'open'", async () => {
    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    // equity so large that both R1 (flat 50k) and R3 (flat 100k) fire off
    // a single 150k open — both route to the realtime chat (R1-R5), so this
    // must be exactly one notifyRulesFire call listing both rule kinds.
    const rules = new RulesService(db, fakeWatcher(10_000_000), notify);

    const bigOpen = await insertAction({ kind: "open", notionalUsd: "150000" });
    await rules.evaluateAction(bigOpen);

    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(1);
    const call = (notify.notifyRulesFire as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.rules.map((r: { kind: string }) => r.kind).sort()).toEqual(["R1", "R3"]);
  });

  it("falls back to the flat threshold alone when equityUsd is unavailable (no cached poll state yet)", async () => {
    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    const rules = new RulesService(db, fakeWatcher(null), notify);

    const belowFlat = await insertAction({ kind: "open", notionalUsd: "49999" });
    await rules.evaluateAction(belowFlat);
    expect(notify.notifyRulesFire).not.toHaveBeenCalled();

    const atFlat = await insertAction({ kind: "open", notionalUsd: "50000" });
    await rules.evaluateAction(atFlat);
    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(1);
  });

  it("does not fire a rule scoped to tiers that exclude this leader's current tier", async () => {
    await db.update(alertRules).set({ tiers: ["A"] }).where(eq(alertRules.kind, "R2"));
    // leader is tier B (seeded in beforeEach) — R2 no longer applies to it.
    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify);

    const flipAction = await insertAction({ kind: "flip" });
    await rules.evaluateAction(flipAction);
    expect(notify.notifyRulesFire).not.toHaveBeenCalled();
  });

  it("does not fire a disabled rule", async () => {
    await db.update(alertRules).set({ enabled: false }).where(eq(alertRules.kind, "R2"));
    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify);

    const flipAction = await insertAction({ kind: "flip" });
    await rules.evaluateAction(flipAction);
    expect(notify.notifyRulesFire).not.toHaveBeenCalled();
  });

  it("suppresses a re-fire within the same rule/address/coin's cooldown window, and allows it again after cooldown expires", async () => {
    const [r1] = await db.select().from(alertRules).where(eq(alertRules.kind, "R1"));
    // Shrink R1's cooldown so the test doesn't need to wait 15 real minutes.
    await db.update(alertRules).set({ cooldownS: 1 }).where(eq(alertRules.kind, "R1"));

    const notify = { notifyRulesFire: vi.fn() } as unknown as NotifyService;
    const rules = new RulesService(db, fakeWatcher(1_000_000), notify);

    const first = await insertAction({ kind: "open", notionalUsd: "60000" });
    await rules.evaluateAction(first);
    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(1);

    // Simulate N2 having logged the resulting alert (RulesService reads
    // `alerts.sent_at` as its cooldown source of truth, not in-memory state).
    await db.insert(alerts).values({
      ruleId: r1.id,
      chain: CHAIN,
      address: ADDRESS,
      coin: "BTC",
      payloadJson: {},
      sentAt: new Date(),
      sendStatus: "dry_run",
    });

    const second = await insertAction({ kind: "open", notionalUsd: "60000" });
    await rules.evaluateAction(second);
    // Still 1 — R1 is in cooldown. (R3's flat is 100k so it doesn't match a
    // 60k notional here, keeping this isolated to R1's cooldown.)
    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const third = await insertAction({ kind: "open", notionalUsd: "60000" });
    await rules.evaluateAction(third);
    expect(notify.notifyRulesFire).toHaveBeenCalledTimes(2);
  }, 10_000);
});

describe("RulesSeedService — real Postgres", () => {
  const db = getTestDb();

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

    // Simulate a D5 edit before the second seed run.
    await db.update(alertRules).set({ cooldownS: 1234 }).where(eq(alertRules.kind, "R1"));

    await seed.seedDefaultRules();
    const rows = await db.select().from(alertRules);
    expect(rows).toHaveLength(3);
    const r1 = rows.find((r) => r.kind === "R1")!;
    expect(r1.cooldownS).toBe(1234); // untouched by the second seed run
  });
});
