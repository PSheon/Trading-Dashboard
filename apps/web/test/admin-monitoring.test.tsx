import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MonitoringDetails } from "@/components/admin/monitoring";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
it("shows unavailable telemetry explicitly instead of reporting empty queues", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><MonitoringDetails data={{
    sampledAt: new Date().toISOString(), api: { state: "active", role: "api", uptimeSeconds: 60, budget: { requestsLastMinute: 2, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null, queued: {live: 0, background: 0} } },
    worker: { state: "standby", sample: null }, database: {state: "unavailable", latencyMs: null}, data: null, outbox: null,
  }} /></I18nProvider>);
  expect(html).toContain("Standby");
  expect(html).toContain("Unavailable");
  expect(html).toContain("Queue data unavailable");
  expect(html).not.toContain("0 pending");
});
