// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProfileCard } from "../src/components/trader/profile-card";
import { profileFor } from "../src/fixtures/data";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/components/alerts/alert-bell", () => ({ AlertBell: () => null }));
vi.mock("../src/components/traders/bits", () => ({ FavoriteButton: () => null, VaultBadge: () => null }));

const base = () => ({ ...profileFor(`0x${"ab".repeat(20)}`, false), tracked: true, analytics: null, stats: null, fetchedAt: "2026-09-29T10:00:00.000Z", lastTradeAt: null,
  dataQuality: { partial: true, sources: { analytics: { status: "unavailable" as const, asOf: null, stale: false, maxAgeMs: 60000 } } } });

it("does not describe an analytics outage as an unwatched trader or empty coin history", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ProfileCard profile={base()} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
  expect(html).toContain("Couldn&#x27;t load data.");
  expect(html).not.toContain("No closed trades");
  expect(html).not.toContain("isn&#x27;t watched yet");
});

it("keeps CopyDog's rows only: no badges, account breakdown, snapshot sources or extra overview rows", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><ProfileCard profile={base()} allTimeVolume={13_432_038.45} trades={undefined} tradesComputing={false} /></I18nProvider>);
  for (const gone of ["最後交易", "即時", "統一帳戶", "帳戶快照", "以永續權益計算", "可提領", "持倉數", "複製評分", "perp-equity"]) expect(html).not.toContain(gone);
  expect(html).toContain("$13.43M");
  expect(html).not.toContain("萬");
  expect(html).toContain('aria-expanded="false"');
});

it("opens the account value to CopyDog's 永續 / 現貨 / 質押 rows", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider locale="zh-TW" messages={zhTW}><ProfileCard profile={base()} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>); });
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const parts = container.querySelector("#account-value-parts")!.textContent!;
    expect(parts).toContain("永續");
    expect(parts).toContain("現貨");
    expect(parts).toContain("質押");
  } finally { await act(async () => root.unmount()); }
});

it("leaves the identity row to the phone's top bar", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ProfileCard profile={base()} allTimeVolume={null} trades={undefined} tradesComputing={false} identity={false} /></I18nProvider>);
  expect(html).not.toContain("<h1");
});
