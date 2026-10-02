import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

import { en } from "@/i18n/messages/en";
import { ko } from "@/i18n/messages/ko";
import { zhTW } from "@/i18n/messages/zh-TW";
import { I18nProvider } from "@/i18n/provider";
import type { Locale } from "@/i18n/config";

const NOW = Date.parse("2026-10-02T08:00:00Z");
const state = vi.hoisted(() => ({ settings: undefined as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries() {} }) }));
vi.mock("@/lib/queries", () => ({ useSiteSettings: () => ({ data: state.settings }) }));
vi.mock("@/lib/use-now", () => ({ useNow: () => NOW }));

import { MaintenanceBanner } from "@/components/shell/maintenance-banner";

const catalogs = { en, "zh-TW": zhTW, ko } as const;
const render = (locale: keyof typeof catalogs = "en") =>
  renderToStaticMarkup(<I18nProvider locale={locale as Locale} messages={catalogs[locale]}><MaintenanceBanner /></I18nProvider>);
const maintenance = (o: object = {}) => ({ maintenance: { enabled: true, message: { "zh-TW": "", en: "" }, endsAt: null, ...o } });

beforeEach(() => { state.settings = undefined; });

it("shows nothing before the settings load, when the api is older and sends no maintenance field, or when it is off", () => {
  expect(render()).toBe("");
  state.settings = {};
  expect(render()).toBe("");
  state.settings = maintenance({ enabled: false, message: { "zh-TW": "x", en: "x" } });
  expect(render()).toBe("");
});

it("on: the catalog's wording in the page's language when the admin wrote none", () => {
  state.settings = maintenance();
  expect(render()).toContain("Maintenance in progress");
  expect(render()).toContain("changes can&#x27;t be saved until it is over");
  expect(render("zh-TW")).toContain("網站維護中");
  expect(render("ko")).toContain("점검 중입니다");
  expect(render()).toContain('role="status"');
  // Not dismissible.
  expect(render()).not.toContain("<button");
});

it("the admin's text replaces the default: zh-TW for zh-TW, English for every other language", () => {
  state.settings = maintenance({ message: { "zh-TW": "資料庫升級", en: "Database upgrade" } });
  expect(render("zh-TW")).toContain("資料庫升級");
  expect(render("en")).toContain("Database upgrade");
  expect(render("ko")).toContain("Database upgrade");
  expect(render("ko")).not.toContain("변경 사항을 저장할 수 없습니다");
});

it("the expected end is shown while it is ahead and dropped once it has passed", () => {
  state.settings = maintenance({ endsAt: new Date(NOW + 3_600_000).toISOString() });
  expect(render()).toContain("Expected back around");
  state.settings = maintenance({ endsAt: new Date(NOW - 60_000).toISOString() });
  expect(render()).toContain("Maintenance in progress");
  expect(render()).not.toContain("Expected back around");
});
