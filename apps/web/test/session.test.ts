import { afterEach, expect, it, vi } from "vitest";
import { api, sessionKey, setAccessTokenGetter, takeAnonymousReads } from "../src/lib/api";

afterEach(() => { vi.unstubAllGlobals(); setAccessTokenGetter(null); });

it("discards a delayed token result from a previous identity before sending", async () => {
  let release!: (token: string) => void;
  setAccessTokenGetter(() => new Promise<string>((resolve) => { release = resolve; }), "alice");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const pending = api.get("/me");
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  setAccessTokenGetter(async () => "bob-token", "bob");
  release("alice-token");
  await rejected;
  expect(fetcher).not.toHaveBeenCalled();
});

it("aborts a request when identity changes even if the query omitted a signal", async () => {
  setAccessTokenGetter(async () => "alice-token", "alice");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    started();
  })));
  const pending = api.get("/me/favorites");
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  setAccessTokenGetter(async () => null, "anonymous");
  await rejected;
});

it("isolates identical query keys and late mutation writes between sessions", async () => {
  const { createSessionQueryClient } = await import("../src/lib/session-query-client");
  const alice = createSessionQueryClient();
  const bob = createSessionQueryClient();
  alice.setQueryData(["favorites"], ["alice-private"]);
  alice.setQueryData(["telegram"], { chat: "alice-chat" });
  let finish!: (value: string) => void;
  const pending = alice.fetchQuery({ queryKey: ["me"], queryFn: () => new Promise<string>((resolve) => { finish = resolve; }) });
  const cancelled = pending.catch(() => "cancelled");
  alice.clear();
  finish("alice-profile");
  await cancelled;
  // A previously submitted mutation can finish, but its captured client is retired.
  alice.setQueryData(["favorites"], ["late-alice-result"]);
  expect(bob.getQueryData(["favorites"])).toBeUndefined();
  expect(bob.getQueryData(["telegram"])).toBeUndefined();
  expect(bob.getQueryData(["me"])).toBeUndefined();
  alice.clear(); bob.clear();
});

it("keeps a request running when a loading session turns out to be anonymous", async () => {
  setAccessTokenGetter(async () => null, "loading");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let respond!: () => void;
  vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    respond = () => resolve(new Response(null, { status: 204 }));
    started();
  })));
  const pending = api.delete("/me/favorites/0x0000000000000000000000000000000000000000");
  setAccessTokenGetter(async () => null, "anonymous");
  await ready;
  respond();
  await expect(pending).resolves.toBeUndefined();
});

it("holds a loading session's request until the visitor is known, then sends it once with their token", async () => {
  setAccessTokenGetter(async () => "alice-token", "loading");
  const key = sessionKey();
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const pending = api.delete("/me/favorites/0x0000000000000000000000000000000000000000");
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
  setAccessTokenGetter(async () => "alice-token", "alice");
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
  const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer alice-token");
  expect(sessionKey()).toBe(key);
});

it("a public read does not wait for the identity provider: it goes out at once, without a token (review 30)", async () => {
  // A saved session whose provider never becomes ready (blocked, offline).
  const getter = vi.fn(() => new Promise<string>(() => undefined));
  setAccessTokenGetter(getter, "loading");
  takeAnonymousReads();
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  for (const path of ["/discover/home", "/traders/0x0000000000000000000000000000000000000000", "/traders?limit=20", "/insights/crowd", "/actions?scope=all&limit=20", "/settings"]) {
    await api.get(path).catch(() => undefined); // the stub's body is not a valid answer; only the request matters
  }
  expect(fetcher).toHaveBeenCalledTimes(6);
  for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect((call[1].headers as Record<string, string>).Authorization).toBeUndefined();
  }
  expect(getter).not.toHaveBeenCalled();
  // Reported once, so the provider can refetch when the visitor is signed in.
  expect(takeAnonymousReads()).toBe(true);
  expect(takeAnonymousReads()).toBe(false);
});

it("what needs the caller still waits while the provider is loading: /me, admin, the favorites feed and every write", async () => {
  setAccessTokenGetter(async () => "alice-token", "loading");
  takeAnonymousReads();
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const pending = [
    api.get("/me"), api.get("/me/favorites"), api.get("/admin/overview"), api.get("/actions?limit=20&scope=favorites"),
    api.get("/settingsx"), api.post("/traders/0x0000000000000000000000000000000000000000/anything"),
  ].map((p) => p.catch(() => undefined));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(fetcher).not.toHaveBeenCalled();
  expect(takeAnonymousReads()).toBe(false);
  setAccessTokenGetter(async () => "alice-token", "alice");
  await Promise.all(pending);
  expect(fetcher).toHaveBeenCalledTimes(6);
  for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer alice-token");
  }
});

it("changes the session key only on a real identity change", () => {
  setAccessTokenGetter(async () => null, "anonymous");
  const anonymous = sessionKey();
  setAccessTokenGetter(async () => null, "anonymous");
  expect(sessionKey()).toBe(anonymous);
  setAccessTokenGetter(async () => "alice-token", "alice");
  expect(sessionKey()).not.toBe(anonymous);
});
