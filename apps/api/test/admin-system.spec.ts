import { afterEach, expect, it, vi } from "vitest";
import { adminSystemSchema } from "@trading-dashboard/shared/contracts";
import { AdminSystemService } from "../src/admin/admin-system.service.js";
import { AppConfig } from "../src/config/app-config.js";
import { testConfig } from "./config-test-utils.js";

const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
function setup() {
  const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue({ leaderboardCount: 0, leaderboardUpdatedAt: null, watched: 0, candidates: 0, portfolios: 0, trades: 0, errors: 0, oldestPortfolioAt: null, newestPortfolioAt: null }), outbox: vi.fn().mockResolvedValue([]),
    retention: vi.fn().mockResolvedValue({ running: false, lastStartedAt: null, lastFinishedAt: null, lastStatus: null, removed: null, cutoffs: null, lastError: null, durationMs: null }) };
  const config = new AppConfig({ ...testConfig().value, app: { ...testConfig().value.app, role: "api", workerUrl: "http://worker:3000" } });
  const service = new AdminSystemService(repository as never, config, { introspect: () => budget, queued: () => ({live: 0, background: 0}) } as never);
  return { service, repository };
}
afterEach(() => { vi.unstubAllGlobals(); });
it("keeps standby distinct from active and reports failed database sections as unknown", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "standby", instanceId: "worker-2", sampledAt: new Date().toISOString(), uptimeSeconds: 3, budget: null, heartbeat: null }) }));
  const { service, repository } = setup();
  repository.probe.mockRejectedValue(new Error("password=must-not-leak"));
  repository.data.mockRejectedValue(new Error("query failed"));
  const result = await service.overview();
  expect(result.api.state).toBe("active");
  expect(result.worker.state).toBe("standby");
  expect(result.database).toEqual({ state: "unavailable", latencyMs: null });
  expect(result.data).toBeNull();
  expect(result.outbox).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
});
it("rejects malformed worker responses and shares concurrent polls", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "active" }) });
  vi.stubGlobal("fetch", fetcher);
  const { service, repository } = setup();
  const [a, b] = await Promise.all([service.overview(), service.overview()]);
  expect(a.worker.state).toBe("unavailable");
  expect(a).toEqual(b);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(repository.data).toHaveBeenCalledTimes(1);
});
it("does not present an old worker sample as current", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "standby", instanceId: "old", sampledAt: new Date(Date.now() - 120_000).toISOString(), uptimeSeconds: 3, budget: null, heartbeat: null }) }));
  const { service } = setup();
  expect((await service.overview()).worker.state).toBe("stale");
});
it("shows the switches the api and the worker were started with, and nothing secret (review finding 19)", async () => {
  const switches = { appRole: "worker", copyTradingMode: "paper", hyperliquidNetwork: "mainnet", telegramDryRun: false, archiveEnabled: true, archiveMaxDailyUsd: 5, maxFavoritesPerUserDefault: 100 };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "standby", instanceId: "worker-3", sampledAt: new Date().toISOString(), uptimeSeconds: 3, budget: null, heartbeat: null, switches }) }));
  vi.stubEnv("TELEGRAM_DRY_RUN", "true");
  vi.stubEnv("COPY_TRADING_MODE", "disabled");
  vi.stubEnv("MAX_FAVORITES_PER_USER", "40");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:secret-bot-token-must-not-leak");
  try {
    const { service } = setup();
    const result = adminSystemSchema.parse(await service.overview());
    // The api's own environment…
    expect(result.api.switches).toEqual({ appRole: "api", copyTradingMode: "disabled", hyperliquidNetwork: "testnet", telegramDryRun: true, archiveEnabled: false, archiveMaxDailyUsd: 2, maxFavoritesPerUserDefault: 40 });
    // …and the worker's, which is a separate process and may differ.
    expect(result.worker.sample?.switches).toEqual(switches);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  } finally { vi.unstubAllEnvs(); }
});
it("a worker that predates the switches is still a valid sample", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "standby", instanceId: "old-build", sampledAt: new Date().toISOString(), uptimeSeconds: 3, budget: null, heartbeat: null }) }));
  const { service } = setup();
  const result = await service.overview();
  expect(result.worker.state).toBe("standby");
  expect(result.worker.sample?.switches).toBeUndefined();
});
