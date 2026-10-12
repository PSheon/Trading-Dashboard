// @vitest-environment happy-dom
import { cohortDetailResponseSchema } from "@trading-dashboard/shared/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { InsightsView } from "../src/components/insights/insights-view";
import { fixtureCohort } from "../src/fixtures/discovery";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { I18nProvider } from "../src/i18n/provider";

const state = vi.hoisted(() => ({ detail: undefined as unknown, refetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("../src/lib/queries", () => ({
  useCohort: () => ({ data: state.detail, isError: false, isFetching: false, refetch: state.refetch }),
  useCohortHistory: () => ({ data: { tier: "rekt", window: "all", series: [], btc: [] }, errorUpdateCount: 0, refetch() {} }),
}));

/**
 * Text density review 2026-10-12 §1.3: the four-line coverage banner is one
 * pill by the title, "33/150 · 3 小時前 ↻"; a press opens the explanation
 * and 重試, and the building sentence is not on the page twice.
 */
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.refetch = vi.fn();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; });

const building = zhTW.insights.cohort.building;
const count = (text: string) => document.body.textContent!.split(text).length - 1;

it("a tier being built: one pill in the title row; its press shows the explanation and 重試", async () => {
  state.detail = { ...JSON.parse(JSON.stringify(cohortDetailResponseSchema.parse(fixtureCohort("rekt")))), updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zhTW}><InsightsView /></I18nProvider>));
  const pill = container.querySelector<HTMLButtonElement>('[data-testid="cohort-coverage"]')!;
  expect(pill.tagName).toBe("BUTTON");
  // In the title's row.
  expect(pill.closest("div")!.querySelector("h1")).not.toBeNull();
  expect(pill.textContent).toBe("33/150·3 小時前");
  expect(pill.getAttribute("aria-label")).toContain("目前已有 33 / 150 個成員的最新快照");
  expect(pill.getAttribute("aria-label")).toContain("更新於 3 小時前");
  // Closed: the building sentence is said once (the per-market map), and no 重試 line.
  expect(count(building)).toBe(1);
  expect(document.querySelector('[data-testid="cohort-coverage-detail"]')).toBeNull();

  await act(async () => { pill.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); pill.click(); });
  const detail = document.querySelector<HTMLElement>('[data-testid="cohort-coverage-detail"]')!;
  expect(detail).not.toBeNull();
  expect(detail.textContent).toContain(building);
  expect(detail.textContent).toContain(zhTW.copyUpdates.coverage.replace("{count}", "33").replace("{total}", "150"));
  expect(detail.textContent).toContain("更新於 3 小時前");
  const retry = [...detail.querySelectorAll("button")].find((b) => b.textContent === zhTW.insights.cohort.retry)!;
  await act(async () => { retry.click(); });
  expect(state.refetch).toHaveBeenCalledTimes(1);
});

it("a complete, fresh tier has no pill", async () => {
  state.detail = { ...JSON.parse(JSON.stringify(cohortDetailResponseSchema.parse(fixtureCohort("extremely_profitable")))), updatedAt: new Date().toISOString() };
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zhTW}><InsightsView /></I18nProvider>));
  expect(container.querySelector('[data-testid="cohort-coverage"]')).toBeNull();
});
