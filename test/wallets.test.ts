import { describe, expect, it } from "vitest";

import { addWallets, dueWallets, loadWallets, recordFetch, RegistryError, saveWallets, type WalletRow } from "../src/lib/wallets";
import { tmpWarehouse } from "./helpers";

const DAY = 86_400;
const NOW = 1_800_000_000;

describe("wallet registry", () => {
  it("registers new addresses and leaves known ones untouched", async () => {
    const wh = tmpWarehouse();
    expect(await addWallets(wh, ["A", "B", "A"], { via: "manual", now: NOW })).toEqual(["A", "B"]);
    expect(await addWallets(wh, ["B", "C"], { via: "token_funnel", now: NOW + DAY })).toEqual(["C"]);
    const reg = (await loadWallets(wh)).sort((a, b) => a.address.localeCompare(b.address));
    expect(reg.map((w) => [w.address, w.first_seen_at, w.discovered_via])).toEqual([
      ["A", NOW, "manual"], ["B", NOW, "manual"], ["C", NOW + DAY, "token_funnel"],
    ]);
  });

  it("refuses a save that loses a wallet or moves first_seen_at", async () => {
    const wh = tmpWarehouse();
    await addWallets(wh, ["A", "B"], { via: "manual", now: NOW });
    const before = await loadWallets(wh);
    await expect(saveWallets(wh, before, before.slice(0, 1))).rejects.toThrow(/never removed/);
    await expect(saveWallets(wh, before, before.map((w) => ({ ...w, first_seen_at: 0 })))).rejects.toThrow(RegistryError);
    expect(await loadWallets(wh)).toHaveLength(2);
  });

  it("keeps the cursor when nothing is new and the earliest history start", async () => {
    const wh = tmpWarehouse();
    await addWallets(wh, ["A"], { via: "manual", now: NOW });
    await recordFetch(wh, { A: [NOW - 100, NOW, NOW - 180 * DAY] });
    await recordFetch(wh, { A: [null, NOW + DAY, NOW - 700] });
    const [r] = await loadWallets(wh);
    expect([r.fetch_cursor_time, r.last_fetched_at, r.history_from]).toEqual([NOW - 100, NOW + DAY, NOW - 180 * DAY]);
  });

  it("fetches active wallets daily and dormant ones weekly", () => {
    const w = (address: string, cursor: number | null, fetched: number | null): WalletRow => ({
      address, first_seen_at: 0, discovered_via: "manual", discovered_from_token: null, funnel_run_id: null,
      fetch_cursor_time: cursor, last_fetched_at: fetched, history_from: null,
    });
    const reg = [
      w("new", null, null),
      w("active_recent", NOW - DAY, NOW - 3600),
      w("active_stale", NOW - DAY, NOW - DAY),
      w("dormant_recent", NOW - 60 * DAY, NOW - 3 * DAY),
      w("dormant_stale", NOW - 60 * DAY, NOW - 8 * DAY),
    ];
    expect(dueWallets(reg, NOW)).toEqual(["new", "active_stale", "dormant_stale"]);
  });
});
