// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { api, setAccessTokenGetter } from "@/lib/api";
afterEach(() => {
  setAccessTokenGetter(null, "referral-public-end");
  vi.unstubAllGlobals();
});
it("canonical code checking is public during auth startup and uses validated no-store responses", async () => {
  setAccessTokenGetter(null, "referral-public-reset");
  setAccessTokenGetter(null, "loading");
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        meta: {
          requestId: "public-test",
          path: "/referral/check/ABC",
          timestamp: "2026-10-04T00:00:00.000Z",
        },
        statusCode: 200,
        message: "OK",
        data: { code: "ABC", valid: true },
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await api.get("/referral/check/ABC")).toEqual({
    code: "ABC",
    valid: true,
  });
  expect(fetch).toHaveBeenCalledWith(
    "/api/hl/referral/check/ABC",
    expect.objectContaining({
      cache: "no-store",
      headers: expect.not.objectContaining({
        Authorization: expect.anything(),
      }),
    }),
  );
});
it.each([
  "/referral/check/abc",
  "/referral/check/ABC/extra",
  "/referral/check/ABC?owner=1",
])(
  "does not classify arbitrary path %s as anonymous public reads",
  async (path) => {
    // Dynamic import resets the wrapper's auth-startup latch for each independent case.
    vi.resetModules();
    const wrapper = await import("@/lib/api");
    wrapper.setAccessTokenGetter(null, "loading");
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const pending = wrapper.api.get(path);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
    wrapper.setAccessTokenGetter(async () => null, "signed-out");
    await pending;
  },
);
