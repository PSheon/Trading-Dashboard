import { afterEach, expect, it, vi } from "vitest";
import { api, setAccessTokenGetter } from "../src/lib/api";
import { findHttpContract } from "@trading-dashboard/shared/contracts";
import { fixtureRequest } from "../src/fixtures/handler";
import { initialFavorites } from "../src/fixtures/data";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); setAccessTokenGetter(null); });
const data = { id: "9007199254740993", chain: "hyperliquid", address: "0xabc", coin: "BTC", kind: "open", side: "long", notionalUsd: "1", avgPx: "1", fillIds: [], ts: "2026-01-01T00:00:00.000Z" };
it("negotiates v1 and unwraps a validated JSON DTO", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true, statusCode: 200, message: "OK", data: [data], meta: { requestId: "id", path: "/actions" } }, { headers: { "x-api-contract": "1" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(await api.get("/actions")).toEqual([data]);
  expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-api-contract": "1" });
});
it("accepts valid legacy data during rollout but rejects malformed v1/domain data", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([data])));
  expect(await api.get("/actions")).toEqual([data]);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ ...data, id: 9007199254740992 }])));
  await expect(api.get("/actions")).rejects.toMatchObject({ code: "invalid_response" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([data], { headers: { "x-api-contract": "1" } })));
  await expect(api.get("/actions")).rejects.toMatchObject({ code: "invalid_response" });
});
it("preserves error code, details and normalized field paths", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false, statusCode: 409, message: "Limit", error: { code: "alert_limit", details: { limit: 3 }, fields: [{ path: "rows.0.address", message: "Invalid" }] }, meta: { requestId: "id", path: "/me" } }, { status: 409 })));
  await expect(api.get("/me")).rejects.toMatchObject({ code: "alert_limit", details: { limit: 3 }, message: "Limit (rows.0.address: Invalid)" });
});
it("fixtures obey the same transport schemas as network responses", async () => {
  for (const path of ["/traders", `/traders/${initialFavorites[0]}`, `/traders/${initialFavorites[0]}/fills`, `/traders/${initialFavorites[0]}/analytics?window=30d`, `/traders/${initialFavorites[0]}/trades?status=closed&limit=5`, "/actions", "/alerts", "/health", "/me", "/me/favorites", "/me/telegram", "/insights/crowd", "/settings", "/admin/users", "/admin/settings", "/admin/overview", "/admin/revenue"]) {
    const result = await fixtureRequest("GET", path, undefined, "fixture-admin");
    const parsed = findHttpContract("GET", path)!.response.safeParse(result);
    expect(parsed.success, `${path}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
  }
});

it("fixture deletion returns no content through the real client wrapper", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_FIXTURES", "1");
  setAccessTokenGetter(async () => "fixture-admin", "fixture");
  expect(await api.delete(`/me/favorites/${initialFavorites[0]}`)).toBeUndefined();
  expect(await api.delete("/me/telegram")).toBeUndefined();
});
