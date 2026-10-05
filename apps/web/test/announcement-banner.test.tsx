// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnouncementBanner } from "@/components/shell/announcement-banner";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { announcementHash } from "@/lib/announcement";

const TEXT = "Orbie is in open beta.";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/queries", () => ({
  useSiteSettings: () => ({ data: { announcement: { enabled: true, text: { "zh-TW": "公開測試", en: TEXT } } } }),
}));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.cookie = "announcement-dismissed=; max-age=0; path=/";
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = (dismissed: string | null) =>
  act(async () => root.render(<I18nProvider locale="en" messages={en}><AnnouncementBanner dismissed={dismissed} /></I18nProvider>));

it("is drawn from the first frame and remembers a dismissal in a cookie", async () => {
  await render(null);
  expect(container.textContent).toContain(TEXT);
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toBe("");
  expect(document.cookie).toContain(`announcement-dismissed=${announcementHash(TEXT)}`);
});

it("is never drawn when the server read this text's dismissal from the cookie", async () => {
  await render(announcementHash(TEXT));
  expect(container.textContent).toBe("");
});

it("shows a new text after an older one was dismissed", async () => {
  await render(announcementHash("an older text"));
  expect(container.textContent).toContain(TEXT);
});

it("carries a dismissal saved in localStorage over to the cookie", async () => {
  localStorage.setItem("announcement-dismissed", TEXT);
  await render(null);
  expect(container.textContent).toBe("");
  expect(document.cookie).toContain(`announcement-dismissed=${announcementHash(TEXT)}`);
});
