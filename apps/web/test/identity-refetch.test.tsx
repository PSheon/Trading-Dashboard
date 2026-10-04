// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { api, setAccessTokenGetter, takeAnonymousReads } from "../src/lib/api";
import type { AuthStatus } from "../src/lib/auth";
import { useIdentityRefetch } from "../src/lib/use-identity-refetch";
import { settleQueries } from "./query-settle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A public read whose answer depends on who asked, like a trader's favorite flag. */
let token: string | null;
const read = vi.fn(async () => (token ? "favorite: yes" : "favorite: unknown"));

function Page({ status }: { status: AuthStatus }) {
  useIdentityRefetch(status);
  const { data } = useQuery({ queryKey: ["trader"], queryFn: read, staleTime: 60_000, refetchInterval: false });
  return <p>{data ?? "placeholder"}</p>;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
async function render(status: AuthStatus) {
  await act(async () => { root.render(<QueryClientProvider client={client}><Page status={status} /></QueryClientProvider>); });
  await settleQueries(client, { ms: 20 });
}

beforeEach(() => {
  token = null;
  read.mockClear();
  client = new QueryClient();
  container = document.createElement("div");
  root = createRoot(container);
  takeAnonymousReads();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.unstubAllGlobals();
  setAccessTokenGetter(null);
});

/** One public read sent while the provider is loading, as the page's queries do. */
async function publicReadWhileLoading() {
  setAccessTokenGetter(async () => token, "loading");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  await api.get("/discover/home").catch(() => undefined);
}

it("shows public data while the provider loads, then refetches it once the visitor turns out to be signed in (review 30)", async () => {
  await publicReadWhileLoading();
  await render("loading");
  expect(container.textContent).toBe("favorite: unknown"); // not a placeholder
  token = "alice-token";
  await render("signedIn");
  expect(container.textContent).toBe("favorite: yes");
  expect(read).toHaveBeenCalledTimes(2);
  // Only once: a later render does not refetch again.
  await render("signedIn");
  expect(read).toHaveBeenCalledTimes(2);
});

it("refetches nothing for a visitor who turns out to be signed out, or when nothing was read early", async () => {
  await publicReadWhileLoading();
  await render("loading");
  await render("signedOut");
  expect(read).toHaveBeenCalledTimes(1);

  await render("loading");
  await render("signedIn"); // the flag was consumed above: nothing went out anonymously since
  expect(read).toHaveBeenCalledTimes(1);
});
