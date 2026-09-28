import { describe, expect, it } from "vitest";

import { runStatus, STALE_SECONDS } from "../src/lib/activity";
import { Progress, readActivity } from "../src/lib/progress";
import { tmpDir } from "./helpers";

describe("progress", () => {
  it("records steps, ticks, errors and the outcome for the page to read", () => {
    const dir = tmpDir();
    const p = new Progress(dir, "cli");
    p.step("fetch", 2);
    p.tick("A…: 10 transactions");
    p.error("B…: HTTP 500");
    p.finish("failed", "finished with 1 error");
    const a = readActivity(dir)!;
    expect([a.source, a.step, a.done, a.total, a.errors, a.outcome]).toEqual(["cli", "failed", 1, 2, 1, "failed"]);
    expect(a.log.map((e) => [e.step, e.level])).toEqual([
      ["fetch", "info"], ["fetch", "info"], ["fetch", "error"], ["failed", "error"],
    ]);
  });

  it("tells a live run from one that stopped writing", () => {
    const dir = tmpDir();
    new Progress(dir, "web").step("ingest", 5);
    const a = readActivity(dir)!;
    expect(runStatus(a, a.updated_at + 60)).toBe("running");
    expect(runStatus(a, a.updated_at + STALE_SECONDS + 1)).toBe("stalled");
    expect(runStatus(null, 0)).toBe("none");
  });

  it("keeps library calls quiet without a data directory", () => {
    const p = Progress.silent();
    p.step("x", 1);
    p.finish("ok", "done");
    expect(readActivity(tmpDir())).toBeNull();
  });
});
