// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { api, setAccessTokenGetter } from "../src/lib/api";

const FAVORITE = "/me/favorites/0x0000000000000000000000000000000000000000";

function clearLocaleCookie() {
  document.cookie = "locale=; path=/; max-age=0";
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessTokenGetter(null);
  clearLocaleCookie();
  document.documentElement.lang = "";
});

async function sentLanguage(): Promise<string | undefined> {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  await api.delete(FAVORITE);
  const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
  return (init.headers as Record<string, string>)["Accept-Language"];
}

it("tells the api the language the page is shown in, so a new account is created in it (review 29)", async () => {
  setAccessTokenGetter(async () => "alice-token", "alice");
  document.documentElement.lang = "zh-TW";
  expect(await sentLanguage()).toBe("zh-TW");
  // The language menu writes the cookie first; the document follows on the re-render.
  document.cookie = "locale=en; path=/";
  expect(await sentLanguage()).toBe("en");
});

it("sends nothing it can't vouch for: an unknown cookie falls back to the document, and neither means no header", async () => {
  setAccessTokenGetter(async () => null, "anonymous");
  document.cookie = "locale=klingon; path=/";
  document.documentElement.lang = "ja";
  expect(await sentLanguage()).toBe("ja");
  document.documentElement.lang = "";
  expect(await sentLanguage()).toBeUndefined();
});
