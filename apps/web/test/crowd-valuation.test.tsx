import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { CrowdView } from "../src/components/insights/crowd-view";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/queries", () => ({ useCrowd: () => ({ data: {
  trackedTraders: 1, updatedAt: null,
  comparison: { currentTraders: 1, pastTraders: 1, matchedTraders: 1 },
  coins: [{ coin: "BTC", longNotional: null, shortNotional: null, longTraders: 1, shortTraders: 0,
    netBias: null, netNotional24hAgo: 100, netNotionalChange24h: null }],
} }) }));
it("renders unknown valuation and comparison as unavailable while preserving trader counts", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><CrowdView onCoin={() => {}} /></I18nProvider>);
  expect(html.match(/—/g)).toHaveLength(4);
  expect(html).not.toContain("$0");
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("Infinity");
});
