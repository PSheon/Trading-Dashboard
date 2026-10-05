import { SettingsRepository } from "../src/settings/settings.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { BadRequestException } from "@nestjs/common";
import { appSettings } from "@trading-dashboard/shared/database";
import { adminSettingsSnapshotSchema, publicSettingsSchema } from "@trading-dashboard/shared/contracts";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminSettingsService } from "../src/admin/admin-settings.service.js";
import { PublicSettingsController } from "../src/admin/admin.controller.js";
import type { RevenueService } from "../src/admin/revenue.service.js";
import type { RequestUser } from "../src/common/auth/current-user.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { insertUser, truncateAdminTables } from "./admin-test-utils.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

const A = "0xAbCdEf0000000000000000000000000000000001";
const B = "0x00000000000000000000000000000000000000bB";

async function badRequestBody(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as BadRequestException).getResponse() as Record<string, unknown>;
}

describe("admin settings — real Postgres", () => {
  const db = getTestDb();
  let settings: SettingsService;
  let triggerSnapshot: ReturnType<typeof vi.fn>;
  let service: AdminSettingsService;
  const service_: RequestUser = { kind: "service", permissions: [] };

  async function patch(body: object, actor: RequestUser | null) {
    return service.patch({ ...body, expectedRevisions: (await service.getAll()).revisions }, actor);
  }

  beforeEach(async () => {
    await truncateAdminTables(db);
    settings = new SettingsService(new SettingsRepository(db), new UnitOfWork(db));
    triggerSnapshot = vi.fn();
    service = new AdminSettingsService(settings, { triggerSnapshot } as unknown as RevenueService);
  });

  afterAll(async () => {
    await truncateAdminTables(db);
    await closeTestDb();
  });

  it("GET /admin/settings returns every section with defaults", async () => {
    const all = await service.getAll();
    expect(adminSettingsSnapshotSchema.parse(all)).toEqual(all);
    expect(all.revenue.builderAddress).toBeNull();
  });

  it("GET /settings returns the public subset", async () => {
    await patch({ discovery: { homeMarkets: ["ETH", "BTC"] } }, service_);
    const pub = await new PublicSettingsController(settings).get();
    expect(publicSettingsSchema.strict().parse(pub)).toEqual(pub);
    expect(pub.homeMarkets).toEqual(["ETH", "BTC"]);
    // The two settings nobody read are gone (Paul, 2026-10-05).
    expect(pub).not.toHaveProperty("featuredAddresses");
    expect(pub).not.toHaveProperty("referralCode");
  });

  it("merges a partial section over the stored one and records who saved it", async () => {
    const admin = await insertUser(db, { role: "admin" });
    const user: RequestUser = { kind: "user", id: admin.id, privyUserId: admin.privyUserId, role: "admin" };
    await patch({ general: { signupsOpen: false } }, user);
    const saved = await patch({ general: { copyTradingEnabled: true } }, user);
    expect(saved.general).toMatchObject({ signupsOpen: false, copyTradingEnabled: true });
    expect(saved.general.announcement.enabled).toBe(false);

    const rows = await db.select().from(appSettings);
    expect(rows.map((r) => [r.key, r.updatedByUserId])).toEqual([["general", admin.id]]);
  });

  it("stores null as the editor for the service token", async () => {
    await patch({ notifications: { alertsEnabled: false } }, service_);
    await patch({ notifications: { alertsEnabled: true } }, null);
    const [row] = await db.select().from(appSettings);
    expect(row.updatedByUserId).toBeNull();
  });

  it("refuses the settings that moved to env or were removed (Paul, 2026-10-05)", async () => {
    for (const body of [
      { discovery: { featuredAddresses: [A] } },
      { discovery: { poolWeightPerMinute: 50 } },
      { discovery: { candidatePoolSize: 500 } },
      { discovery: { leaderboardRefreshMinutes: 30 } },
      { discovery: { cohortWeightPerMinute: 50 } },
      { general: { retention: { enabled: false } } },
      { revenue: { referralCode: "ORBIE" } },
    ]) {
      await expect(patch(body as never, service_)).rejects.toThrow(BadRequestException);
    }
    const all = await service.getAll();
    expect(all.discovery).not.toHaveProperty("poolWeightPerMinute");
    expect(all.discovery).not.toHaveProperty("featuredAddresses");
    expect(all.general).not.toHaveProperty("retention");
    expect(all.revenue).not.toHaveProperty("referralCode");
  });

  it("lowercases the builder address and snapshots when it changes", async () => {
    const saved = await patch({ revenue: { builderAddress: A } }, service_);
    expect(saved.revenue.builderAddress).toBe(A.toLowerCase());
    expect(triggerSnapshot).toHaveBeenCalledTimes(1);

    // Same address, different case: not a change.
    await patch({ revenue: { builderAddress: A.toLowerCase() } }, service_);
    // Another section: not a change.
    await patch({ revenue: { builderFeeTenthsBps: 10 } }, service_);
    expect(triggerSnapshot).toHaveBeenCalledTimes(1);

    await patch({ revenue: { builderAddress: B } }, service_);
    expect(triggerSnapshot).toHaveBeenCalledTimes(2);

    // Clearing the address takes no snapshot.
    const cleared = await patch({ revenue: { builderAddress: null } }, service_);
    expect(cleared.revenue.builderAddress).toBeNull();
    expect(triggerSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a bad address", { revenue: { builderAddress: "0x123" } }],
    ["an out-of-range fee", { revenue: { builderFeeTenthsBps: 101 } }],
    ["a bad referral code", { revenue: { referralCode: "has space" } }],
    ["a wrong type", { general: { signupsOpen: "yes" } }],
    ["too many featured addresses", { discovery: { featuredAddresses: Array(13).fill(A) } }],
    ["a non-object body", "nope"],
  ])("400s with zod issues on %s and saves nothing", async (_label, body) => {
    const response = await badRequestBody(service.patch(body, service_));
    expect(response).toMatchObject({ statusCode: 400, message: "Invalid request" });
    expect(Array.isArray(response.issues) && response.issues.length > 0).toBe(true);
    expect(await db.select().from(appSettings)).toHaveLength(0);
    expect(triggerSnapshot).not.toHaveBeenCalled();
  });
});
