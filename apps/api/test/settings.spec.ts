import { appSettings } from "@trading-dashboard/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { SettingsService } from "../src/settings/settings.service.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

describe("SettingsService — real Postgres", () => {
  const db = getTestDb();

  beforeEach(async () => {
    await db.delete(appSettings);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("returns the schema defaults when nothing is stored", async () => {
    const all = await new SettingsService(db).getAll();
    expect(all.discovery.lowSampleThreshold).toBe(20);
    expect(all.discovery.hideVaults).toBe(true);
    expect(all.general.signupsOpen).toBe(true);
    expect(all.revenue.builderAddress).toBeNull();
  });

  it("merges a patch over the current section and saves only that section", async () => {
    const service = new SettingsService(db);
    await service.patch({ discovery: { lowSampleThreshold: 30 } }, null);
    const merged = await service.patch({ discovery: { hideVaults: false } }, null);
    expect(merged.discovery).toMatchObject({ lowSampleThreshold: 30, hideVaults: false });

    const rows = await db.select().from(appSettings);
    expect(rows.map((r) => r.key)).toEqual(["discovery"]);
    // A fresh instance (no cache) reads the same thing back.
    expect((await new SettingsService(db).get("discovery")).lowSampleThreshold).toBe(30);
  });

  it("rejects invalid values and leaves the stored row alone", async () => {
    const service = new SettingsService(db);
    await expect(service.patch({ revenue: { builderFeeTenthsBps: 101 } }, null)).rejects.toMatchObject({ name: "ZodError" });
    expect(await db.select().from(appSettings)).toHaveLength(0);
  });

  it("falls back to defaults for a stored section that no longer validates", async () => {
    await db.insert(appSettings).values([
      { key: "discovery", value: { lowSampleThreshold: "lots" } },
      { key: "general", value: { signupsOpen: false } },
    ]);
    const all = await new SettingsService(db).getAll();
    expect(all.discovery.lowSampleThreshold).toBe(20);
    expect(all.general.signupsOpen).toBe(false);
  });

  it("exposes only the public subset", async () => {
    const service = new SettingsService(db);
    await service.patch({ revenue: { referralCode: "ORBIE", builderFeeTenthsBps: 10 } }, null);
    const pub = await service.getPublic();
    expect(pub.referralCode).toBe("ORBIE");
    expect(pub).not.toHaveProperty("builderFeeTenthsBps");
    expect(pub).not.toHaveProperty("builderAddress");
  });
});
