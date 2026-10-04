// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { freeSpot, ProfileCard } from "../src/components/trader/profile-card";
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
  const scored = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><ProfileCard profile={base()} allTimeVolume={null} trades={undefined} tradesComputing={false} copyScore={94} /></I18nProvider>);
  expect(scored).toContain("複製評分");
  expect(scored).toContain(">94<");
  // No score (unscored or still loading): CopyDog leaves the row out, no "—".
  const unscored = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><ProfileCard profile={base()} allTimeVolume={null} trades={undefined} tradesComputing={false} copyScore={null} /></I18nProvider>);
  expect(unscored).not.toContain("複製評分");
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

it("reads CopyDog's 現貨 (spot free of holds), leverage over the whole account and its bias labels", () => {
  // 0xb7e0…d1aa, unified, 2026-09-30: CopyDog 永續 $1.46M, 現貨 $3.04M, 3.1X, 極度看漲.
  const usdc = { coin: "USDC", token: 0, total: 4_427_934.12, hold: 1_380_589.5, px: 1, value: 4_427_934.12, priceKey: null };
  expect(freeSpot({ spotBalances: [usdc] })).toBeCloseTo(3_047_344.62, 2);
  expect(freeSpot({ spotBalances: [{ ...usdc, hold: undefined }] })).toBeCloseTo(4_427_934.12, 2);
  const profile = { ...base(), accountValue: 4_415_143, perpEquity: 1_457_530, spotValue: 4_427_934.12, spotBalances: [usdc], longNotional: 13_805_895, shortNotional: 0 };
  const html = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><ProfileCard profile={profile} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
  expect(html).toContain("3.1X");
  expect(html).toContain("$14M");
  expect(html).toContain("極度看漲");
  const mild = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><ProfileCard profile={{ ...profile, longNotional: 3e6, shortNotional: 1e6 }} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
  expect(mild).toContain("看漲");
  expect(mild).not.toContain("極度看漲");
});

it("shows the known parts of an account value and names what is missing (audit A8)", () => {
  const partial = { ...base(), accountMode: "standard" as const, accountValue: 120_000, unavailableParts: { perpDexes: ["xyz"], staking: true } };
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ProfileCard profile={partial} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
  expect(html).toContain("$120,000.00");
  expect(html).toContain("Not included (unavailable right now): xyz perps and staked HYPE");
  const zh = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><ProfileCard profile={{ ...partial, unavailableParts: { perpDexes: [""], staking: false } }} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
  expect(zh).toContain("未計入（暫時無法取得）：主永續");
  // A unified account's value does not add perp equity: a missing dex is not missing from it.
  const unified = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ProfileCard profile={{ ...partial, accountMode: "unified" as const, unavailableParts: { perpDexes: ["xyz"], staking: false } }} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
  expect(unified).not.toContain("Not included");
  const complete = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ProfileCard profile={{ ...partial, unavailableParts: null }} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
  expect(complete).not.toContain("Not included");
});
