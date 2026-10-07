import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FILL_LIMIT, FillsTab, fillsTruncated, groupFills } from "../src/components/trader/trader-tabs";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";
import type { TraderFill } from "../src/lib/contracts";
import fixture from "./fixtures/copydog-fills-bf73.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

type Row = [number, string, "buy" | "sell", string, number, number, number, number, number | null, number];
const toFill = ([time, coin, side, dir, px, sz, value, closedPnl, startPosition, liq]: Row, i: number): TraderFill => ({
  tid: String(i), coin, side, dir, px, sz, notionalUsd: value, closedPnl, fee: 0, ts: new Date(time).toISOString(), twapId: null, startPosition, liquidation: liq === 1,
});
const fills = (fixture.fills as Row[]).map(toFill);

describe("成交 rows, CopyDog's grouping", () => {
  it("groups CopyDog's own fills exactly as its page does (runs of coin / side / direction / liquidation)", () => {
    const groups = groupFills(fills);
    expect(groups.map((g) => [g.coin, g.dir, g.count])).toEqual(fixture.expected.map((g) => g.slice(0, 3)));
    groups.forEach((g, i) => expect(g.value).toBeCloseTo(Number(fixture.expected[i][3]), 1));
  });

  it("keeps the 2,000-fill page and flags a full one as cut off", () => {
    expect(FILL_LIMIT).toBe(2000);
    expect(fillsTruncated(undefined)).toBe(false);
    expect(fillsTruncated(fills)).toBe(false);
    expect(fillsTruncated(Array.from({ length: 2000 }, (_, i) => fills[i % fills.length]))).toBe(true);
  });

  it("shows the fill count badge, ≥ on the cut-off row and — for no PnL", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-TW" messages={zhTW}>
        <FillsTab rows={fills} truncated />
      </I18nProvider>,
    );
    const badges = [...html.matchAll(/data-testid="fill-count"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
    // The first page: ten groups (the shared pager, 2026-10-07).
    expect(badges).toEqual(fixture.expected.slice(0, 10).map((g) => g[2]).filter((n) => Number(n) > 1));
    expect(html.match(/<tr/g)?.length).toBe(Math.min(10, fixture.expected.length) + 1);
    expect(html).toContain("—");
    // The oldest group (the last page's last row) is partial: size and value read "≥".
    const oldest = groupFills(fills, true).at(-1)!;
    expect(oldest.partial).toBe(true);
    const last = renderToStaticMarkup(
      <I18nProvider locale="zh-TW" messages={zhTW}>
        <FillsTab rows={fills.filter((f) => new Date(f.ts).getTime() <= oldest.time)} truncated />
      </I18nProvider>,
    );
    expect(last.slice(last.lastIndexOf("<tr")).match(/≥/g)?.length).toBe(2);
  });
});
