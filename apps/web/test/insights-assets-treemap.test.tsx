// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WalletsTable } from "@/components/insights/cohort-tables";
import { MarketTreemap, tileContent } from "@/components/insights/market-treemap";
import { fixtureCohort } from "@/fixtures/discovery";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import type { CohortMarket } from "@/lib/contracts";

vi.mock("@/lib/use-is-desktop", () => ({ useIsDesktop: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = (node: React.ReactNode) => act(async () => root.render(<I18nProvider locale="en" messages={catalogs.en}>{node}</I18nProvider>));

const base = fixtureCohort("profit").wallets[0]!;
const ASSETS = ["BTC", "ETH", "SOL", "xyz:SP500", "HYPE", "xyz:NVDA", "DOGE"];

/** QA on Stage, 2026-10-25: the 交易資產 cell stacked up to five tiny
 * overlapping icons and read as noise. Three icons, then a +N pill whose
 * hover lists every coin, as the board cards' stacks. */
it("shows three asset icons and a +N pill in the wallets table", async () => {
  await render(<WalletsTable rows={[{ ...base, topAssets: ASSETS }, { ...base, address: `0x${"1".repeat(40)}`, topAssets: ["BTC", "ETH"] }]} />);
  const [many, few] = [...container.querySelectorAll("tbody tr")].map((tr) => tr.querySelectorAll("td")[1]!);
  const stack = many!.querySelector('[role="img"]')!;
  // Every coin is named for screen readers; three icons are drawn.
  expect(stack.getAttribute("aria-label")).toBe(ASSETS.join(", "));
  expect(stack.querySelectorAll(":scope > span:not([data-testid])").length).toBe(3);
  expect(many!.querySelector('[data-testid="coin-stack-more"]')!.textContent).toBe("+4");
  expect(few!.querySelector('[data-testid="coin-stack-more"]')).toBeNull();
  expect(few!.querySelector('[role="img"]')!.querySelectorAll(":scope > span:not([data-testid])").length).toBe(2);
});

const market = (coin: string, value: number): CohortMarket => ({ ...fixtureCohort("profit").markets[0]!, coin, notionalLong: value * 0.7, notionalShort: value * 0.3, biasPct: 70 });

/** QA: small treemap tiles read "SP…", "N…". A tile too small for the whole
 * label draws the icon alone or just its colour; the label is never cut, its
 * hover title names the market, by its short name (xyz:SP500 → SPX). */
it("never truncates a treemap label: whole label, icon alone, or colour only; SPX for xyz:SP500", async () => {
  await render(<MarketTreemap title="Markets" loading={false} markets={[market("BTC", 1000), market("ETH", 400), market("xyz:SP500", 300), market("xyz:NVDA", 6), market("SOL", 5), market("DOGE", 3), market("HYPE", 2), market("xyz:TSLA", 1)]} />);
  const tiles = [...container.querySelectorAll<HTMLElement>('[data-testid="treemap-tile"]')];
  expect(tiles).toHaveLength(8);
  for (const tile of tiles) {
    expect(tile.innerHTML).not.toContain("truncate");
    expect(tile.textContent).not.toContain("…");
    const name = tile.title.split(" · ")[0]!;
    const shown = tile.querySelector(".font-display > span:last-child:not(:first-child)")?.textContent ?? "";
    if (tile.dataset.content === "full" || tile.dataset.content === "small") expect(shown).toBe(name);
    else expect(shown).toBe("");
    // The label is the market's whole short name, or absent.
    if (shown) expect(tile.textContent).toContain(name);
  }
  const spx = tiles.find((t) => t.title.startsWith("SPX · "))!;
  expect(spx).toBeDefined();
  expect(container.textContent).not.toContain("SP500");
  // The smallest tiles hold no word at all.
  expect(tiles.some((t) => t.dataset.content === "none" || t.dataset.content === "icon")).toBe(true);
});

it("fits a label only when the whole of it fits the tile", () => {
  expect(tileContent(300, 200, "BTC", true)).toBe("full");
  expect(tileContent(90, 60, "SPX", false)).toBe("small");
  expect(tileContent(60, 60, "SPX", false)).toBe("icon");
  expect(tileContent(30, 30, "SPX", false)).toBe("none");
  expect(tileContent(120, 120, "FARTCOIN", true)).not.toBe("full");
});
