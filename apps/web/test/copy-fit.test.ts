import { describe, expect, it } from "vitest";

import { estimateCopyFit } from "@/lib/copy-fit";
import type { TraderFill } from "@/lib/contracts";

let tid = 0;
function fill(over: Omit<Partial<TraderFill>, "ts"> & Pick<TraderFill, "coin" | "dir" | "px" | "sz"> & { ts?: Date }): TraderFill {
  const { ts = new Date("2026-10-10T00:00:00Z"), ...rest } = over;
  return { tid: String(++tid), side: over.dir.includes("Short") ? "sell" : "buy", notionalUsd: over.px * over.sz, closedPnl: null, fee: null, ...rest, ts: ts.toISOString() };
}
const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 0, minute));

describe("estimateCopyFit", () => {
  it("scales each leader open by allocation ÷ leader account value and counts those under the minimum", () => {
    // Leader 100,000; allocation 100 → ×0.001. 5,386 → 5.39 (under), 20,000 → 20 (ok).
    const fills = [
      fill({ coin: "NEAR", dir: "Open Long", px: 5.3864, sz: 1000, ts: at(1) }),
      fill({ coin: "BTC", dir: "Open Short", px: 100_000, sz: 0.2, ts: at(2) }),
      fill({ coin: "BTC", dir: "Close Short", px: 100_000, sz: 0.2, ts: at(3) }),
      fill({ coin: "@107", dir: "Buy", px: 90, sz: 10, ts: at(4) }),
    ];
    const fit = estimateCopyFit({ fills, leaderEquity: 100_000, allocation: 100 });
    expect(fit).toMatchObject({ status: "ok", opens: 2, belowMin: 1, hip3: 0 });
    expect(fit.status === "ok" && fit.from.toISOString()).toBe(at(1).toISOString());
    expect(fit.status === "ok" && fit.to.toISOString()).toBe(at(2).toISOString());
  });

  it("merges the fills of one order (same coin, direction and time) like the copy engine's batch", () => {
    const fills = [
      fill({ coin: "HYPE", dir: "Open Long", px: 50, sz: 100, ts: at(5) }),
      fill({ coin: "HYPE", dir: "Open Long", px: 50, sz: 100, ts: at(5) }),
      fill({ coin: "HYPE", dir: "Open Long", px: 50, sz: 100, ts: at(6) }),
    ];
    // 5,000 each → ×0.0015 = 7.5; the merged pair is 15.
    expect(estimateCopyFit({ fills, leaderEquity: 100_000, allocation: 150 })).toMatchObject({ opens: 2, belowMin: 1 });
  });

  it("counts HIP-3 opens apart, not as under the minimum", () => {
    const fills = [fill({ coin: "xyz:MU", dir: "Open Long", px: 100, sz: 1, ts: at(1) }), fill({ coin: "ETH", dir: "Open Long", px: 4000, sz: 10, ts: at(2) })];
    expect(estimateCopyFit({ fills, leaderEquity: 40_000, allocation: 100 })).toMatchObject({ opens: 2, hip3: 1, belowMin: 0 });
  });

  it("counts only the opening part of a flip", () => {
    // Long 2 → short 3: sells 5, of which 3 open the short (12,000 → 12 at ×0.001).
    const flip = [fill({ coin: "ETH", dir: "Long > Short", px: 4000, sz: 5, startPosition: 2, ts: at(1) })];
    expect(estimateCopyFit({ fills: flip, leaderEquity: 100_000, allocation: 100 })).toMatchObject({ opens: 1, belowMin: 0 });
    expect(estimateCopyFit({ fills: flip, leaderEquity: 100_000, allocation: 80 })).toMatchObject({ opens: 1, belowMin: 1 });
  });

  it("uses the higher minimum when one is given", () => {
    const fills = [fill({ coin: "ETH", dir: "Open Long", px: 4000, sz: 0.3, ts: at(1) })]; // 1,200 → 12 at ×0.01
    expect(estimateCopyFit({ fills, leaderEquity: 100_000, allocation: 1000, minNotional: 15 })).toMatchObject({ belowMin: 1 });
    expect(estimateCopyFit({ fills, leaderEquity: 100_000, allocation: 1000, minNotional: 5 })).toMatchObject({ belowMin: 0 });
  });

  it("says what it cannot estimate instead of guessing", () => {
    const opens = [fill({ coin: "ETH", dir: "Open Long", px: 4000, sz: 1, ts: at(1) })];
    expect(estimateCopyFit({ fills: opens, leaderEquity: null, allocation: 100 }).status).toBe("unknown_equity");
    expect(estimateCopyFit({ fills: opens, leaderEquity: 0, allocation: 100 }).status).toBe("unknown_equity");
    expect(estimateCopyFit({ fills: undefined, leaderEquity: 1000, allocation: 100 }).status).toBe("loading");
    expect(estimateCopyFit({ fills: [fill({ coin: "ETH", dir: "Close Long", px: 4000, sz: 1 })], leaderEquity: 1000, allocation: 100 }).status).toBe("no_opens");
    expect(estimateCopyFit({ fills: opens, leaderEquity: 1000, allocation: 0 }).status).toBe("no_amount");
  });

  it("counts the opens under the minimum and suggests no amount of its own (the api's suggested minimum budget is the one rule, D7 2026-10-23)", () => {
    // Leader 1,000,000; opens of 1k…10k. The 20% quantile (smallest first) is 3,000:
    // 10 × 1,000,000 / 3,000 = 3,333.3 → 3,340; at that amount 8 of 10 place.
    const fills = Array.from({ length: 10 }, (_, i) => fill({ coin: "BTC", dir: "Open Long", px: 1000, sz: i + 1, ts: at(i) }));
    const fit = estimateCopyFit({ fills, leaderEquity: 1_000_000, allocation: 50 });
    expect(fit).toMatchObject({ status: "ok", opens: 10, belowMin: 10 });
    // No amount of its own (the api's suggested minimum budget is the one rule, D7).
    expect(fit).not.toHaveProperty("suggested");
    expect(estimateCopyFit({ fills, leaderEquity: 1_000_000, allocation: 3340 })).toMatchObject({ belowMin: 2 });
    // Only HIP-3 opens: nothing the copy could place, no suggestion.
    expect(estimateCopyFit({ fills: [fill({ coin: "xyz:TSLA", dir: "Open Long", px: 100, sz: 100, ts: at(20) })], leaderEquity: 1_000_000, allocation: 50 }))
      .toMatchObject({ hip3: 1 });
  });
});

