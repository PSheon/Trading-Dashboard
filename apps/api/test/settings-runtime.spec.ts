import { expect, it } from "vitest";
import { AdminSettingsRuntimeController } from "../src/admin/admin-settings-runtime.controller.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { AdminSystemService } from "../src/admin/admin-system.service.js";
it("keeps saved and consumer revisions separate and does not acknowledge on monitor reads", async () => {
  const settings = { getSnapshot: async () => ({ revisions: { discovery: "new" } }) } as unknown as SettingsService;
  const sample = { state: "stale", sample: { instanceId: "old-worker", settings: [{ consumer: "pool", revision: "old" }] } };
  const system = { overview: async () => ({ api: { state: "active" }, sampledAt: "2026-09-30T12:00:00Z", worker: sample }) } as unknown as AdminSystemService;
  expect(await new AdminSettingsRuntimeController(settings, system).get()).toMatchObject({ savedRevision: "new", state: "stale", instanceId: "old-worker", consumers: [{ revision: "old" }] });
});
