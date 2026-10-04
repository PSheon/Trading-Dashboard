import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import { ModulesContainer } from "@nestjs/core";
import { SchedulerRegistry } from "@nestjs/schedule";
// Metadata keys of @nestjs/schedule (schedule.constants), not exported from its index.
const SCHEDULE_CRON_OPTIONS = "SCHEDULE_CRON_OPTIONS", SCHEDULE_INTERVAL_OPTIONS = "SCHEDULE_INTERVAL_OPTIONS", SCHEDULE_TIMEOUT_OPTIONS = "SCHEDULE_TIMEOUT_OPTIONS";
import type { INestApplicationContext } from "@nestjs/common";
import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { HealthService } from "../src/api/health/health.service.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { TradeFeedService } from "../src/watcher/trade-feed.service.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { BackfillWorker } from "../src/jobs/backfill-worker.service.js";
import { TradersWorker } from "../src/traders/traders-worker.module.js";
import { OutboxService } from "../src/outbox/outbox.service.js";
import { TelegramBotService } from "../src/telegram/telegram-bot.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import { CopyWorkerService } from "../src/copy/copy-worker.service.js";
import { CopyFundingMonitor } from "../src/copy/copy-funding-monitor.service.js";
import { CopyFollowerMonitor } from "../src/copy/copy-follower-monitor.service.js";
import { CopyFollowerSnapshotCollector } from "../src/copy/copy-follower-snapshot.service.js";
import { RevenueWorker } from "../src/admin/revenue.module.js";
import { WorkerHeartbeatService } from "../src/worker/worker-heartbeat.service.js";
import { ActionRelay, ActionRelayListener } from "../src/runtime/action-relay.js";

/** Every class that runs on its own (a loop, a poller, a consumer, a drain,
 * a startup job). None may exist in the api process. */
const BACKGROUND = [WatcherService, TradeFeedService, SchedulerService, BackfillWorker, TradersWorker, OutboxService, TelegramBotService,
  RulesSeedService, CopyWorkerService, CopyFundingMonitor, CopyFollowerMonitor, CopyFollowerSnapshotCollector, RevenueWorker, WorkerHeartbeatService];

/** Providers of the composed graph that carry a `@Cron`, `@Interval` or `@Timeout`. */
function scheduledProviders(app: INestApplicationContext): string[] {
  const found = new Set<string>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.providers.values()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance || typeof instance !== "object") continue;
      for (let proto = Object.getPrototypeOf(instance); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          const method = Object.getOwnPropertyDescriptor(proto, key)?.value;
          if (typeof method !== "function") continue;
          if ([SCHEDULE_CRON_OPTIONS, SCHEDULE_INTERVAL_OPTIONS, SCHEDULE_TIMEOUT_OPTIONS].some((k) => Reflect.getMetadata(k, method) !== undefined)) found.add(`${instance.constructor.name}.${key}`);
        }
      }
    }
  }
  return [...found].sort();
}

const environment = (extra: Record<string, string> = {}) => ({ NODE_ENV: "test", DATABASE_URL: process.env.TEST_DATABASE_URL!, ...extra });

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("the api (IS_WORKER unset) starts no background job: no scheduler, no loop, no schedule, and reads the worker's heartbeat", async () => {
  vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
  vi.stubEnv("WORKER_URL", "http://worker.internal:3000");
  const config = new AppConfig(validateEnvironment(environment({ WORKER_URL: "http://worker.internal:3000" })));
  expect(config.value.app.isWorker).toBe(false);
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ feedConnected: true }) });
  vi.stubGlobal("fetch", fetcher);
  const { AppModule } = await import("../src/app.module.js");
  const ref = await Test.createTestingModule({ imports: [AppModule.api()] }).overrideProvider(AppConfig).useValue(config).compile();
  const app = ref.createNestApplication({ logger: false });
  try {
    await app.init();
    // No ScheduleModule at all: nothing could fire a @Cron/@Interval here.
    expect(() => app.get(SchedulerRegistry, { strict: false })).toThrow();
    expect(scheduledProviders(app)).toEqual([]);
    for (const type of BACKGROUND) expect(() => app.get(type, { strict: false }), type.name).toThrow();
    // The api listens for the worker's actions (and publishes its own).
    expect(app.get(ActionRelayListener, { strict: false })).toBeInstanceOf(ActionRelay);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await app.get(HealthService).heartbeat()).toEqual({ feedConnected: true });
    expect(String(fetcher.mock.calls[0][0])).toBe("http://worker.internal:3000/health");
    fetcher.mockRejectedValueOnce(new Error("network"));
    await expect(app.get(HealthService).heartbeat()).rejects.toMatchObject({ status: 503 });
  } finally { await app.close(); }
});

it("the worker (IS_WORKER=true) owns every schedule and loop, as an application context with no routes", async () => {
  vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
  const config = new AppConfig(validateEnvironment(environment({ IS_WORKER: "true" })));
  expect(config.value.app.isWorker).toBe(true);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const { AppModule } = await import("../src/app.module.js");
  const ref = await Test.createTestingModule({ imports: [AppModule.worker()] }).overrideProvider(AppConfig).useValue(config).compile();
  const app = await ref.init();
  try {
    const registry = app.get(SchedulerRegistry, { strict: false });
    for (const job of registry.getCronJobs().values()) void job.stop();
    for (const type of BACKGROUND) expect(app.get(type, { strict: false }), type.name).toBeTruthy();
    expect(() => app.get(ActionRelayListener, { strict: false })).toThrow();
    expect(scheduledProviders(app)).toEqual(expect.arrayContaining([
      "SchedulerService.snapshotAll", "SchedulerService.catchUp", "TradersWorker.historyTick", "TradersWorker.ingestTick", "OutboxService.drain",
      "BackfillWorker.scheduledTick", "RevenueWorker.hourlySnapshot", "ArchiveIngestWorker.archiveTick", "RetentionWorker.tick",
      "DiscoveryWorker.performanceTick", "DiscoveryWorker.ledgerTick", "CohortWorker.cohortTick",
    ]));
    expect(registry.getCronJobs().size).toBeGreaterThanOrEqual(12);
    expect(registry.getIntervals().length).toBeGreaterThanOrEqual(2);
  } finally { await app.close(); }
});

it("one entry point picks AppModule.api() or AppModule.worker(); the worker is never an HTTP application", () => {
  const main = readFileSync(resolve(import.meta.dirname, "../src/main.ts"), "utf8");
  const worker = readFileSync(resolve(import.meta.dirname, "../src/bootstrap/worker.bootstrap.ts"), "utf8");
  expect(main).toContain("NestFactory.create(AppModule.api()");
  expect(main).toContain("config.app.isWorker");
  expect(worker).toContain("createApplicationContext(AppModule.worker()");
  expect(worker).not.toContain("NestFactory.create(");
});
