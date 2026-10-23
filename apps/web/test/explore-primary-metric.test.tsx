// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BoardsView } from "../src/components/explore/boards-view";
import { cardPrimary } from "../src/components/discover/board-card";
import { fixtureBoard } from "../src/fixtures/discovery";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { boardRoi } from "../src/lib/board-format";
import { cardUsd } from "../src/lib/format";

/**
 * The card's big figure follows the sort: sorted by ROI, the card leads with
 * the ROI and the PnL is the pill; sorted by PnL or 複製評分 (the default),
 * the PnL leads and the ROI is the pill, as before.
 */
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(location.search),
  useRouter: () => ({ refresh() {}, push() {} }),
  usePathname: () => "/explore",
}));
vi.mock("../src/lib/queries", () => ({
  useSiteSettings: () => ({ data: undefined }),
  useBoard: (query: { sort: string }) => ({ data: board(query.sort), isError: false, isPending: false, isFetching: false, isPlaceholderData: false }),
}));
vi.mock("../src/lib/use-is-desktop", () => ({ useIsDesktop: () => true }));

const board = (sort: string) => {
  const data = fixtureBoard({ market: "crypto", board: "top100", sort: sort as "pnl", window: "all" });
  return JSON.parse(JSON.stringify({ ...data, items: data.items.slice(0, 4) }));
};

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); history.replaceState(null, "", "/"); });

async function render(search: string) {
  history.replaceState(null, "", `/explore${search}`);
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><BoardsView /></I18nProvider>));
}
const first = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;

it("sorted by ROI, the card leads with the ROI and the PnL is the pill", async () => {
  await render("?sort=roi");
  const trader = board("roi").items[0];
  expect(first("card-primary-label").textContent).toBe(en.discover.roi);
  expect(first("card-primary").textContent).toBe(boardRoi(trader.roi));
  expect(first("card-secondary").textContent).toBe(`${en.discover.pnl}${cardUsd(trader.pnl, { sign: true })}`);
});

it("sorted by PnL or by 複製評分 (the default), the PnL leads and the ROI is the pill", async () => {
  for (const search of ["", "?sort=pnl"]) {
    await render(search);
    const trader = board(search ? "pnl" : "copyScore").items[0];
    expect(first("card-primary-label").textContent).toBe(en.discover.pnl);
    expect(first("card-primary").textContent).toBe(cardUsd(trader.pnl, { sign: true }));
    expect(first("card-secondary").textContent).toBe(`${en.discover.roi}${boardRoi(trader.roi)}`);
  }
});

it("maps the sort to the metric: only ROI changes the big figure", () => {
  expect(cardPrimary("roi")).toBe("roi");
  for (const sort of ["pnl", "copyScore", "accountValue", "anything"]) expect(cardPrimary(sort)).toBe("pnl");
});
