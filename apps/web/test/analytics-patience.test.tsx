// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { MobileTrader } from "../src/components/trader/mobile-trader";
import { profileFor } from "../src/fixtures/data";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";
import type { TraderProfileResponse } from "../src/lib/contracts";

/**
 * Stage, 2026-10-07 (A5): the phone's 勝率 tile stayed a skeleton for 45 s
 * and more while the analytics read answered 503 busy (Retry-After stretches
 * the three retries past a minute). After 30 s it says 「—」 with 重試.
 */
const refetch = vi.hoisted(() => ({ fn: (() => {}) as () => void }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("../src/components/alerts/alert-bell", () => ({ AlertBell: () => null }));
vi.mock("../src/components/traders/bits", () => ({ FavoriteButton: () => null, RoiPill: () => null }));
vi.mock("../src/components/charts/area-chart", () => ({ AreaChart: () => null }));
vi.mock("../src/components/trader/copy-panel", () => ({ CopyPanel: () => null }));
vi.mock("../src/components/trader/share-dialog", () => ({ ShareButton: () => null }));
vi.mock("../src/components/trader/activity-tabs", () => ({ ActivityTabs: () => null }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedOut", login() {} }) }));
vi.mock("../src/lib/copy", () => ({ useCopyOf: () => undefined }));
vi.mock("../src/lib/queries", async (original) => {
  const actual = await original<typeof import("../src/lib/queries")>();
  // Busy: one 503 so far, the retry pending (Retry-After 65 s).
  const { ApiError } = await import("../src/lib/api");
  const busy = new ApiError(503, "Busy", { code: "busy" }, 65_000);
  return { ...actual,
    useTraderAnalytics: () => ({ data: undefined, error: null, isPending: true, isError: false, failureCount: 1, failureReason: busy, refetch: () => refetch.fn() }),
    useChartSnapshots: () => ({ data: undefined }),
  };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

it("the 勝率 tile is a skeleton for at most 30 s of a busy api, then 「—」 and 重試", async () => {
  vi.useFakeTimers();
  const spy = vi.fn();
  refetch.fn = spy;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(
    <I18nProvider locale="zh-TW" messages={zhTW}>
      <MobileTrader profile={profileFor(`0x${"ab".repeat(20)}`, false) as unknown as TraderProfileResponse} marks={{}} portfolio={undefined} allTime={undefined} window="allTime" onWindow={() => {}} loading={false} copyScore={null} />
    </I18nProvider>,
  ));
  const tile = () => [...el.querySelectorAll("dl > div")].find((d) => d.querySelector("dt")?.textContent === "勝率")!;
  expect(tile().querySelector(".ui-skeleton")).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(31_000); });
  expect(tile().querySelector(".ui-skeleton")).toBeNull();
  expect(tile().querySelector("dd")!.textContent).toBe("—");
  const retry = [...tile().querySelectorAll("button")].find((b) => b.textContent === "重試")!;
  expect(tile().textContent).toContain("暫時無法取得");
  await act(async () => retry.click());
  expect(spy).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

vi.mock("../src/lib/site-mode", () => ({ useSiteMode: () => "paper" }));
vi.mock("../src/lib/copy-live-portfolio", () => ({ useLiveCopyPortfolio: () => ({ data: undefined }) }));
