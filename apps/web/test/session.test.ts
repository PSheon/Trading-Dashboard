import { afterEach, expect, it, vi } from "vitest";
import { api, setAccessTokenGetter } from "../src/lib/api";

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
  await ready;
  setAccessTokenGetter(async () => null, "anonymous");
  respond();
  await expect(pending).resolves.toBeUndefined();
});

it("still aborts a loading session's requests when the visitor turns out to be signed in", async () => {
  setAccessTokenGetter(async () => null, "loading");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    started();
  })));
  const pending = api.get("/traders");
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  setAccessTokenGetter(async () => "alice-token", "alice");
  await rejected;
});
