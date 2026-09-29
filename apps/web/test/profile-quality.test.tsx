import { ProfileCard } from "../src/components/trader/profile-card";
import { profileFor } from "../src/fixtures/data";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { ProfileQuality } from "../src/components/trader/profile-quality";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
it("distinguishes unavailable sources from older observations", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ProfileQuality quality={{ partial: true, sources: {
    staking: { status: "unavailable", asOf: null, stale: false, maxAgeMs: 600000 },
    spot: { status: "available", asOf: "2026-09-29T10:00:00.000Z", stale: true, maxAgeMs: 60000 },
  } }} /></I18nProvider>);
  expect(html).toContain("Staked HYPE");
  expect(html).toContain("Unavailable");
  expect(html).toContain("Older cached data");
  expect(html).toContain('dateTime="2026-09-29T10:00:00.000Z"');
  expect(html).not.toContain("$0");
});

vi.mock("../src/components/alerts/alert-bell", () => ({ AlertBell: () => null }));
vi.mock("../src/components/traders/bits", () => ({ FavoriteButton: () => null, LowSampleTag: () => null, VaultBadge: () => null, ACTIVITY_DOT: {} }));
it("does not describe an analytics outage as an unwatched trader or empty coin history", () => {
  const profile = { ...profileFor(`0x${"ab".repeat(20)}`, false), tracked: true, analytics: null, stats: null, fetchedAt: "2026-09-29T10:00:00.000Z", lastTradeAt: null,
    dataQuality: { partial: true, sources: { analytics: { status: "unavailable" as const, asOf: null, stale: false, maxAgeMs: 60000 } } } };
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ProfileCard profile={profile} activity={null} lowSampleThreshold={20} liveStatus="polling" allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
  expect(html).toContain("Couldn&#x27;t load data.");
  expect(html).not.toContain("No closed trades");
  expect(html).not.toContain("isn&#x27;t watched yet");
});
