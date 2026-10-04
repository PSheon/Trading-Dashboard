import { describe, expect, it } from "vitest";

import { mergeFunds, rowMatches, type FundsFlowView } from "@/lib/funds";
import type { TraderTransfer } from "@/lib/contracts";

const COPY_WALLET = "0x" + "d4".repeat(20);
const hub = (o: Partial<TraderTransfer> & { time: string }): TraderTransfer => ({ hash: `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}`, kind: "sent", direction: "out", token: "USDC", amount: 100, usd: false, from: null, to: null, ...o }) as unknown as TraderTransfer;
const flow = (o: Partial<FundsFlowView> & { id: string; time: string; kind: FundsFlowView["kind"] }): FundsFlowView => ({ mode: "paper", amount: 0, strategyId: 3, leaderAddress: null, status: null, txHash: null, fee: null, counterparty: null, count: null, ...o }) as FundsFlowView;

describe("one money-flow history: the hub ledger and Orbie's flows", () => {
  it("folds a hub transfer into the copy funding it carried, keeps its hash, and lists everything newest first", () => {
    const sent = hub({ time: "2026-10-03T10:00:05Z", to: COPY_WALLET, amount: 100, hash: "0xabc" });
    const deposit = hub({ time: "2026-10-01T09:00:00Z", kind: "deposit", direction: "in", amount: 500 });
    const funding = flow({ id: "funding:1", time: "2026-10-03T10:00:00Z", kind: "copy_funding", mode: "testnet", amount: 100, counterparty: COPY_WALLET.toUpperCase().replace("0X", "0x"), status: "credited" });
    const fees = flow({ id: "fees:3:2026-10-02", time: "2026-10-02T12:00:00Z", kind: "fees", amount: -0.85, count: 2 });
    const rows = mergeFunds([sent, deposit], [funding, fees], true);
    expect(rows.map((r) => r.id)).toEqual(["funding:1", "fees:3:2026-10-02", expect.stringMatching(/^hub:/)]);
    expect(rows[0]).toMatchObject({ source: "orbie", hubHash: "0xabc" });
    expect(rows.some((r) => r.source === "hub" && r.transfer === sent)).toBe(false);
  });

  it("shows an accepted hub withdrawal once (the ledger's), but keeps one still pending or rejected", () => {
    const ledger = hub({ time: "2026-10-03T10:05:00Z", kind: "withdraw", amount: 24 });
    const accepted = flow({ id: "withdrawal:a", time: "2026-10-03T10:00:00Z", kind: "hub_withdrawal", mode: "testnet", amount: -25, status: "accepted" });
    const rejected = flow({ id: "withdrawal:b", time: "2026-10-03T11:00:00Z", kind: "hub_withdrawal", mode: "testnet", amount: -40, status: "rejected" });
    const rows = mergeFunds([ledger], [accepted, rejected], true);
    expect(rows.map((r) => r.id)).toEqual(["withdrawal:b", expect.stringMatching(/^hub:/)]);
  });

  it("holds hub rows older than the oldest loaded Orbie row until the history is complete", () => {
    const old = hub({ time: "2026-09-01T00:00:00Z", kind: "deposit", direction: "in" });
    const recent = flow({ id: "ledger:1", time: "2026-10-01T00:00:00Z", kind: "copy_deposit", amount: 1000 });
    expect(mergeFunds([old], [recent], false).map((r) => r.id)).toEqual(["ledger:1"]);
    expect(mergeFunds([old], [recent], true)).toHaveLength(2);
    expect(mergeFunds([old], [], true)).toHaveLength(1);
  });

  it("filters: deposits & withdrawals, copy funds, fees & funding", () => {
    const rows = mergeFunds([hub({ time: "2026-10-01T00:00:00Z", kind: "deposit", direction: "in" })], [
      flow({ id: "a", time: "2026-10-02T00:00:00Z", kind: "copy_deposit" }), flow({ id: "b", time: "2026-10-02T00:00:01Z", kind: "fees" }),
      flow({ id: "c", time: "2026-10-02T00:00:02Z", kind: "funding" }), flow({ id: "d", time: "2026-10-02T00:00:03Z", kind: "copy_funding", mode: "testnet" }),
      flow({ id: "e", time: "2026-10-02T00:00:04Z", kind: "hub_withdrawal", mode: "testnet", status: "unknown" }),
    ], true);
    const ids = (f: Parameters<typeof rowMatches>[1]) => rows.filter((r) => rowMatches(r, f)).map((r) => (r.source === "hub" ? "hub" : r.id));
    expect(ids("all")).toHaveLength(6);
    expect(ids("transfers")).toEqual(["e", "d", "hub"]);
    expect(ids("copies")).toEqual(["d", "a"]);
    expect(ids("fees")).toEqual(["c", "b"]);
  });
});
