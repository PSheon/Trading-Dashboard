import { expect, it } from "vitest";

import { fixtureRequest } from "@/fixtures/handler";
import { ApiError } from "@/lib/api";
import { findHttpContract, publicHealthSchema, wireHeartbeatSchema } from "@/lib/contracts";

it("GET /health is the three-field public status; the heartbeat detail is an admin route", async () => {
  expect(findHttpContract("GET", "/health")?.response).toBe(publicHealthSchema);
  expect(findHttpContract("GET", "/admin/system/heartbeat")?.response).toBe(wireHeartbeatSchema);
  const anonymous = await fixtureRequest<Record<string, unknown>>("GET", "/health", undefined, null);
  expect(Object.keys(publicHealthSchema.strict().parse(anonymous)).sort()).toEqual(["feedConnected", "now", "status"]);
  // A full heartbeat still parses as the public one, but nothing beyond the three fields survives it.
  const full = wireHeartbeatSchema.parse(await fixtureRequest("GET", "/admin/system/heartbeat", undefined, "token"));
  expect(full).toHaveProperty("dryRun");
  expect(full).toHaveProperty("queuedRequests");
  await expect(fixtureRequest("GET", "/admin/system/heartbeat", undefined, null)).rejects.toBeInstanceOf(ApiError);
});
