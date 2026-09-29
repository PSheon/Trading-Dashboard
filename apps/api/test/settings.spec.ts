import { sql } from "drizzle-orm";
import { appSettings } from "@trading-dashboard/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("preserves concurrent patches to different fields of an initially absent section", async () => {
    // Delay the first write so both clients have read the absent row on the old implementation.
    await db.execute(sql`CREATE FUNCTION test_delay_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER test_delay_settings BEFORE INSERT ON app_settings FOR EACH ROW EXECUTE FUNCTION test_delay_settings()`);
    try {
    await Promise.all([
      new SettingsService(db).patch({ discovery: { lowSampleThreshold: 77 } }, null),
      new SettingsService(db).patch({ discovery: { hideVaults: false } }, null),
    ]);
    expect(await new SettingsService(db).get("discovery")).toMatchObject({ lowSampleThreshold: 77, hideVaults: false });
    } finally {
      await db.execute(sql`DROP TRIGGER test_delay_settings ON app_settings`);
      await db.execute(sql`DROP FUNCTION test_delay_settings()`);
    }
  });

  it("does not publish an old pending read into cache after a successful patch", async () => {
    const service = new SettingsService(db);
    const select = db.select.bind(db);
    let fetched!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { fetched = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(db, "select").mockImplementationOnce(() => ({ from: async () => {
      const rows = await select().from(appSettings);
      fetched();
      await barrier;
      return rows;
    } }) as unknown as ReturnType<typeof db.select>);
    try {
      const oldRead = service.getAll();
      await ready;
      await service.patch({ general: { signupsOpen: false } }, null);
      release();
      await oldRead;
      expect((await service.getAll()).general.signupsOpen).toBe(false);
    } finally { release(); spy.mockRestore(); }
  });

  it("rolls back all sections and preserves the cache when a later write fails", async () => {
    const service = new SettingsService(db);
    const before = await service.getAll();
    await db.execute(sql`ALTER TABLE app_settings ADD CONSTRAINT test_reject_revenue CHECK (key <> 'revenue')`);
    try {
      await expect(service.patch({ general: { signupsOpen: false }, revenue: { referralCode: "FAIL" } }, null)).rejects.toThrow();
      expect(await db.select().from(appSettings)).toHaveLength(0);
      expect(await service.getAll()).toEqual(before);
    } finally {
      await db.execute(sql`ALTER TABLE app_settings DROP CONSTRAINT test_reject_revenue`);
    }
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
