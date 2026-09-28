import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withWriteLock } from "../src/lib/lock";
import { addWallets, loadWallets, recordFetch } from "../src/lib/wallets";
import { tmpDir, tmpWarehouse } from "./helpers";

describe("write lock", () => {
  it("keeps a wallet added while the job moves cursors (no lost update)", async () => {
    const wh = tmpWarehouse();
    await addWallets(wh, ["A"], { via: "manual", now: 1 });
    // Interleave many cursor updates with additions, as the page and the job would.
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => recordFetch(wh, { A: [100 + i, 200 + i, 50] })),
      ...Array.from({ length: 10 }, (_, i) => addWallets(wh, [`N${i}`], { via: "manual", now: 2 })),
    ]);
    const reg = await loadWallets(wh);
    expect(reg.map((w) => w.address).sort()).toEqual(["A", ...Array.from({ length: 10 }, (_, i) => `N${i}`)].sort());
    expect(reg.find((w) => w.address === "A")!.fetch_cursor_time).toBe(109);
  });

  it("serializes critical sections and is re-entrant on one call chain", async () => {
    const root = path.join(tmpDir(), "warehouse");
    const log: string[] = [];
    const section = (name: string) =>
      withWriteLock(root, async () => {
        log.push(`${name}:in`);
        await withWriteLock(root, async () => log.push(`${name}:nested`)); // must not deadlock
        await new Promise((r) => setTimeout(r, 5));
        log.push(`${name}:out`);
      });
    await Promise.all([section("a"), section("b")]);
    expect(log).toEqual(["a:in", "a:nested", "a:out", "b:in", "b:nested", "b:out"]);
  });

  it("takes over a lock left by a process that no longer exists", async () => {
    const root = path.join(tmpDir(), "warehouse");
    const dir = path.join(path.dirname(root), ".warehouse.lock");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "owner"), "999999"); // no such pid
    expect(await withWriteLock(root, async () => "ran", 2000)).toBe("ran");
  });
});
