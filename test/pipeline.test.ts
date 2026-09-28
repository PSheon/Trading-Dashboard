// fetch → ingest → repair → snapshot → reconcile against a fake Helius.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { HeliusClient } from "../src/lib/helius";
import { BACKFILL_DAYS, fetchWallets, ingestWallets, reconcileWallets, repairWallets } from "../src/lib/jobs";
import { snapshotDay as snapshot } from "../src/lib/snapshots";
import { bound } from "../src/lib/metrics";
import type { RawTransaction } from "../src/lib/solana";
import { Warehouse } from "../src/lib/store";
import { addWallets, loadWallets } from "../src/lib/wallets";
import { ATA, FEE, MINT, OTHER, OTHER_ATA, POOL, RENT, SOL, W, tb, tx } from "./fixtures";
import { tmpDir } from "./helpers";

const DAY = 86_400;
const AS_OF = "2026-03-02";
const T = bound(AS_OF);

const at = (raw: RawTransaction, sig: string, t: number) => {
  raw.transaction.signatures = [sig];
  raw.blockTime = t;
  raw.slot = t;
  return raw;
};
const BUY = at(tx({ keys: [W, ATA, POOL], pre: [10 * SOL, 0, 50 * SOL], post: [10 * SOL - SOL - FEE - RENT, RENT, 51 * SOL], postTok: [tb(1, MINT, W, 1000)] }), "buy", T - 7200);
const SELL = at(tx({ keys: [W, ATA, POOL], pre: [SOL, RENT, 50 * SOL], post: [SOL + 2 * SOL + RENT - FEE, 0, 48 * SOL], preTok: [tb(1, MINT, W, 1000)] }), "sell", T - 3600);
const GIFT = at(tx({ keys: [OTHER, OTHER_ATA, ATA], pre: [SOL, RENT, 0], post: [SOL - FEE - RENT, RENT, RENT], preTok: [tb(1, MINT, OTHER, 10)], postTok: [tb(1, MINT, OTHER, 0), tb(2, MINT, W, 10)] }), "gift", T - 1800);

const result = (raw: RawTransaction, readable = true) => ({
  signature: raw.transaction.signatures[0],
  parserStatus: "OK",
  parsed: { slot: raw.slot, blockTime: raw.blockTime, instructions: [{ programName: "pump_amm" }] },
  rawTransaction: readable ? raw : { meta: {}, transaction: ["AA", "base64"] },
});

function fakeHelius(history: (address: string) => unknown[], calls: string[] = []) {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = String(_url);
    const body = JSON.parse(String(init?.body));
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.includes("/transaction-history")) {
      calls.push(body.address);
      return ok({ data: history(body.address) });
    }
    if (body.method === "getTransaction") return ok({ result: SELL });
    if (body.method === "getTokenAccountsByOwner") {
      const value = body.params[1].programId.startsWith("Tokenkeg")
        ? [{ pubkey: ATA, account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: "10" } } } } } }]
        : [];
      return ok({ result: { value } });
    }
    throw new Error(JSON.stringify(body));
  }) as typeof fetch;
  return new HeliusClient("k", { fetch: fetchImpl, minIntervalMs: 0 });
}

function setup() {
  const dir = tmpDir();
  return { wh: new Warehouse(path.join(dir, "warehouse")), rawDir: path.join(dir, "raw") };
}

async function runDay(wh: Warehouse, rawDir: string, helius: HeliusClient, now: number, stamp: string) {
  await fetchWallets(wh, helius, rawDir, [W], { now, stamp });
  await ingestWallets(wh, rawDir, [W], now);
  await snapshot(wh, AS_OF);
}

describe("pipeline", () => {
  it("runs end to end and a rerun is idempotent", async () => {
    const { wh, rawDir } = setup();
    // SELL comes back base64 so the RPC fallback is exercised.
    const helius = fakeHelius(() => [result(GIFT), result(SELL, false), result(BUY)]);
    await addWallets(wh, [W], { via: "manual", now: T - DAY });

    await runDay(wh, rawDir, helius, T, "run1");
    const trades = await wh.read<{ tx_sig: string; side: string; token_amount_raw: bigint; sol_lamports: bigint }>("trades", "true", "block_time");
    expect(trades.map((t) => [t.tx_sig, t.side, t.token_amount_raw, t.sol_lamports])).toEqual([
      ["buy", "buy", 1000n, BigInt(SOL)],
      ["sell", "sell", 1000n, 2n * BigInt(SOL)],
    ]);
    const [gift] = await wh.read<{ direction: string; counterparty: string }>("token_transfers");
    expect([gift.direction, gift.counterparty]).toEqual(["in", OTHER]);

    const [m] = await wh.read<{ as_of_date: string; trade_count: number; realized_pnl_sol: number }>("wallet_metrics_daily");
    expect([m.as_of_date, m.trade_count]).toEqual([AS_OF, 1]);
    expect(m.realized_pnl_sol).toBeCloseTo((2 * SOL - FEE - (SOL + FEE)) / SOL);

    const [reg] = await loadWallets(wh);
    expect([reg.fetch_cursor_time, reg.history_from]).toEqual([T - 1800, T - BACKFILL_DAYS * DAY]);

    // Next day: the overlap window returns the same transactions again.
    await runDay(wh, rawDir, helius, T + DAY, "run2");
    expect(await wh.read("trades")).toHaveLength(2);
    expect(await wh.read("token_transfers")).toHaveLength(1);
    expect(await wh.read("positions")).toHaveLength(2); // the round trip, and the gift still held

    const { rows } = await reconcileWallets(wh, helius, [W], T + DAY);
    expect(rows.map((r) => [r.mint, r.derived_balance_raw, r.onchain_balance_raw])).toEqual([[MINT, 10n, 10n]]);
    expect(await wh.read("reconciliation")).toHaveLength(1);
  });

  it("reproduces a snapshot bit for bit", async () => {
    const { wh, rawDir } = setup();
    await addWallets(wh, [W], { via: "manual", now: T - DAY });
    await runDay(wh, rawDir, fakeHelius(() => [result(GIFT), result(SELL), result(BUY)]), T, "run1");
    const first = await wh.read("wallet_metrics_daily");
    await snapshot(wh, AS_OF);
    expect(await wh.read("wallet_metrics_daily")).toEqual(first);
  });

  it("repair pulls transfers that only touch a token account", async () => {
    const { wh, rawDir } = setup();
    const calls: string[] = [];
    // The gift never shows up in the wallet's own history, only the account's.
    const helius = fakeHelius((a) => (a === W ? [result(SELL), result(BUY)] : [result(GIFT)]), calls);
    await addWallets(wh, [W], { via: "manual", now: T - DAY });
    await fetchWallets(wh, helius, rawDir, [W], { now: T, stamp: "run1" });
    await ingestWallets(wh, rawDir, [W], T);
    expect(await wh.read("token_transfers")).toEqual([]);

    const r = await repairWallets(wh, helius, rawDir, [W], { now: T, stamp: "run1" });
    expect([r.mints_mismatched, r.token_accounts_fetched]).toEqual([1, 1]);
    expect(calls).toEqual([W, ATA]);
    const [gift] = await wh.read<{ tx_sig: string; direction: string }>("token_transfers");
    expect([gift.tx_sig, gift.direction]).toEqual(["gift", "in"]);
    const [state] = await wh.read<{ pubkey: string; cursor_time: number }>("token_accounts");
    expect([state.pubkey, state.cursor_time]).toEqual([ATA, T - 1800]);

    // Reconciled now, so a second repair fetches nothing.
    const again = await repairWallets(wh, helius, rawDir, [W], { now: T + 60, stamp: "run2" });
    expect(again.token_accounts_fetched).toBe(0);
    expect(calls).toEqual([W, ATA]);
  });
});
