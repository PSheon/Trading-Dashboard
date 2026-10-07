import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { MobileTrader } from "../src/components/trader/mobile-trader";
import { profileFor } from "../src/fixtures/data";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";
import type { TraderProfileResponse } from "../src/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("../src/components/alerts/alert-bell", () => ({ AlertBell: () => null }));
vi.mock("../src/components/traders/bits", () => ({ FavoriteButton: () => null, RoiPill: () => null }));
vi.mock("../src/components/charts/area-chart", () => ({ AreaChart: () => null }));
vi.mock("../src/components/trader/copy-panel", () => ({ CopyPanel: () => null }));
vi.mock("../src/components/trader/share-dialog", () => ({ ShareButton: () => null }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedOut", login() {} }) }));
vi.mock("../src/lib/copy", () => ({ useCopyOf: () => undefined }));
vi.mock("../src/lib/queries", () => ({
  isComputing: () => false,
  isUnavailable: () => false,
  useTraderAnalytics: () => ({ data: undefined, error: null, refetch() {} }),
  useChartSnapshots: () => ({ data: undefined }),
}));

const render = (copyScore: number | null) =>
  renderToStaticMarkup(
    <I18nProvider locale="zh-TW" messages={zhTW}>
      <MobileTrader profile={profileFor(`0x${"ab".repeat(20)}`, false) as unknown as TraderProfileResponse} marks={{}} portfolio={undefined} allTime={undefined} window="allTime" onWindow={() => {}} loading={false} copyScore={copyScore} />
    </I18nProvider>,
  );

it("shows the phone hero's copy score only when the trader has one, as CopyDog", () => {
  expect(render(54)).toContain('data-testid="hero-copy-score"');
  expect(render(54)).toContain(">54<");
  const none = render(null);
  expect(none).not.toContain("hero-copy-score");
  expect(none).not.toContain("複製評分");
});
