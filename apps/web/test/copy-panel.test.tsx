import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { CopyPanel } from "../src/components/trader/copy-panel";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: copy.status, login() {} }) }));
vi.mock("../src/lib/copy", () => ({
  useCopyOverview: () => ({ data: { paper: { balance: copy.balance }, limits: { minAllocationUsd: 100 }, platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false } } }),
  useCopyOf: () => copy.existing,
  useStartCopy: () => ({ mutate() {}, isPending: false }),
}));
const copy = vi.hoisted(() => ({ existing: undefined as unknown, enabled: true, status: "signedIn", balance: 1000 }));
// Testnet copy is off here (no `automaticExecution`): the panel is the paper one.
vi.mock("../src/lib/copy-live-setup", () => ({ useLiveCopyAvailable: () => false, setupTerminal: () => false, useLiveCopySetup: () => ({ data: undefined }),
  useLiveCopySetupActions: () => ({ start: { isPending: false }, confirm: { isPending: false } }) }));
vi.mock("../src/lib/copy-live-portfolio", () => ({ useLiveCopyPortfolio: () => ({ data: undefined }) }));
vi.mock("../src/lib/wallet", () => ({ useWallet: () => ({ data: undefined }), signErrorMessage: () => ({ rejected: false, message: "" }) }));
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

it("the start of a copy can say which of the trader's positions were not copied, in every language", async () => {
  const { catalogs } = await import("../src/i18n/messages");
  const { LOCALES } = await import("../src/i18n/config");
  for (const locale of LOCALES) {
    const text = catalogs[locale].trader.copy.errors.adoptionPartial;
    for (const slot of ["{adopted}", "{total}", "{coins}"]) expect(text, locale).toContain(slot);
    expect(catalogs[locale].portfolio.copy.order.leg.liquidation.length, locale).toBeGreaterThan(2);
  }
  // The fixture answers a start with 跟單目前持倉 as the api does: one adopted, one left out.
  const { fixtureStartCopy } = await import("../src/fixtures/copy");
  const { copyStrategySchema } = await import("@trading-dashboard/shared/contracts");
  const created = copyStrategySchema.parse(JSON.parse(JSON.stringify(fixtureStartCopy({ leader: `0x${"cd".repeat(20)}`, allocationUsd: 500 }))));
  expect(created.adoption).toEqual([
    { coin: "BTC", adopted: true, reason: null, size: expect.any(Number) },
    { coin: "xyz:TSLA", adopted: false, reason: "symbol_not_allowed", size: 0 },
  ]);
  const delta = copyStrategySchema.parse(JSON.parse(JSON.stringify(fixtureStartCopy({ leader: `0x${"ce".repeat(20)}`, allocationUsd: 500, copyStartMode: "delta" }))));
  expect(delta.adoption).toBeUndefined();
});

it("with a zero balance the amount is locked and the call to action is disabled, saying the balance is not enough", () => {
  copy.balance = 0;
  for (const sheet of [false, true]) {
    const html = render(sheet);
    expect(cta(html)).toContain(zhTW.trader.copy.notEnoughBalance);
    expect(cta(html)).toContain("disabled=\"\"");
  }
  expect(render(false)).toMatch(/<input[^>]*id="copy-amount"[^>]*disabled=""/);
  copy.balance = 1000;
});

it("signed out, the amount is locked and the call to action signs in", () => {
  copy.status = "signedOut";
  const html = render(false);
  expect(cta(html)).toContain(zhTW.common.signIn);
  expect(cta(html)).not.toContain("disabled=\"\"");
  expect(html).toMatch(/<input[^>]*id="copy-amount"[^>]*disabled=""/);
  copy.status = "signedIn";
});
