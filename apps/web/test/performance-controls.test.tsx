// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PerformanceChart } from "@/components/trader/performance";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/queries", () => ({ useChartSnapshots: () => ({ data: undefined }) }));

it("gives the metric, period and display unit distinct accessible radio group names", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><PerformanceChart
    address="0xabc" portfolio={undefined} loading={false} window="week" onWindow={() => {}}
    mode="pnl" onMode={() => {}} unit="usd" onUnit={() => {}} market="perp" onMarket={() => {}}
    muted={false} roi={null}
  /></I18nProvider>);
  const el = document.createElement("div"); el.innerHTML = html;
  const names = Array.from(el.querySelectorAll('[role="radiogroup"]')).map(group => group.getAttribute("aria-label"));
  expect(names).toEqual(["Chart metric", "Performance window", "Display unit"]);
  for (const group of el.querySelectorAll('[role="radiogroup"]')) {
    expect(group.querySelectorAll('[role="radio"][tabindex="0"]')).toHaveLength(1);
  }
});
