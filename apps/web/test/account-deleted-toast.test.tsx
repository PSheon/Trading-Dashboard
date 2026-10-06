// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AccountDeletedToast } from "@/components/home/account-deleted-toast";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import { LOCALES } from "@/i18n/config";

/** `/?accountDeleted=1` (logic review 2026-10-06 §C): the home page says the
 * account was deleted, once, and drops the flag from the address. */
const state = vi.hoisted(() => ({ search: "accountDeleted=1&ref=x", replace: vi.fn(), success: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: state.replace, refresh() {}, push() {} }), usePathname: () => "/zh-TW", useSearchParams: () => new URLSearchParams(state.search) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: state.success }) }));

let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = () => act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs["zh-TW"]}><AccountDeletedToast /></I18nProvider>));

it("toasts once and removes only the flag from the address", async () => {
  state.search = "accountDeleted=1&ref=x";
  await render(); await render();
  expect(state.success).toHaveBeenCalledExactlyOnceWith("你的 Orbie 帳號已刪除。");
  expect(state.replace).toHaveBeenCalledExactlyOnceWith("/zh-TW?ref=x", { scroll: false });
});

it("says nothing without the flag, and every language has the text", async () => {
  state.search = "";
  await render();
  expect(state.success).not.toHaveBeenCalled();
  for (const locale of LOCALES) expect(catalogs[locale].deleteAccount.done.trim(), locale).not.toBe("");
});
