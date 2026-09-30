import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CoverageNote } from "@/components/trader/trade-analytics";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

it("keeps unknown trade cutoff explicit for legacy coverage without backfill metadata", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}>
    <CoverageNote analytics={{ coverage: { source: "hyperliquid", from: null, truncated: true, fundingFrom: null, fundingThrough: null, fills: 0 } }} />
  </I18nProvider>);
  expect(html).toContain("Trade data cutoff unavailable");
  expect(html).toContain("The source may not provide the account’s full history");
  expect(html).toContain('href="/methodology"');
});

it("shows an available cutoff without calling completed backfill lifetime-complete", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}>
    <CoverageNote analytics={{ coverage: { source: "hyperliquid", from: null, truncated: true,
      through: "2026-09-30T10:00:00Z", fundingFrom: null, fundingThrough: null, fills: 0,
      backfill: { status: "caught_up", reason: null, regular: "complete", twap: "complete", retentionLimited: true } } }} />
  </I18nProvider>);
  expect(html).toContain("Trade data through");
  expect(html).not.toContain("Trade data cutoff unavailable");
  expect(html).toContain("Available history has been read");
  expect(html).toContain("The source may not provide the account’s full history");
});
