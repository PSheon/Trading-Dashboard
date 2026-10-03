import { afterEach, expect, it, vi } from "vitest";
import { CopyFundingMonitor } from "../src/copy/copy-funding-monitor.service.js";
import { testConfig } from "./config-test-utils.js";
import type { AppConfig } from "../src/config/app-config.js";

afterEach(() => vi.useRealTimers());
function setup(role = "worker", nodeEnv = "development", mode = "disabled") {
  const value = testConfig().value;
  const config = { value: { ...value, app: { ...value.app, role, nodeEnv }, copy: { ...value.copy, mode } } } as AppConfig;
  const funding = { reconcilePending: vi.fn(async () => 0) }, jobs = { stopping: false, run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  return { monitor: new CopyFundingMonitor(config, funding as never, jobs as never), funding, jobs };
}
it("continues read-only confirmation when copying is disabled, and stops its timer on shutdown", async () => {
  vi.useFakeTimers(); const { monitor, funding } = setup(); monitor.onApplicationBootstrap();
  await vi.advanceTimersByTimeAsync(15_000); expect(funding.reconcilePending).toHaveBeenCalledTimes(1);
  monitor.onModuleDestroy(); await vi.advanceTimersByTimeAsync(30_000); expect(funding.reconcilePending).toHaveBeenCalledTimes(1);
});
it.each([["api", "development"], ["worker", "test"]])("does not run background checks in %s/%s", async (role, env) => {
  vi.useFakeTimers(); const { monitor, funding } = setup(role, env); monitor.onApplicationBootstrap(); await vi.advanceTimersByTimeAsync(30_000); expect(funding.reconcilePending).not.toHaveBeenCalled(); monitor.onModuleDestroy();
});
it("skips overlap and shutdown without losing the running check", async () => {
  const { monitor, funding, jobs } = setup(); let finish!: (value: number) => void; funding.reconcilePending.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const tick = monitor.tick(); await monitor.tick(); expect(funding.reconcilePending).toHaveBeenCalledTimes(1); finish(1); await tick;
  jobs.stopping = true; await monitor.tick(); expect(funding.reconcilePending).toHaveBeenCalledTimes(1);
});
