// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnnouncementSettings } from "@trading-dashboard/shared/contracts";
import { AnnouncementBanner } from "@/components/shell/announcement-banner";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { zhTW } from "@/i18n/messages/zh-TW";
import { announcementContent, announcementHash } from "@/lib/announcement";

/** Stored before label/summary/href existed: one text. */
const TEXT = "Orbie is in open beta.";
const LEGACY: AnnouncementSettings = { enabled: true, text: { "zh-TW": "公開測試中", en: TEXT } };
const SPLIT: AnnouncementSettings = {
  enabled: true,
  text: { "zh-TW": "探索交易員、接收提醒、選擇跟單模式。", en: "Explore traders, get alerts, choose a copy mode." },
  label: { "zh-TW": "公開測試", en: "Public beta" },
  summary: { "zh-TW": "探索交易員、接收提醒、選擇跟單模式。", en: "Explore traders, get alerts, choose a copy mode." },
  href: "/help#beta",
};
let announcement: AnnouncementSettings = LEGACY;
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/queries", () => ({ useSiteSettings: () => ({ data: { announcement } }) }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.cookie = "announcement-dismissed=; max-age=0; path=/";
  localStorage.clear();
  announcement = LEGACY;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = (dismissed: string | null, locale: "en" | "zh-TW" = "en") =>
  act(async () => root.render(
    <I18nProvider locale={locale} messages={locale === "en" ? en : zhTW}><AnnouncementBanner dismissed={dismissed} /></I18nProvider>,
  ));
const summary = () => container.querySelector<HTMLElement>("[data-testid=announcement-summary]");
const more = () => container.querySelector<HTMLAnchorElement>("a");
const close = () => container.querySelector<HTMLButtonElement>("button")!;

it("is one line: pill, phrase (from md up), Learn more, close", async () => {
  announcement = SPLIT;
  await render(null);
  const banner = container.querySelector("[data-testid=announcement-banner]")!;
  expect(banner.className).toContain("h-9");
  expect(banner.className).toContain("rounded-full");
  expect(banner.className).toContain("bg-raised");
  expect(banner.className).not.toContain("tag-alert");
  expect(banner.textContent).toContain("Announcement: Public beta");
  // Desktop shows the phrase; phones hide it (`hidden md:inline`).
  expect(summary()!.textContent).toBe(SPLIT.summary!.en);
  expect(summary()!.className).toMatch(/(^| )hidden( |$)/);
  expect(summary()!.className).toContain("md:inline");
  expect(more()!.textContent).toBe("Learn more ›");
  expect(more()!.getAttribute("href")).toBe("/en/help#beta");
  expect(close().getAttribute("aria-label")).toBe("Close announcement");
});

it("renders an announcement stored as a single text: default pill, the text as the phrase, Learn more to /help", async () => {
  await render(null);
  expect(container.textContent).toContain("Public beta");
  expect(summary()!.textContent).toBe(TEXT);
  expect(more()!.getAttribute("href")).toBe("/en/help");
});

it("uses zh-TW text and defaults in zh-TW", async () => {
  await render(null, "zh-TW");
  expect(container.textContent).toContain("公告: 公開測試");
  expect(summary()!.textContent).toBe("公開測試中");
  expect(more()!.textContent).toBe("了解更多 ›");
  expect(close().getAttribute("aria-label")).toBe("關閉公告");
});

it("is drawn from the first frame and remembers a dismissal in a cookie", async () => {
  await render(null);
  expect(container.textContent).toContain(TEXT);
  await act(async () => close().click());
  expect(container.textContent).toBe("");
  // A single-text announcement keeps its pre-split hash: old dismissals hold.
  expect(document.cookie).toContain(`announcement-dismissed=${announcementHash(TEXT)}`);
});

it("is never drawn when the server read this announcement's dismissal from the cookie", async () => {
  await render(announcementHash(TEXT));
  expect(container.textContent).toBe("");
});

it("is never drawn when the cookie holds this label/phrase/link's dismissal", async () => {
  announcement = SPLIT;
  await render(announcementContent(SPLIT, "en")!.hash);
  expect(container.textContent).toBe("");
});

it("shows again when the label, phrase or link changes", async () => {
  const dismissed = announcementContent(SPLIT, "en")!.hash;
  for (const edit of [{ label: { ...SPLIT.label!, en: "Beta" } }, { summary: { ...SPLIT.summary!, en: "New" } }, { href: "/about" }]) {
    announcement = { ...SPLIT, ...edit };
    await render(dismissed);
    expect(container.querySelector("[data-testid=announcement-banner]")).not.toBeNull();
  }
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

it("opens an https link in a new tab", async () => {
  announcement = { ...SPLIT, href: "https://example.com/beta" };
  await render(null);
  expect(more()!.getAttribute("href")).toBe("https://example.com/beta");
  expect(more()!.getAttribute("target")).toBe("_blank");
});
