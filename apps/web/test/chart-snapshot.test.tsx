// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChartSnapshotStrip, snapshotAt } from "@/components/trader/chart-snapshot-strip";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import type { WireChartSnapshots } from "@trading-dashboard/shared/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const MIN = 60_000;
const pos = (coin: string, szi: number, notional: number, upnl: number) => ({ coin, szi, entryPx: 1, markPx: 1, notional, upnl });
const data: WireChartSnapshots = {
  address: "0xabc", window: "day", kind: "perp", coverageStart: new Date(0).toISOString(),
  snapshots: [
    { t: 0, n: 0, upnl: 0, positions: [] },
    { t: 24 * MIN, n: 7, upnl: 10, positions: [pos("BTC", 1, 50_000, 1200), pos("ETH", -2, 9000, -300), pos("SOL", 1, 800, 5), pos("HYPE", 1, 700, 1), pos("kPEPE", 1, 600, 0), pos("DOGE", 1, 500, 0), pos("XRP", 1, 400, 0)] },
    { t: 48 * MIN, n: 1, upnl: 3, positions: [pos("BTC", 1, 51_000, 1300)] },
  ],
};
const html = (time: number | null, d: WireChartSnapshots | undefined = data) => renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ChartSnapshotStrip data={d} time={time} /></I18nProvider>);

describe("positions at the chart's hovered time (chart snapshots)", () => {
  it("takes the last snapshot at or before the time, if it is recent enough", () => {
    expect(snapshotAt(data, 30 * MIN)?.t).toBe(24 * MIN);
    expect(snapshotAt(data, 48 * MIN)?.t).toBe(48 * MIN);
    expect(snapshotAt(data, -1)).toBeNull();
    // Spacing is 24 min: more than two of them past the last snapshot is no snapshot.
    expect(snapshotAt(data, 48 * MIN + 47 * MIN)?.t).toBe(48 * MIN);
    expect(snapshotAt(data, 48 * MIN + 49 * MIN)).toBeNull();
    expect(snapshotAt(undefined, 1)).toBeNull();
    expect(snapshotAt(data, null)).toBeNull();
  });

  it("shows a hint while idle, the five largest positions with the rest counted, flat as flat, and nothing for an unwatched trader", () => {
    expect(html(null)).toContain("Hover the chart to see the positions held at that time");
    const busy = html(25 * MIN);
    expect(busy).toContain("Positions at");
    for (const coin of ["BTC", "ETH", "SOL", "HYPE"]) expect(busy).toContain(`>${coin}<`);
    expect(busy).not.toContain(">XRP<");
    expect(busy).toContain("2 more");
    expect(busy).toContain("Short");
    expect(html(1 * MIN)).toContain("No open positions then");
    expect(html(-5)).toContain("No position snapshot at this time");
    expect(html(1, { ...data, coverageStart: null, snapshots: [] })).toBe("");
  });
});
