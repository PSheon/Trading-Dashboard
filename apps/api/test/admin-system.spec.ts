import { afterEach, expect, it, vi } from "vitest";
import { AdminSystemService } from "../src/admin/admin-system.service.js";
import { AppConfig } from "../src/config/app-config.js";
import { testConfig } from "./config-test-utils.js";

const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
function setup() {
  const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue({ leaderboardCount: 0, leaderboardUpdatedAt: null, watched: 0, candidates: 0, portfolios: 0, trades: 0, errors: 0, oldestPortfolioAt: null, newestPortfolioAt: null }), outbox: vi.fn().mockResolvedValue([]) };
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
