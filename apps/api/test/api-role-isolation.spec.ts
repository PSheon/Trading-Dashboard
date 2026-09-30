import { afterEach, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { HealthService } from "../src/api/health/health.service.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("API boots with no scheduled or startup ingestion and reads remote worker heartbeat", async () => {
  vi.stubEnv("APP_ROLE", "api");
  vi.stubEnv("WORKER_URL", "http://worker.internal:3000");
  vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
  const { AppModule } = await import("../src/app.module.js");
  const config = new AppConfig(validateEnvironment({NODE_ENV: "staging", APP_ROLE: "api", WORKER_URL: "http://worker.internal:3000", DATABASE_URL: process.env.TEST_DATABASE_URL!}));
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ feedConnected: true }) });
  vi.stubGlobal("fetch", fetcher);
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AppConfig).useValue(config).compile();
  const app = ref.createNestApplication({ logger: false });
  try {
    await app.init();
    expect(fetcher).not.toHaveBeenCalled();
    expect(app.get(SchedulerRegistry).getCronJobs().size).toBe(0);
    expect(app.get(SchedulerRegistry).getIntervals()).toEqual([]);
    expect(app.get(WatcherService).getHeartbeat().feed.socketsTotal).toBe(0);
    expect(await app.get(HealthService).heartbeat()).toEqual({ feedConnected: true });
    expect(String(fetcher.mock.calls[0][0])).toBe("http://worker.internal:3000/health");
    fetcher.mockRejectedValueOnce(new Error("network"));
    await expect(app.get(HealthService).heartbeat()).rejects.toMatchObject({ status: 503 });
  } finally { await app.close(); }
});
