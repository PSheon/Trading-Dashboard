// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { BoardsView } from "../src/components/explore/boards-view";
import { fixtureBoard } from "../src/fixtures/discovery";
import { I18nProvider } from "../src/i18n/provider";
import { catalogs } from "../src/i18n/messages";
import { LOCALES } from "../src/i18n/config";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(location.search),
  useRouter: () => ({ refresh() {}, push() {} }),
}));
vi.mock("../src/lib/use-is-desktop", () => ({ useIsDesktop: () => true }));
vi.mock("../src/lib/queries", () => ({
  useSiteSettings: () => ({ data: undefined }),
  useBoard: (query: Parameters<typeof fixtureBoard>[0]) => ({ data: fixtureBoard(query), isError: false, isPending: false }),
}));

/** QA on Stage, 2026-10-25: the stocks board's cards read "Stocks 損益" /
 * "Stocks ROI" — an English scope word in zh-TW (and every other locale).
 * The 股票 tab already says it: the cards and the table head read the plain
 * metric names, in every language; a coin board still names its coin. */
it("labels the stocks top 100's figures with the plain metric names in every locale", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const locale of LOCALES) {
      const d = catalogs[locale].discover;
      history.replaceState(null, "", "/explore?market=stocks");
      await act(async () => root.render(<I18nProvider key={locale} locale={locale} messages={catalogs[locale]}><BoardsView /></I18nProvider>));
      const labels = [...container.querySelectorAll('[data-testid="card-primary-label"]')].map((el) => el.textContent);
      expect(labels.length, locale).toBeGreaterThan(0);
      for (const label of labels) expect(label, locale).toBe(d.pnl);
      expect(container.textContent, locale).not.toContain("Stocks " + d.pnl.split(" ")[0]);
      expect(container.textContent, locale).not.toMatch(/Stocks (PnL|ROI|損益)/);
      if (locale !== "en") expect(container.textContent, locale).not.toContain(`Stocks ${d.pnl}`);

      history.replaceState(null, "", "/explore?market=stocks&board=xyz:NVDA");
      await act(async () => root.render(<I18nProvider key={`${locale}-nvda`} locale={locale} messages={catalogs[locale]}><BoardsView /></I18nProvider>));
      const coin = [...container.querySelectorAll('[data-testid="card-primary-label"]')].map((el) => el.textContent);
      for (const label of coin) expect(label, locale).toBe(d.coinPnl.replace("{coin}", "NVDA"));
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    history.replaceState(null, "", "/");
  }
}, 30_000);
