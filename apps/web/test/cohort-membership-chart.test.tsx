import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PositioningChart } from "../src/components/insights/positioning-chart";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const render = (versions: Array<string | null>, changed?: number) => renderToStaticMarkup(
  <I18nProvider locale="en" messages={en}>
    <PositioningChart title="Cohort" series={versions.map((membershipVersion, i) => ({
      t: new Date(Date.UTC(2026, 8, 20 + i)).toISOString(), pctLong: 40 + i,
      membershipVersion, membershipChanged: i === changed,
    }))} btc={[]} window="all" onWindow={() => {}} loading={false} latest={null} emptyHint="Empty" />
  </I18nProvider>,
);
const area = (html: string) => html.match(/<path d="([^"]*)" fill="url/)?.[1] ?? "";

describe("cohort chart membership boundaries", () => {
  it("draws separate areas across changed membership and legacy-to-known identity", () => {
    expect(area(render([null, null, "new", "new"])).match(/M/g)).toHaveLength(2);
    expect(render([null, null, "new", "new"])).toContain(en.insights.cohort.membershipChanged);
    expect(area(render(["old", "old", "new", "new"])).match(/M/g)).toHaveLength(2);
    expect(area(render(["same", "same", "same", "same"])).match(/M/g)).toHaveLength(1);
  });
  it("honors a boundary hidden by downsampling even when endpoint identities match", () => {
    expect(area(render(["a", "a", "a", "a"], 2)).match(/M/g)).toHaveLength(2);
  });
});
