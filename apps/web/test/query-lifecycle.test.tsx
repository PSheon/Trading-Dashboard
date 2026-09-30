// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api, setAccessTokenGetter } from "../src/lib/api";
import { useUpdateAdminUser } from "../src/lib/admin-users";
import { queryKeys } from "../src/lib/query-keys";
import { createSessionQueryClient } from "../src/lib/session-query-client";
import { traderProfileOptions } from "../src/lib/trader-query-options";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setAccessTokenGetter(null); });

it("cancels the actual HTTP request when a profile query is retired", async () => {
  setAccessTokenGetter(null, "anonymous");
  const client = createSessionQueryClient();
  let requestSignal: AbortSignal | null | undefined;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    requestSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    started();
  })));
  try {
    const result = client.fetchQuery(traderProfileOptions("0x123")).catch(() => "cancelled");
    await ready;
    await client.cancelQueries({ queryKey: queryKeys.trader.all });
    expect(requestSignal?.aborted).toBe(true);
    expect(await result).toBe("cancelled");
    expect(client.getQueryData(queryKeys.trader.profile("0x123"))).toBeUndefined();
  } finally { client.clear(); }
});

it("deduplicates concurrent profile consumers with shared options", async () => {
  const client = createSessionQueryClient();
  let release!: () => void;
  const get = vi.spyOn(api, "get").mockImplementation(() => new Promise(resolve => { release = () => resolve({ address: "0x123" }); }));
  try {
    const featured = client.fetchQuery({ ...traderProfileOptions("0x123"), staleTime: 60000 });
    const detail = client.fetchQuery(traderProfileOptions("0x123"));
    expect(get).toHaveBeenCalledTimes(1);
    // A payload sentinel is sufficient here: this test exercises query sharing, not wire validation.
    release();
    expect(await featured).toEqual(await detail);
  } finally { client.clear(); }
});

it("invalidates every cached admin user page after an update without touching other admin data", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = createSessionQueryClient();
  const root = createRoot(document.createElement("div"));
  const first = queryKeys.admin.users.list("limit=20&offset=0");
  const filtered = queryKeys.admin.users.list("limit=20&offset=20&role=admin");
  client.setQueryData(first, { items: [], total: 40 });
  client.setQueryData(filtered, { items: [], total: 40 });
  client.setQueryData(queryKeys.admin.settings, { version: 1 });
  vi.spyOn(api, "patch").mockResolvedValue({ id: 2, role: "admin" });
  let update!: ReturnType<typeof useUpdateAdminUser>;
  function Probe() { update = useUpdateAdminUser(); return null; }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    await act(async () => { await update.mutateAsync({ id: 2, patch: { role: "admin" } }); });
    expect(client.getQueryState(first)?.isInvalidated).toBe(true);
    expect(client.getQueryState(filtered)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.admin.settings)?.isInvalidated).toBe(false);
  } finally { await act(async () => root.unmount()); client.clear(); }
});
