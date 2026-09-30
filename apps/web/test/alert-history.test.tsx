import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ALERT_HISTORY_ROWS, AlertHistory } from "../src/components/alerts/alert-bell";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const alerts = vi.hoisted(() => ({ data: undefined as unknown, isError: false, error: null as Error | null }));
vi.mock("../src/lib/queries", () => ({
  useAlerts: () => alerts,
  useFavorites: () => ({ data: [] }),
  useSiteSettings: () => ({ data: undefined }),
}));

const entry = (id: number, sendStatus: "sent" | "failed") => ({
  id, ruleId: null, chain: "hyperliquid", address: "0xabc", coin: "BTC", actionId: null,
  payloadJson: { version: 1, values: { actionKind: "open", notionalUsd: "125000" } },
  sentAt: "2026-09-30T10:00:00.000Z", sendStatus,
});

const render = () =>
  renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><AlertHistory address="0xabc" /></I18nProvider>);

describe("alert history behind the bell (was the 警報 tab)", () => {
  it("lists the latest alerts about the trader", () => {
    alerts.data = Array.from({ length: 8 }, (_, i) => entry(i, i === 0 ? "failed" : "sent"));
    const html = render();
    expect(html).toContain("最近警報");
    expect(html.match(/<li /g)?.length).toBe(ALERT_HISTORY_ROWS);
    expect(html).toContain("BTC");
    expect(html).toContain("開倉");
    expect(html).toMatch(/\$125(\.0+)?K/);
    expect(html).toContain("failed");
  });

  it("says so when there are none", () => {
    alerts.data = [];
    expect(render()).toContain(zhTW.trader.noAlerts);
  });
});
