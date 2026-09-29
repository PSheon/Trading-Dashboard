import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsersModule } from "../src/users/users.module.js";
import { TradersModule } from "../src/traders/traders.module.js";
import { SettingsModule } from "../src/settings/settings.module.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { DRIZZLE_CLIENT } from "../src/db/db.constants.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";

it("feature modules initialize without a watcher, ingestion schedule or network access", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("NODE_ENV", "development");
  @Global() @Module({ providers: [{ provide: DRIZZLE_CLIENT, useValue: {} }, UnitOfWork], exports: [DRIZZLE_CLIENT, UnitOfWork] })
  class TestDatabase {}
  const ref = await Test.createTestingModule({ imports: [TestDatabase, SettingsModule, UsersModule, TradersModule] }).compile();
  const app = ref.createNestApplication({ logger: false });
  try {
    await app.init();
    expect(() => app.get(WatcherService)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await app.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

it("browser sources use only the contracts subpath, never the database or root barrel", () => {
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.tsx?$/.test(path)) {
        const source = readFileSync(path, "utf8");
        expect(source, path).not.toMatch(/["']@trading-dashboard\/shared(?:\/database)?["']/);
        expect(source, path).not.toMatch(/["']drizzle-orm/);
      }
    }
  }
  scan(join(import.meta.dirname, "../../web/src"));
});
