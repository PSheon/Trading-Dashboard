import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { OperationalSwitchesPanel, archiveState } from "@/components/admin/operational-switches";
import { en } from "@/i18n/messages/en";
import { I18nProvider } from "@/i18n/provider";
import type { HeartbeatResponse, OperationalSwitches } from "@/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const api: OperationalSwitches = { appRole: "api", copyTradingMode: "paper", hyperliquidNetwork: "testnet", telegramDryRun: true, archiveEnabled: false, archiveMaxDailyUsd: 2, maxFavoritesPerUserDefault: 100 };
const worker: OperationalSwitches = { ...api, appRole: "worker", hyperliquidNetwork: "mainnet", telegramDryRun: false, archiveEnabled: true, archiveMaxDailyUsd: 5 };
const archive = {
  enabled: true, liveNextHour: "2026-10-02T07:00:00Z", backfillCursorHour: null, lagSeconds: 5400, objects: 10, bytes: 1, fillsSeen: 1, fillsKept: 1,
  spendDayBytes: 1, spendDayUsd: 1.2345, maxDailyUsd: 5, addresses: { total: 1, backfilled: 1, pending: 0, excluded: 0 }, lastObjectKey: null, lastRunAt: "2026-10-02T08:00:00Z", lastError: null,
} as unknown as NonNullable<HeartbeatResponse["archive"]>;
const render = (props: Parameters<typeof OperationalSwitchesPanel>[0]) =>
  renderToStaticMarkup(<I18nProvider locale="en" messages={en}><OperationalSwitchesPanel {...props} /></I18nProvider>);

it("lists every switch for the api and the worker side by side, read-only", () => {
  const html = render({ api, worker, archive });
  for (const name of ["APP_ROLE", "COPY_TRADING_MODE", "HYPERLIQUID_NETWORK", "TELEGRAM_DRY_RUN", "S3_ARCHIVE_ENABLED", "S3_ARCHIVE_MAX_DAILY_USD", "MAX_FAVORITES_PER_USER"]) expect(html).toContain(name);
  expect(html).toContain("paper");
  expect(html).toContain("testnet");
  expect(html).toContain("mainnet");
  expect(html).toContain("On (nothing is actually sent)");
  expect(html).toContain("Off (messages are sent)");
  expect(html).toContain("100 (used while the setting is empty)");
  // Today's spend against the cap, and nothing to click.
  expect(html).toContain("$1.2345 of $5.00 cap");
  expect(html).toContain("Running");
  expect(html).not.toMatch(/<button|<input|<select/);
});

it("says so when the worker reports nothing, and shows nothing for an api that predates the switches", () => {
  const html = render({ api, worker: undefined, archive: undefined });
  expect(html).toContain("not reported");
  expect(html).toContain("Unknown (the worker did not report)");
  expect(render({ api: undefined, worker, archive })).toBe("");
});

it("the archive ingest's state: off, running, capped by today's spend, failed, unknown", () => {
  expect(archiveState(false, archive)).toBe("disabled");
  expect(archiveState(true, undefined)).toBe("unknown");
  expect(archiveState(undefined, undefined)).toBe("unknown");
  expect(archiveState(true, archive)).toBe("running");
  expect(archiveState(true, { ...archive, spendDayUsd: 5 })).toBe("capped");
  expect(archiveState(true, { ...archive, lastError: "access_error" })).toBe("error");
  expect(archiveState(true, { ...archive, enabled: false })).toBe("disabled");
});


it("separates active archive coverage from excluded accounts and shows the real UTC cursor", () => {
  const html = render({ api, worker, archive: { ...archive,
    addresses: { total: 100, backfilled: 60, pending: 30, excluded: 10 },
    backfillFloor: "2026-07-05T00:00:00Z", backfillCursorHour: "2026-07-30T14:00:00Z",
  } });
  expect(html).toContain("60 / 90 active addresses");
  expect(html).toContain("2026-07-05T00:00:00.000Z");
  expect(html).toContain("2026-07-30T14:00:00.000Z");
  expect(html).toContain("not complete lifetime analytics");
});

it("does not fabricate a completion percentage or date without archive coverage", () => {
  const html = render({ api, worker, archive: { ...archive,
    addresses: { total: 2, backfilled: 0, pending: 0, excluded: 2 }, liveNextHour: null,
  } });
  expect(html).toContain("0 / 0 active addresses");
  expect(html).not.toMatch(/NaN|Infinity|100%/);
});

it("labels an initialized live cursor as the next hour, never completed ingestion", () => {
  const html = render({ api, worker, archive: { ...archive, objects: 0, fillsKept: 0, lastRunAt: null,
    addresses: { total: 1, backfilled: 0, pending: 1, excluded: 0 },
  } });
  expect(html).toContain("Next live archive hour (UTC)");
  expect(html).not.toContain("Archive ingested through");
});
