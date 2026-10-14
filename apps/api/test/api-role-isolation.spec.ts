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
  expect(worker).toContain("createApplicationContext(AppModule.worker(role)");
  expect(worker).not.toContain("NestFactory.create(");
});

/** Every provider instance's class name (and symbol tokens' names) in the composed graph. */
function providerNames(app: INestApplicationContext): Set<string> {
  const names = new Set<string>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const [token, wrapper] of module.providers) {
      if (typeof token === "symbol") names.add(token.description ?? String(token));
      const instance = wrapper.instance as object | null | undefined;
      if (instance && typeof instance === "object" && instance.constructor !== Object) names.add(instance.constructor.name);
    }
  }
  return names;
}

/** A worker of `role` (WORKER_ROLE unset for `all`), initialised under NODE_ENV=test with Hyperliquid unreachable. */
async function worker(role: "all" | "copy" | "read" | undefined, run: (app: INestApplicationContext) => Promise<void>) {
  vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
  const config = new AppConfig(validateEnvironment(environment({ IS_WORKER: "true", ...(role ? { WORKER_ROLE: role } : {}) })));
  expect(config.value.app.workerRole).toBe(role ?? "all");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const { AppModule } = await import("../src/app.module.js");
  const ref = await Test.createTestingModule({ imports: [AppModule.worker(config.value.app.workerRole)] }).overrideProvider(AppConfig).useValue(config).compile();
  const app = await ref.init();
  try {
    for (const job of app.get(SchedulerRegistry, { strict: false }).getCronJobs().values()) void job.stop();
    await run(app);
  } finally { await app.close(); }
}

/** The read side's schedules: none may exist on a `copy` worker. */
const READ_SCHEDULES = ["SchedulerService.snapshotAll", "SchedulerService.hourly", "SchedulerService.catchUp", "SchedulerService.backfillTick",
  "TradersWorker.historyTick", "TradersWorker.ingestTick", "TradersWorker.trackedTick", "DiscoveryWorker.performanceTick", "DiscoveryWorker.ledgerTick",
  "CohortWorker.cohortTick", "BackfillWorker.scheduledTick", "RevenueWorker.hourlySnapshot", "ArchiveIngestWorker.archiveTick", "RetentionWorker.tick", "OutboxService.drain"];
/** What only real-money work constructs: none may exist on a `read` worker. */
const COPY_ONLY = ["LIVE_ENGINE", "CopyLiveWorkerService", "CopyLiveSetupService", "CopyLiveSetupAbortService", "CopyFundingMonitor", "CopyLiveApiSettlementService",
  "CopyFundingExchangeClient", "AGENT_APPROVAL_CLIENT", "ACCOUNT_MODE_CLIENT", "WORKER_MASTER_SIGNER", "PrivyPolicyMasterSigner", "PrivyAgentApprovalClient", "PrivyAccountModeClient",
  "CopyAccountModeService", "CopyAgentService", "CopyFundingService", "WatcherRuntime", "FeedMonitorService", "CopySetupDueListener"];

const roleGraphs: Partial<Record<"copy" | "read", { providers: Set<string>; schedules: string[] }>> = {};

it("WORKER_ROLE=copy constructs no scheduler, traders, discovery, cohort or other read-side cron, and runs the feed and the live loops", async () => {
  await worker("copy", async (app) => {
    const providers = providerNames(app), schedules = scheduledProviders(app);
    roleGraphs.copy = { providers, schedules };
    for (const name of READ_SCHEDULES) expect(schedules, name).not.toContain(name);
    for (const type of [SchedulerService, TradersWorker, BackfillWorker, OutboxService, TelegramBotService, RulesSeedService, CopyWorkerService,
      CopyFollowerMonitor, CopyFollowerSnapshotCollector, RevenueWorker]) expect(() => app.get(type, { strict: false }), type.name).toThrow();
    for (const name of ["DiscoveryWorker", "CohortWorker", "LeaderboardIngestService", "ArchiveIngestWorker", "RetentionWorker", "DiscoveryPoolService"]) expect(providers, name).not.toContain(name);
    // Its schedules are the feed's own; its loops are the live ones.
    expect(schedules).toEqual(["FeedMonitorService.checkFeed", "FeedMonitorService.refreshMarkets"]);
    for (const name of COPY_ONLY) expect(providers, name).toContain(name);
    for (const type of [WatcherService, TradeFeedService, CopyFundingMonitor, WorkerHeartbeatService]) expect(app.get(type, { strict: false }), type.name).toBeTruthy();
    expect((await app.get(WorkerHeartbeatService).heartbeat()).worker).toEqual({ role: "copy", leases: [1], terminalSettlement: false });
  });
});

it("WORKER_ROLE=read constructs no live engine, exchange client, signer or setup driver, and never starts a trade feed", async () => {
  const start = vi.spyOn(TradeFeedService.prototype, "start");
  const watch = vi.spyOn(WatcherService.prototype, "start");
  try {
    await worker("read", async (app) => {
      const providers = providerNames(app), schedules = scheduledProviders(app);
      roleGraphs.read = { providers, schedules };
      for (const name of COPY_ONLY) expect(providers, name).not.toContain(name);
      expect([...providers].filter((name) => /ExchangeClient|MasterSigner|ApprovalClient|AccountModeClient|LiveEngine|LiveSetup|LiveWorker|LiveSettl/.test(name))).toEqual([]);
      expect(schedules).toEqual(expect.arrayContaining(READ_SCHEDULES));
      expect(schedules.filter((name) => name.startsWith("FeedMonitorService."))).toEqual([]);
      for (const type of [SchedulerService, TradersWorker, BackfillWorker, OutboxService, CopyWorkerService, CopyFollowerMonitor, CopyFollowerSnapshotCollector, RevenueWorker])
        expect(app.get(type, { strict: false }), type.name).toBeTruthy();
      expect(() => app.get(CopyFundingMonitor, { strict: false })).toThrow();
      expect((await app.get(WorkerHeartbeatService).heartbeat()).worker).toEqual({ role: "read", leases: [2], terminalSettlement: false });
    });
    expect(start).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  } finally { start.mockRestore(); watch.mockRestore(); }
});

it("WORKER_ROLE unset is `all`: today's worker, exactly the copy and the read worker together, holding both leases", async () => {
  await worker(undefined, async (app) => {
    const providers = providerNames(app), schedules = scheduledProviders(app);
    for (const type of BACKGROUND) expect(app.get(type, { strict: false }), type.name).toBeTruthy();
    for (const name of [...COPY_ONLY, ...READ_SCHEDULES.map((s) => s.split(".")[0]!)]) expect(providers, name).toContain(name);
    expect(schedules).toEqual([...new Set([...roleGraphs.copy!.schedules, ...roleGraphs.read!.schedules])].sort());
    expect([...providers].sort()).toEqual([...new Set([...roleGraphs.copy!.providers, ...roleGraphs.read!.providers])].sort());
    expect((await app.get(WorkerHeartbeatService).heartbeat()).worker).toEqual({ role: "all", leases: [1, 2], terminalSettlement: false });
  });
});

it("WORKER_ROLE is a worker setting: refused on the api, and anything but all, copy or read is refused", () => {
  expect(() => validateEnvironment(environment({ WORKER_ROLE: "copy" }))).toThrow(/WORKER_ROLE applies to the worker only/);
  expect(() => validateEnvironment(environment({ IS_WORKER: "true", WORKER_ROLE: "both" }))).toThrow(/WORKER_ROLE must be all, copy or read/);
  expect(validateEnvironment(environment({ IS_WORKER: "true", WORKER_ROLE: " Copy " })).app.workerRole).toBe("copy");
});
