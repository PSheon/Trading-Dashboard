import * as schema from "@trading-dashboard/shared/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { UnitOfWork } from "../src/db/unit-of-work.js";
import { SettingsRelay } from "../src/settings/settings-relay.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

/**
 * One "process": its own connection pool, repository, settings cache and
 * relay, sharing nothing with the others but the database. That is exactly
 * what the api and the worker share in a deployment; the notification
 * travels through PostgreSQL between sessions either way. (They are
 * separate pools inside this one test process, not separate OS processes.)
 */
async function startProcess(options: { relay?: boolean } = {}) {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = drizzle(pool, { schema });
  const repository = new SettingsRepository(db);
  let reads = 0;
  const readSections = repository.readSections.bind(repository);
  repository.readSections = ((executor?: Parameters<typeof readSections>[0]) => { if (!executor) reads += 1; return readSections(executor); }) as typeof repository.readSections;
  const settings = new SettingsService(repository, new UnitOfWork(db));
  const relay = new SettingsRelay(settings, options.relay === false ? undefined : pool);
  await relay.onApplicationBootstrap();
  return { pool, settings, relay, reads: () => reads, stop: async () => { await relay.onModuleDestroy(); await pool.end(); } };
}
type Proc = Awaited<ReturnType<typeof startProcess>>;

/** Milliseconds until `check` holds, polling every 10 ms; fails after `limit`. */
async function until(check: () => Promise<boolean> | boolean, limit: number): Promise<number> {
  const started = performance.now();
  while (!(await check())) {
    if (performance.now() - started > limit) throw new Error(`not within ${limit} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return performance.now() - started;
}

describe("a settings save in one process reaches the others at once (review finding 16)", () => {
  const db = getTestDb();
  let procs: Proc[] = [];
  const start = async (options?: { relay?: boolean }) => { const p = await startProcess(options); procs.push(p); return p; };

  beforeEach(async () => { await truncateAll(db); });
  afterEach(async () => { await Promise.all(procs.map((p) => p.stop())); procs = []; });
  afterAll(async () => { await truncateAll(db); await closeTestDb(); });

  it("the api closes sign-ups and turns alerts off; the worker's cached copy is replaced within a second", async () => {
    const api = await start();
    const worker = await start();
    const unlinked = await start({ relay: false });
    // Every process has the defaults cached.
    for (const p of [api, worker, unlinked]) {
      expect((await p.settings.get("general")).signupsOpen).toBe(true);
      expect((await p.settings.get("notifications")).alertsEnabled).toBe(true);
      expect((await p.settings.get("general")).copyTradingEnabled).toBe(false);
    }
    const cachedReads = worker.reads();
    await worker.settings.getAll();
    expect(worker.reads()).toBe(cachedReads);

    await api.settings.patch({ general: { signupsOpen: false, copyTradingEnabled: true }, notifications: { alertsEnabled: false } }, null);

    const ms = await until(async () => (await worker.settings.get("general")).signupsOpen === false, 2000);
    expect(ms).toBeLessThan(1000);
    expect(await worker.settings.get("general")).toMatchObject({ signupsOpen: false, copyTradingEnabled: true });
    expect((await worker.settings.get("notifications")).alertsEnabled).toBe(false);
    expect((await worker.settings.getPublic()).signupsOpen).toBe(false);
    // The saving process sees its own change without waiting for anything.
    expect((await api.settings.get("general")).signupsOpen).toBe(false);
    // What this replaces: a process without the relay keeps serving its cached copy (for up to 30 s).
    expect((await unlinked.settings.get("general")).signupsOpen).toBe(true);
    // One reload, then cached again: the relay invalidates, it does not disable caching.
    const afterReload = worker.reads();
    await worker.settings.getAll();
    await worker.settings.getAll();
    expect(worker.reads()).toBe(afterReload);
  });

  it("it works in both directions and for every later save", async () => {
    const api = await start();
    const worker = await start();
    await api.settings.getAll();
    await worker.settings.getAll();
    await worker.settings.patch({ notifications: { alertsEnabled: false } }, null);
    await until(async () => (await api.settings.get("notifications")).alertsEnabled === false, 2000);
    await api.settings.patch({ notifications: { alertsEnabled: true } }, null);
    await until(async () => (await worker.settings.get("notifications")).alertsEnabled === true, 2000);
    await api.settings.patch({ general: { signupsOpen: false } }, null);
    await until(async () => (await worker.settings.get("general")).signupsOpen === false, 2000);
  });

  it("a save that is rolled back announces nothing", async () => {
    const api = await start();
    const worker = await start();
    const stale = (await api.settings.getSnapshot()).revisions.general;
    await api.settings.patch({ general: { signupsOpen: false } }, null);
    await until(async () => (await worker.settings.get("general")).signupsOpen === false, 2000);
    // Let that save's own notification land, then cache the result.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.settings.getAll();
    const reads = worker.reads();
    await expect(api.settings.patch({ general: { signupsOpen: true }, expectedRevisions: { general: stale } }, null)).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.settings.getAll();
    expect(worker.reads()).toBe(reads);
    expect((await worker.settings.get("general")).signupsOpen).toBe(false);
  });

  it("while a process's listening connection is down it reads the database every time, and it reconnects", async () => {
    const api = await start();
    const worker = await start();
    await worker.settings.getAll();
    expect(worker.relay.listening).toBe(true);
    // Kill the worker's LISTEN session from outside, as a failover would.
    await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and query = ${"LISTEN orbie_settings"} and pid <> pg_backend_pid()`);
    await until(() => !worker.relay.listening || !api.relay.listening, 2000);
    // Saved while nobody may be listening: there is no cache to be stale.
    await api.settings.patch({ general: { signupsOpen: false } }, null);
    expect((await worker.settings.get("general")).signupsOpen).toBe(false);
    const ms = await until(() => worker.relay.listening && api.relay.listening, 5000);
    expect(ms).toBeLessThan(3000);
    // Back to normal: the next save is delivered again.
    await worker.settings.getAll();
    await api.settings.patch({ general: { signupsOpen: true } }, null);
    await until(async () => (await worker.settings.get("general")).signupsOpen === true, 2000);
  });
});
