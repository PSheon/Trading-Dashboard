import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Calculator } from "@/components/home/home-view";
import { fixtureHome } from "@/fixtures/discovery";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

function render(roi: number | null, sparkline = [10, 20, 30]) {
  const sample = fixtureHome().calculator[0];
  const trader = { ...sample, roi, sparkline,
    lastTradeAt: sample.lastTradeAt?.toISOString() ?? null,
    metricsUpdatedAt: sample.metricsUpdatedAt?.toISOString() ?? null,
    tradesFrom: sample.tradesFrom?.toISOString() ?? null };
  return renderToStaticMarkup(<I18nProvider locale="en" messages={en}><Calculator traders={[trader]} /></I18nProvider>);
}

describe("home historical illustration", () => {
  it("explains the illustrated period and costs beside the input", () => {
    const html = render(0.2);
    expect(html).toContain('aria-describedby="calc-note"');
    expect(html).toContain('id="calc-note"');
    expect(html).toContain("available all-time ROI");
    expect(html).toContain("not a trade-by-trade copy backtest");
    expect(html).toContain("excludes fees, slippage and execution delays");
    expect(html).not.toContain("trailing 30-day return");
  });
  it("does not present missing ROI as a flat investment return", () => {
    const html = render(null);
    expect(html).not.toContain("$1,000");
    expect(html).toContain("ROI unavailable");
    expect(html).not.toContain("NaN");
  });
  it("keeps the ending result available when a curve cannot be illustrated", () => {
    const html = render(0.2, [10, 10, 10]);
    expect(html).toContain("$1,200");
    expect(html).toContain("Not enough data to illustrate the curve");
  });
  it("shows losses below half the principal without changing the ending value", () => {
    const html = render(-0.8);
    expect(html).toContain("$200");
    // The result is drawn in the loss colours (Orbit's loss tag), never as a gain.
    expect(html).toMatch(/bg-tag-loss[^"]*"[^>]*><span[^>]*text-tag-loss-foreground[^>]*>\$200</);
    expect(html).not.toContain("bg-tag-profit");
  });
});
