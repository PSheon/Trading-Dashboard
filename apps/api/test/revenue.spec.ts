import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { adminRevenueResponseSchema, revenueSnapshots } from "@trading-dashboard/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fromUnits, toUnits } from "../src/admin/decimal.js";
import { parseReferral } from "../src/admin/referral.js";
import {
  dailyRevenue,
  rangeStartDay,
  taipeiDay,
  taipeiDayStart,
  type RevenuePoint,
} from "../src/admin/revenue-daily.js";
import { RevenueService } from "../src/admin/revenue.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import type { HlReferralResponse } from "../src/hyperliquid/types.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { truncateAdminTables } from "./admin-test-utils.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

function fixture(name: string): HlReferralResponse {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8")) as HlReferralResponse;
}

/** Live responses, 2026-09-29. */
const NEED_TO_TRADE = fixture("referral-need-to-trade.json"); // 0x000…000: builder rewards only
const NEED_TO_CREATE_CODE = fixture("referral-need-to-create-code.json"); // 0xecb6…2b00: builder rewards only
const READY = fixture("referral-ready.json"); // 0xb83d…6d36: 3 referrals, all claimed
const READY_UNCLAIMED = fixture("referral-ready-with-unclaimed.json"); // 0xbdfa…5c50: 22 referrals

const ZERO = "0x0000000000000000000000000000000000000000";

describe("decimal helpers", () => {
  it("round-trips exactly", () => {
    for (const v of ["0", "11.44228702", "5366091643.4300003052", "-3.5", "0.000000000000000001"]) {
      expect(fromUnits(toUnits(v))).toBe(v);
    }
    expect(fromUnits(toUnits("0.1") + toUnits("0.2"))).toBe("0.3");
    expect(fromUnits(toUnits("1.50"))).toBe("1.5");
    expect(() => toUnits("1e5")).toThrow();
  });
});

describe("parseReferral (live fixtures)", () => {
  it("needToTrade with builder rewards: all builder, no referral", () => {
    expect(NEED_TO_TRADE.referrerState.stage).toBe("needToTrade");
    expect(parseReferral(NEED_TO_TRADE)).toEqual({
      builderRewards: "11.44228702",
      referralRewards: "0",
      claimedRewards: "0",
      unclaimedRewards: "11.44228702",
      referredUsers: 0,
      referredVolume: "0",
    });
  });

  it("needToCreateCode (no data) with builder rewards", () => {
    expect(NEED_TO_CREATE_CODE.referrerState).toEqual({ stage: "needToCreateCode" });
    expect(parseReferral(NEED_TO_CREATE_CODE)).toMatchObject({
      builderRewards: "10943.59566154",
      referralRewards: "0",
      unclaimedRewards: "10943.59566154",
      referredUsers: 0,
    });
  });

  it("ready: referral = claimed + unclaimed − builder = Σ cumFeesRewardedToReferrer", () => {
    for (const response of [READY, READY_UNCLAIMED]) {
      const state = response.referrerState as Extract<HlReferralResponse["referrerState"], { stage: "ready" }>;
      expect(state.stage).toBe("ready");
      const parsed = parseReferral(response);
      const sumToReferrer = state.data.referralStates.reduce((s, r) => s + toUnits(r.cumFeesRewardedToReferrer), 0n);
      expect(parsed.referralRewards).toBe(fromUnits(sumToReferrer));
      expect(parsed.referredUsers).toBe(state.data.referralStates.length);
      expect(parsed.referredUsers).toBe(state.data.nReferrals);
    }
    expect(parseReferral(READY)).toEqual({
      builderRewards: "0",
      referralRewards: "24513.75250433",
      claimedRewards: "24513.75250433",
      unclaimedRewards: "0",
      referredUsers: 3,
      referredVolume: "5397872952.0000003055", // 5366091643.4300003052 + 31781308.5700000003 + 0
    });
    expect(parseReferral(READY_UNCLAIMED)).toMatchObject({
      referralRewards: "14231.16917461",
      claimedRewards: "14227.26887997",
      unclaimedRewards: "3.90029464",
      referredUsers: 22,
    });
  });

  it("a claim moves unclaimed to claimed without changing builder or referral", () => {
    const before = { ...NEED_TO_TRADE, claimedRewards: "1", unclaimedRewards: "15.5", builderRewards: "11.5" };
    const after = { ...before, claimedRewards: "16.5", unclaimedRewards: "0" };
    const a = parseReferral(before);
    const b = parseReferral(after);
    expect([a.builderRewards, a.referralRewards]).toEqual(["11.5", "5"]);
    expect([b.builderRewards, b.referralRewards]).toEqual(["11.5", "5"]);
  });

  it("floors referral at 0 and rejects a response without the amounts", () => {
    expect(parseReferral({ ...NEED_TO_TRADE, unclaimedRewards: "1" }).referralRewards).toBe("0");
    expect(() => parseReferral({ ...NEED_TO_TRADE, builderRewards: undefined } as never)).toThrow(/builderRewards/);
    expect(() => parseReferral({ ...NEED_TO_TRADE, claimedRewards: "n/a" })).toThrow();
  });
});

describe("HyperliquidInfoClient.referral (mocked HTTP)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts {type:'referral', user} with weight 20 through the budgeter", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(NEED_TO_TRADE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const budgeter = { acquire: vi.fn(async () => {}), onSuccess: vi.fn(), onRateLimited: vi.fn() };
    const client = new HyperliquidInfoClient(budgeter as unknown as RequestBudgeterService);

    expect(await client.referral(ZERO, "background", 0)).toEqual(NEED_TO_TRADE);
    expect(budgeter.acquire).toHaveBeenCalledWith(20, "background", 0, expect.any(AbortSignal));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ type: "referral", user: ZERO });
    expect(budgeter.onSuccess).toHaveBeenCalled();
  });
});

describe("dailyRevenue (Asia/Taipei days)", () => {
  const p = (iso: string, builder: string, referral: string): RevenuePoint => ({
    takenAt: new Date(iso),
    builder,
    referral,
  });

  it("splits days at 16:00 UTC", () => {
    expect(taipeiDay(new Date("2026-09-01T15:59:59.999Z"))).toBe("2026-09-01");
    expect(taipeiDay(new Date("2026-09-01T16:00:00Z"))).toBe("2026-09-02");
    expect(taipeiDayStart("2026-09-02").toISOString()).toBe("2026-09-01T16:00:00.000Z");
    expect(rangeStartDay("7d", new Date("2026-09-29T15:59:00Z"))).toBe("2026-09-23");
    expect(rangeStartDay("7d", new Date("2026-09-29T16:00:00Z"))).toBe("2026-09-24");
    expect(rangeStartDay("all", new Date())).toBeNull();
  });

  it("diffs the last snapshot of each day against the one before, with gaps as 0", () => {
    const points = [
      p("2026-09-01T02:00:00Z", "10", "5"), // first ever: baseline
      p("2026-09-01T09:00:00Z", "11", "5"),
      p("2026-09-01T15:59:59Z", "12", "5"), // last of 09-01
      p("2026-09-01T16:00:00Z", "13", "6"), // first of 09-02
      p("2026-09-02T10:00:00Z", "15", "8"), // last of 09-02
      // 09-03: no snapshot
      p("2026-09-04T01:00:00Z", "15.25", "9.1"),
    ];
    const { daily, total, totalUnits } = dailyRevenue(points, null);
    expect(daily).toEqual([
      { day: "2026-09-01", builder: 2, referral: 0 },
      { day: "2026-09-02", builder: 3, referral: 3 },
      { day: "2026-09-03", builder: 0, referral: 0 },
      { day: "2026-09-04", builder: 0.25, referral: 1.1 },
    ]);
    expect(total).toEqual({ builder: 5.25, referral: 4.1 });
    expect(fromUnits(totalUnits)).toBe("9.35");
  });

  it("books a gap's earnings on the next day that has a snapshot", () => {
    const { daily } = dailyRevenue(
      [p("2026-09-01T00:00:00Z", "1", "0"), p("2026-09-01T12:00:00Z", "2", "0"), p("2026-09-05T12:00:00Z", "9", "0")],
      null,
    );
    expect(daily.map((d) => [d.day, d.builder])).toEqual([
      ["2026-09-01", 1],
      ["2026-09-02", 0],
      ["2026-09-03", 0],
      ["2026-09-04", 0],
      ["2026-09-05", 7],
    ]);
  });

  it("clamps a decrease to 0", () => {
    const { daily } = dailyRevenue(
      [p("2026-09-01T00:00:00Z", "5", "5"), p("2026-09-02T00:00:00Z", "4", "6"), p("2026-09-03T00:00:00Z", "4.5", "6")],
      null,
    );
    expect(daily.map((d) => [d.builder, d.referral])).toEqual([
      [0, 0],
      [0, 1],
      [0.5, 0],
    ]);
  });

  it("filters to the range, using the last snapshot before it as the baseline", () => {
    const points = [
      p("2026-08-01T00:00:00Z", "0", "0"),
      p("2026-09-20T00:00:00Z", "100", "10"), // baseline for the range
      p("2026-09-23T00:00:00Z", "103", "10"),
      p("2026-09-29T00:00:00Z", "110", "12"),
    ];
    const { daily, total } = dailyRevenue(points, "2026-09-23");
    expect(daily[0]).toEqual({ day: "2026-09-23", builder: 3, referral: 0 });
    expect(daily.at(-1)).toEqual({ day: "2026-09-29", builder: 7, referral: 2 });
    expect(daily).toHaveLength(7);
    expect(total).toEqual({ builder: 10, referral: 2 });
  });

  it("is exact where floats aren't", () => {
    const { total } = dailyRevenue(
      [p("2026-09-01T00:00:00Z", "0", "0"), p("2026-09-02T00:00:00Z", "0.1", "0"), p("2026-09-03T00:00:00Z", "0.3", "0")],
      null,
    );
    expect(total.builder).toBe(0.3);
  });
});

describe("RevenueService — real Postgres", () => {
  const db = getTestDb();
  let settings: SettingsService;
  let referral: ReturnType<typeof vi.fn>;
  let service: RevenueService;

  beforeEach(async () => {
    await truncateAdminTables(db);
    settings = new SettingsService(db);
    referral = vi.fn(async () => NEED_TO_TRADE);
    service = new RevenueService(db, settings, { referral } as unknown as HyperliquidInfoClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await truncateAdminTables(db);
    await closeTestDb();
  });

  describe("snapshot job", () => {
    it("does nothing without an address", async () => {
      expect(await service.snapshot()).toEqual({ status: "skipped", reason: "no_address" });
      expect(referral).not.toHaveBeenCalled();
      expect(await db.select().from(revenueSnapshots)).toHaveLength(0);
    });

    it("writes a row per run, even when nothing changed, at a whole second", async () => {
      await settings.patch({ revenue: { builderAddress: ZERO } }, null);
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-29T10:00:00.789Z"));
      expect(await service.snapshot()).toMatchObject({ status: "written", address: ZERO });
      now.mockReturnValue(Date.parse("2026-09-29T11:00:00.123Z"));
      await service.hourlySnapshot();

      expect(referral).toHaveBeenCalledWith(ZERO, "background", 0);
      const rows = await db.select().from(revenueSnapshots).orderBy(revenueSnapshots.takenAt);
      expect(rows.map((r) => r.takenAt.toISOString())).toEqual([
        "2026-09-29T10:00:00.000Z",
        "2026-09-29T11:00:00.000Z",
      ]);
      expect(rows[0]).toMatchObject({
        address: ZERO,
        builderRewards: "11.44228702",
        referralRewards: "0",
        claimedRewards: "0",
        unclaimedRewards: "11.44228702",
        referredUsers: 0,
        referredVolume: "0",
      });
      expect(rows[0].raw).toEqual(NEED_TO_TRADE);
    });

    it("stores a ready referrer's counts", async () => {
      await settings.patch({ revenue: { builderAddress: ZERO } }, null);
      referral.mockResolvedValue(READY_UNCLAIMED);
      await service.snapshot();
      const [row] = await db.select().from(revenueSnapshots);
      expect(row).toMatchObject({ referredUsers: 22, referralRewards: "14231.16917461" });
      expect(Number(row.referredVolume)).toBeCloseTo(426276340.87, 2);
    });

    it("logs and returns on upstream failure or a malformed response, writing nothing", async () => {
      await settings.patch({ revenue: { builderAddress: ZERO } }, null);
      referral.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 429"));
      expect(await service.snapshot()).toEqual({ status: "failed", error: "Hyperliquid info request failed: 429" });
      referral.mockResolvedValueOnce({ oops: true });
      expect(await service.snapshot()).toMatchObject({ status: "failed" });
      await expect(service.hourlySnapshot()).resolves.toBeUndefined();
      expect(await db.select().from(revenueSnapshots)).toHaveLength(1); // only the last, healthy call
    });

    it("never lets a fire-and-forget snapshot reject", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        vi.spyOn(service, "snapshot").mockRejectedValue(new Error("boom"));
        service.triggerSnapshot("test");
        service.onApplicationBootstrap();
        await new Promise((r) => setTimeout(r, 20));
        expect(service.snapshot).toHaveBeenCalledTimes(2);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });

  describe("GET /admin/revenue", () => {
    const insert = (takenAt: string, values: Partial<typeof revenueSnapshots.$inferInsert> = {}, address = ZERO) =>
      db.insert(revenueSnapshots).values({
        address,
        takenAt: new Date(takenAt),
        builderRewards: "0",
        referralRewards: "0",
        claimedRewards: "0",
        unclaimedRewards: "0",
        raw: {},
        ...values,
      });

    it("returns zeros with no address", async () => {
      await insert("2026-09-29T00:00:00Z", { builderRewards: "5" });
      const res = await service.report("30d", new Date("2026-09-29T12:00:00Z"));
      expect(adminRevenueResponseSchema.parse(res)).toEqual(res);
      expect(res).toMatchObject({ address: null, rangeUsd: { builder: 0, referral: 0 }, daily: [], lastSnapshotAt: null });
      expect(res.totals.builderUsd).toBe(0);
    });

    it("returns zeros with an address but no snapshots yet", async () => {
      await settings.patch({ revenue: { builderAddress: ZERO, builderFeeTenthsBps: 10, referralCode: "ORBIE" } }, null);
      const res = await service.report("7d", new Date("2026-09-29T12:00:00Z"));
      expect(res).toEqual({
        address: ZERO,
        builderFeeTenthsBps: 10,
        referralCode: "ORBIE",
        totals: { builderUsd: 0, referralUsd: 0, claimedUsd: 0, unclaimedUsd: 0, referredUsers: 0, referredVolumeUsd: 0 },
        rangeUsd: { builder: 0, referral: 0 },
        daily: [],
        lastSnapshotAt: null,
      });
      expect(await service.earned30dUsd(new Date("2026-09-29T12:00:00Z"))).toBe(0);
    });

    it("reports totals from the latest snapshot and daily earnings per Taipei day", async () => {
      await settings.patch({ revenue: { builderAddress: ZERO } }, null);
      const now = new Date("2026-09-29T12:00:00Z"); // Taipei 09-29 20:00
      // Before the 7-day range (09-23 … 09-29): the baseline.
      await insert("2026-09-10T00:00:00Z", { builderRewards: "1", referralRewards: "1", unclaimedRewards: "2" });
      await insert("2026-09-22T15:00:00Z", { builderRewards: "2", referralRewards: "3", unclaimedRewards: "5" });
      // 09-23 (Taipei): the first in-range day, earned 1 builder.
      await insert("2026-09-22T16:00:00Z", { builderRewards: "3", referralRewards: "3", unclaimedRewards: "6" });
      // 09-25: a claim — unclaimed → claimed, nothing earned.
      await insert("2026-09-25T00:00:00Z", { builderRewards: "3", referralRewards: "3", claimedRewards: "6" });
      // 09-29: two snapshots; the last one counts. Earned 0.5 builder, 2 referral.
      await insert("2026-09-29T01:00:00Z", { builderRewards: "3.2", referralRewards: "4", claimedRewards: "6", unclaimedRewards: "1.2" });
      await insert("2026-09-29T11:00:00Z", {
        builderRewards: "3.5",
        referralRewards: "5",
        claimedRewards: "6",
        unclaimedRewards: "2.5",
        referredUsers: 4,
        referredVolume: "123456.5",
      });
      // Another address: ignored.
      await insert("2026-09-29T11:30:00Z", { builderRewards: "999" }, "0x1111111111111111111111111111111111111111");

      const res = await service.report("7d", now);
      expect(adminRevenueResponseSchema.parse(res)).toEqual(res);
      expect(res.totals).toEqual({
        builderUsd: 3.5,
        referralUsd: 5,
        claimedUsd: 6,
        unclaimedUsd: 2.5,
        referredUsers: 4,
        referredVolumeUsd: 123456.5,
      });
      expect(res.lastSnapshotAt).toEqual(new Date("2026-09-29T11:00:00Z"));
      expect(res.daily).toEqual([
        { day: "2026-09-23", builder: 1, referral: 0 },
        { day: "2026-09-24", builder: 0, referral: 0 },
        { day: "2026-09-25", builder: 0, referral: 0 },
        { day: "2026-09-26", builder: 0, referral: 0 },
        { day: "2026-09-27", builder: 0, referral: 0 },
        { day: "2026-09-28", builder: 0, referral: 0 },
        { day: "2026-09-29", builder: 0.5, referral: 2 },
      ]);
      expect(res.rangeUsd).toEqual({ builder: 1.5, referral: 2 });

      const all = await service.report("all", now);
      expect(all.daily[0]).toEqual({ day: "2026-09-10", builder: 0, referral: 0 });
      expect(all.daily.find((d) => d.day === "2026-09-22")).toEqual({ day: "2026-09-22", builder: 1, referral: 2 });
      expect(all.rangeUsd).toEqual({ builder: 2.5, referral: 4 });

      expect(await service.earned30dUsd(now)).toBe(6.5); // range 08-31 … 09-29, baseline none → from 09-10
    });
  });
});
