import { BadRequestException } from "@nestjs/common";
import { adminSettingsSchema, appSettings, publicSettingsSchema } from "@trading-dashboard/shared";
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
  const service_: RequestUser = { kind: "service" };

  beforeEach(async () => {
    await truncateAdminTables(db);
    settings = new SettingsService(db);
    triggerSnapshot = vi.fn();
    service = new AdminSettingsService(settings, { triggerSnapshot } as unknown as RevenueService);
  });

  afterAll(async () => {
    await truncateAdminTables(db);
    await closeTestDb();
  });

  it("GET /admin/settings returns every section with defaults", async () => {
    const all = await service.getAll();
    expect(adminSettingsSchema.parse(all)).toEqual(all);
    expect(all.revenue.builderAddress).toBeNull();
  });

  it("GET /settings returns the public subset", async () => {
    await service.patch({ discovery: { featuredAddresses: [A] }, revenue: { referralCode: "ORBIE" } }, service_);
    const pub = await new PublicSettingsController(settings).get();
    expect(publicSettingsSchema.strict().parse(pub)).toEqual(pub);
    expect(pub.featuredAddresses).toEqual([A.toLowerCase()]);
    expect(pub.referralCode).toBe("ORBIE");
  });

  it("merges a partial section over the stored one and records who saved it", async () => {
    const admin = await insertUser(db, { role: "admin" });
    const user: RequestUser = { kind: "user", id: admin.id, privyUserId: admin.privyUserId, role: "admin" };
    await service.patch({ general: { signupsOpen: false } }, user);
    const saved = await service.patch({ general: { copyTradingEnabled: true } }, user);
    expect(saved.general).toMatchObject({ signupsOpen: false, copyTradingEnabled: true });
    expect(saved.general.announcement.enabled).toBe(false);

    const rows = await db.select().from(appSettings);
    expect(rows.map((r) => [r.key, r.updatedByUserId])).toEqual([["general", admin.id]]);
  });

  it("stores null as the editor for the service token", async () => {
    await service.patch({ notifications: { alertsEnabled: false } }, service_);
    await service.patch({ notifications: { alertsEnabled: true } }, null);
    const [row] = await db.select().from(appSettings);
    expect(row.updatedByUserId).toBeNull();
  });

  it("lowercases and de-duplicates featured addresses, keeping the order", async () => {
    const saved = await service.patch(
      { discovery: { featuredAddresses: [B, A, B.toLowerCase(), A.toUpperCase().replace("0X", "0x")] } },
      service_,
    );
    expect(saved.discovery.featuredAddresses).toEqual([B.toLowerCase(), A.toLowerCase()]);
    expect((await new SettingsService(db).get("discovery")).featuredAddresses).toEqual([
      B.toLowerCase(),
      A.toLowerCase(),
    ]);
  });

  it("lowercases the builder address and snapshots when it changes", async () => {
    const saved = await service.patch({ revenue: { builderAddress: A } }, service_);
    expect(saved.revenue.builderAddress).toBe(A.toLowerCase());
    expect(triggerSnapshot).toHaveBeenCalledTimes(1);

    // Same address, different case: not a change.
    await service.patch({ revenue: { builderAddress: A.toLowerCase() } }, service_);
    // Another section: not a change.
    await service.patch({ revenue: { builderFeeTenthsBps: 10 } }, service_);
    expect(triggerSnapshot).toHaveBeenCalledTimes(1);

    await service.patch({ revenue: { builderAddress: B } }, service_);
    expect(triggerSnapshot).toHaveBeenCalledTimes(2);

    // Clearing the address takes no snapshot.
    const cleared = await service.patch({ revenue: { builderAddress: null } }, service_);
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
