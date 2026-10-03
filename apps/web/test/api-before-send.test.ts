import { afterEach, expect, it, vi } from "vitest";
import { api, setAccessTokenGetter } from "@/lib/api";
afterEach(() => { vi.unstubAllGlobals(); setAccessTokenGetter(null); });
it.each(["expiry", "account revision"])("checks %s after delayed token acquisition before the actual POST", async () => {
  let finish!: (token: string) => void, stale = false;
  setAccessTokenGetter(() => new Promise(resolve => { finish = resolve; }), "owner");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const pending = api.post("/me/copy/account-modes/original/approve", {}, { beforeSend: () => { if (stale) throw new Error("stale_action"); } });
  const rejected = expect(pending).rejects.toThrow("stale_action"); stale = true; finish("owner-token"); await rejected; expect(fetcher).not.toHaveBeenCalled();
});
it("rejects asynchronous boundary guards rather than ignoring their pending checks", async () => { setAccessTokenGetter(async () => "token", "owner"); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(api.post("/me/copy/account-modes/id/approve", {}, { beforeSend: async () => {} })).rejects.toThrow("invalid_before_send"); expect(fetcher).not.toHaveBeenCalled(); });
it("rechecks session abort caused synchronously by the boundary guard", async () => { setAccessTokenGetter(async () => "token", "owner"); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(api.post("/me/copy/account-modes/id/approve", {}, { beforeSend: () => { setAccessTokenGetter(async () => null, "anonymous"); } })).rejects.toMatchObject({ name: "AbortError" }); expect(fetcher).not.toHaveBeenCalled(); });
it("keeps the existing authenticated no-store POST behavior when the guard passes", async () => { setAccessTokenGetter(async () => "token", "owner"); const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetcher); const guard = vi.fn(); await api.post("/me/copy/account-modes/id/approve", { consentSignature: "signature" }, { beforeSend: guard }); expect(guard).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledWith("/api/hl/me/copy/account-modes/id/approve", expect.objectContaining({ method: "POST", cache: "no-store", headers: expect.objectContaining({ Authorization: "Bearer token" }), body: '{"consentSignature":"signature"}' })); });
it("rejects a failing async callback without leaking an unhandled rejection", async () => { setAccessTokenGetter(async () => "token", "owner"); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(api.post("/me/copy/account-modes/id/approve", {}, { beforeSend: async () => { throw new Error("async_stale"); } })).rejects.toThrow("invalid_before_send"); await new Promise(resolve => setTimeout(resolve, 0)); expect(fetcher).not.toHaveBeenCalled(); });
