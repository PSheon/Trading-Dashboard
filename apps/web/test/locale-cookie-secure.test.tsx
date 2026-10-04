// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.orbie.fun/settings" }
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { en } from "../src/i18n/messages/en";
import { I18nProvider, useI18n } from "../src/i18n/provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

it("marks the language cookie Secure on an https page", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const writes: string[] = [];
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: (value: string) => { writes.push(value); } });
  let setLocale!: (locale: "ja") => void;
  function Probe() { setLocale = useI18n().setLocale; return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><Probe /></I18nProvider>));
  await act(async () => setLocale("ja"));
  expect(writes.at(-1)).toMatch(/^locale=ja;.*; secure$/);
  await act(async () => root.unmount());
  delete (document as unknown as Record<string, unknown>).cookie;
});
