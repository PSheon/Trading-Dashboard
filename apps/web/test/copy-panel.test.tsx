import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { CopyPanel } from "../src/components/trader/copy-panel";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", login() {} }) }));
vi.mock("../src/lib/copy", () => ({
  useCopyOverview: () => ({ data: { paper: { balance: 1000 }, limits: { minAllocationUsd: 100 }, platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false } } }),
  useCopyOf: () => undefined,
  useStartCopy: () => ({ mutate() {}, isPending: false }),
}));
// The site settings still carry a referral code; the panel must not show it.
vi.mock("../src/lib/queries", () => ({ useSiteSettings: () => ({ data: { referralCode: "ORBIE" } }) }));

it("has no referral box, as CopyDog's copy panel has none", () => {
  for (const sheet of [false, true]) {
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><CopyPanel address={`0x${"ab".repeat(20)}`} sheet={sheet} /></I18nProvider>);
    expect(html).toContain("順向");
    expect(html).not.toContain("ORBIE");
    expect(html).not.toContain("推薦碼");
  }
});
