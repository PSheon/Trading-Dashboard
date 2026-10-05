import { expect, it } from "vitest";

import { fixtureRequest } from "@/fixtures/handler";
import { findHttpContract, publicHealthSchema } from "@/lib/contracts";

it("GET /health is the three-field public status; the full heartbeat is only in the admin system overview", async () => {
  expect(findHttpContract("GET", "/health")?.response).toBe(publicHealthSchema);
  // GET /admin/system/heartbeat had no caller and was removed (2026-10-05).
  expect(findHttpContract("GET", "/admin/system/heartbeat")).toBeUndefined();
  const anonymous = await fixtureRequest<Record<string, unknown>>("GET", "/health", undefined, null);
  expect(Object.keys(publicHealthSchema.strict().parse(anonymous)).sort()).toEqual(["feedConnected", "now", "status"]);
});
