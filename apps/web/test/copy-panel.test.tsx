import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { CopyPanel } from "../src/components/trader/copy-panel";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", login() {} }) }));
vi.mock("../src/lib/copy", () => ({
  useCopyOverview: () => ({ data: { paper: { balance: 1000 }, limits: { minAllocationUsd: 100 }, platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false } } }),
  useCopyOf: () => copy.existing,
  useStartCopy: () => ({ mutate() {}, isPending: false }),
}));
const copy = vi.hoisted(() => ({ existing: undefined as unknown, enabled: true }));
// The site settings still carry a referral code; the panel must not show it.
vi.mock("../src/lib/queries", () => ({ useSiteSettings: () => ({ data: { referralCode: "ORBIE", copyTradingEnabled: copy.enabled } }) }));

it("has no referral box, as CopyDog's copy panel has none", () => {
  for (const sheet of [false, true]) {
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><CopyPanel address={`0x${"ab".repeat(20)}`} sheet={sheet} /></I18nProvider>);
    expect(html).toContain("順向");
    expect(html).not.toContain("ORBIE");
    expect(html).not.toContain("推薦碼");
  }
});

const render = (sheet: boolean) => renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><CopyPanel address={`0x${"ab".repeat(20)}`} sheet={sheet} /></I18nProvider>);
/** The panel's call to action: its last button. */
const cta = (html: string) => html.slice(html.lastIndexOf("<button"));

it("with copy trading switched off the call to action is disabled and says copying is not open; nothing else is added", () => {
  for (const sheet of [false, true]) {
    copy.enabled = true;
    const open = render(sheet);
    expect(cta(open)).toContain("請輸入金額");
    expect(cta(open)).not.toContain("disabled=\"\"");

    copy.enabled = false;
    const closed = render(sheet);
    expect(cta(closed)).toContain(zhTW.trader.copy.errors.disabled);
    expect(cta(closed)).toContain("disabled=\"\"");
    // The same panel otherwise: same controls, no extra notice.
    expect(closed.replace(cta(closed), "")).toBe(open.replace(cta(open), ""));
  }
  copy.enabled = true;
});

it("a copy that is already running shows as usual while new copies are closed", () => {
  copy.enabled = false;
  copy.existing = { id: 7, status: "active", allocated: 1000, totalPnl: 12.5, positions: [] };
  const html = render(false);
  expect(html).toContain(zhTW.trader.copy.copying);
  expect(html).toContain("/portfolio?copy=7");
  expect(html).not.toContain(zhTW.trader.copy.errors.disabled);
  copy.existing = undefined;
  copy.enabled = true;
});
