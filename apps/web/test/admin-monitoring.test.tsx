import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MonitoringDetails, RetentionPanel } from "@/components/admin/monitoring";
import { systemOverview } from "@/fixtures/admin";
import { zhTW } from "@/i18n/messages/zh-TW";
import { adminSystemSchema } from "@trading-dashboard/shared/contracts";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
it("shows unavailable telemetry explicitly instead of reporting empty queues", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><MonitoringDetails data={{
    sampledAt: new Date().toISOString(), api: { state: "active", uptimeSeconds: 60, budget: { requestsLastMinute: 2, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null, queued: {live: 0, background: 0} } },
    worker: { state: "standby", sample: null }, database: {state: "unavailable", latencyMs: null}, data: null, outbox: null,
  }} /></I18nProvider>);
  expect(html).toContain('data-slot="data-list"');
  expect(html).toContain("Standby");
  expect(html).toContain("Unavailable");
  expect(html).toContain("Queue data unavailable");
  expect(html).not.toContain("0 pending");
});

it("shows the retention job's last run and the rows it removed per table (review findings 3 and 20)", () => {
  const retention = adminSystemSchema.parse(JSON.parse(JSON.stringify(systemOverview()))).retention!;
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><RetentionPanel retention={retention} /></I18nProvider>);
  expect(html).toContain("Data retention");
  expect(html).toContain("Complete");
  // UTC, like every time on the site.
  expect(html).toContain("10/01/2026, 18:07");
  expect(html).toContain("Position snapshots");
  expect(html).toContain("15,604");
  expect(html).toContain("Alert delivery records");
  expect(html).toContain("kept since 09/01/2026, 18:07");

  const zh = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><RetentionPanel retention={{ ...retention!, lastStatus: "partial", removed: { position_snapshots: 500_000 } }} /></I18nProvider>);
  expect(zh).toContain("已達單次上限，下次接續");
  expect(zh).toContain("500,000");
  // A table the run did not get to is said so, not shown as 0.
  expect(zh).toContain("未執行到");
});

it("says so when the job has never run or its status cannot be read, and an older api without the field shows no panel", () => {
  const never = { running: false, lastStartedAt: null, lastFinishedAt: null, lastStatus: null, removed: null, cutoffs: null, lastError: null, durationMs: null };
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><RetentionPanel retention={never} /></I18nProvider>);
  expect(html).toContain("Has not run yet");
  expect(renderToStaticMarkup(<I18nProvider locale="en" messages={en}><RetentionPanel retention={null} /></I18nProvider>)).toContain("Retention status unavailable");
  const failed = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><RetentionPanel retention={{ ...never, lastStatus: "failed", lastError: "lease lost", lastFinishedAt: "2026-10-01T18:07:42.000Z" }} /></I18nProvider>);
  expect(failed).toContain("Failed");
  expect(failed).toContain("lease lost");
  const old = JSON.parse(JSON.stringify(systemOverview()));
  delete old.retention;
  expect(renderToStaticMarkup(<I18nProvider locale="en" messages={en}><MonitoringDetails data={adminSystemSchema.parse(old)} /></I18nProvider>)).not.toContain("Data retention");
});
