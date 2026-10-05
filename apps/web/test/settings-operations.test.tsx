import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { runtimeStatus } from "../src/components/admin/overview";
import { AuditEntries } from "../src/components/admin/audit";
import type { SettingsRuntime } from "@/lib/contracts";
vi.mock("@/i18n/provider", () => ({ useI18n: () => ({ t: (key: string) => key, format: { dateTime: String } }) }));
const revision = "a".repeat(64);
const data: SettingsRuntime = { savedRevision: revision, state: "active", instanceId: "worker-a", sampledAt: "2026-09-30T12:00:00Z", consumers: [{ consumer: "pool", revision, checkedAt: "2026-09-30T11:59:30Z", recovered: false, candidatePoolSize: 500, poolWeightPerMinute: 120, leaderboardRefreshMinutes: 15 }] };
it("requires a current healthy consumer acknowledgement, including after restart", () => {
  expect(runtimeStatus(data, "pool")).toBe("applied");
  for (const value of [{ ...data, state: "unavailable" as const }, { ...data, consumers: [] }]) expect(runtimeStatus(value, "pool")).toBe("unknown");
  expect(runtimeStatus(data, "leaderboard")).toBe("unknown");
  expect(runtimeStatus({ ...data, savedRevision: "b".repeat(64) }, "pool")).toBe("pending");
  expect(runtimeStatus({ ...data, sampledAt: "2026-09-30T12:10:00Z" }, "pool")).toBe("stale");
  expect(runtimeStatus({ ...data, consumers: data.consumers.map(c => ({ ...c, recovered: true })) }, "pool")).toBe("recovered");
});
it("renders audit values as escaped text and preserves IDs beyond JS integer precision", () => {
  const html = renderToStaticMarkup(<AuditEntries items={[{ id: "9007199254740993", actorKind: "system", actorUserId: null, target: "<script>bad()</script>", event: "settings.update", before: null, after: { announcement: "<img src=x onerror=bad()>" }, createdAt: "2026-09-30T12:00:00Z" }]} />);
  expect(html).toContain("9007199254740993");
  expect(html).not.toContain("<script>"); expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;");
});
