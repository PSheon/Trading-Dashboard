import path from "node:path";

import { describe, expect, it } from "vitest";

import { runChecks } from "../src/lib/check";
import { HeliusClient } from "../src/lib/helius";
import { daily, fetchWallets } from "../src/lib/jobs";
import { bound } from "../src/lib/metrics";
import { Warehouse } from "../src/lib/store";
import { discoveredLater } from "../src/lib/universe";
import { addWallets, loadWallets, pendingIngest } from "../src/lib/wallets";
import { ATA, FEE, MINT, POOL, RENT, SOL, W, tb, tx } from "./fixtures";
import { tmpDir } from "./helpers";

const DAY = 86_400;
const T = bound("2026-03-02");
const OTHER_W = "Wallet2222222222222222222222222222222222222";

const BUY = (() => {
  const raw = tx({ keys: [W, ATA, POOL], pre: [10 * SOL, 0, 50 * SOL], post: [10 * SOL - SOL - FEE - RENT, RENT, 51 * SOL], postTok: [tb(1, MINT, W, 1000)] });
  raw.transaction.signatures = ["buy"];
  raw.blockTime = T - 7200;
  raw.slot = T - 7200;
  return raw;
})();
const result = { signature: "buy", parsed: { slot: BUY.slot, blockTime: BUY.blockTime }, rawTransaction: BUY };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test doubles read loose JSON bodies
type Body = Record<string, any>;
type Handler = (url: string, body: Body) => Response;
const client = (handler: Handler) =>
  new HeliusClient("k", {
    fetch: (async (u: string | URL | Request, init?: RequestInit) => handler(String(u), JSON.parse(String(init?.body)))) as typeof fetch,
    minIntervalMs: 0,
    backoffMs: 0,
  });
const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
const noAccounts = (body: Body) => (body.method === "getTokenAccountsByOwner" ? ok({ result: { value: [] } }) : null);

function setup() {
  const dir = tmpDir();
  return { wh: new Warehouse(path.join(dir, "warehouse")), rawDir: path.join(dir, "raw") };
}

describe("pagination", () => {
  it("keeps going through an empty page while there is a token", async () => {
    const pages = [{ data: [], paginationToken: "p1" }, { data: [result] }];
    const h = client(() => ok(pages.shift()));
    const seen = [];
    for await (const { response } of h.transactionHistory(W)) seen.push(...(response.data ?? []));
    expect(seen.map((r) => r.signature)).toEqual(["buy"]);
  });

  it("gives up after a long run of empty pages", async () => {
    const h = client(() => ok({ data: [], paginationToken: "again" }));
    await expect(async () => {
      for await (const _ of h.transactionHistory(W)) void _;
    }).rejects.toThrow(/empty pages/);
  });
});

describe("job robustness", () => {
  it("one failing wallet does not stop the others, and its cursor stays put", async () => {
    const { wh, rawDir } = setup();
    await addWallets(wh, [W, OTHER_W], { via: "manual", now: T - DAY });
    const h = client((_url, body) => (body.address === OTHER_W ? new Response("boom", { status: 500 }) : ok({ data: [result] })));
    const r = await fetchWallets(wh, h, rawDir, [OTHER_W, W], { now: T, stamp: "s" });
    expect(Object.keys(r.fetched)).toEqual([W]);
    expect(r.errors.map((e) => [e.step, e.wallet])).toEqual([["fetch", OTHER_W]]);
    const reg = new Map((await loadWallets(wh)).map((w) => [w.address, w]));
    expect(reg.get(OTHER_W)!.last_fetched_at).toBeNull();
    expect(reg.get(W)!.fetch_cursor_time).toBe(T - 7200);
  });

  it("stops fetching at the credit budget and leaves the rest due", async () => {
    const { wh, rawDir } = setup();
    await addWallets(wh, [W, OTHER_W], { via: "manual", now: T - DAY });
    const h = client(() => ok({ data: [result] }));
    // One at a time: with concurrency the cap is soft by the wallets already in flight.
    const r = await fetchWallets(wh, h, rawDir, [W, OTHER_W], { now: T, stamp: "s", creditBudget: 10, concurrency: 1 });
    expect([Object.keys(r.fetched), r.skipped]).toEqual([[W], [OTHER_W]]);
  });

  it("ingests what an interrupted run fetched, then everything checks out", async () => {
    const { wh, rawDir } = setup();
    await addWallets(wh, [W], { via: "manual", now: T - DAY });
    const h = client((_url, body) => noAccounts(body) ?? ok({ data: [result] }));
    // Run 1 stops right after fetching.
    await fetchWallets(wh, h, rawDir, [W], { now: T, stamp: "s1" });
    expect(pendingIngest(await loadWallets(wh))).toEqual([W]);
    // Run 2 an hour later: W is not due again yet, but it is pending and gets ingested.
    const r = await daily(wh, h, rawDir, { now: T + 3600, reconcileSample: 0 });
    expect(r.ingested.wallets).toBe(1);
    expect(await wh.read("trades")).toHaveLength(1);
    expect(pendingIngest(await loadWallets(wh))).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.check.ok).toBe(true);
    const checks = await runChecks(wh);
    expect(checks.checks.map((c) => [c.name, c.ok])).toEqual([
      ["trades_unique", true], ["transfers_unique", true], ["lots_add_up", true], ["wallets_registered", true],
      ["snapshots_contiguous", true], ["snapshots_fresh", true], ["ingest_caught_up", true],
    ]);
  });
});

describe("check", () => {
  it("reports a gap in the snapshot days", async () => {
    const { wh } = setup();
    for (const day of ["2026-03-01", "2026-03-03"]) await wh.writeDay("wallet_metrics_daily", day, []);
    const r = await runChecks(wh);
    const gap = r.checks.find((c) => c.name === "snapshots_contiguous")!;
    expect([r.ok, gap.ok, gap.detail]).toEqual([false, false, "missing 1 day(s), first 2026-03-02"]);
  });
});

describe("principle 5 on the page", () => {
  it("hides wallets discovered after a past snapshot, never on the latest", () => {
    const d = "2026-03-01";
    expect(discoveredLater(bound(d) + 1, d, "2026-03-05")).toBe(true);
    expect(discoveredLater(bound(d), d, "2026-03-05")).toBe(false);
    expect(discoveredLater(bound(d) + DAY, "2026-03-05", "2026-03-05")).toBe(false);
  });
});

describe("concurrent fetching", () => {
  it("fetches several wallets side by side and keeps the request spacing", async () => {
    const { wh, rawDir } = setup();
    const wallets = [W, OTHER_W, "Wallet3333333333333333333333333333333333333", "Wallet4444444444444444444444444444444444444"];
    await addWallets(wh, wallets, { via: "manual", now: T - DAY });
    const times: number[] = [];
    const h = new HeliusClient("k", {
      fetch: (async () => {
        times.push(Date.now());
        await new Promise((r) => setTimeout(r, 30)); // network latency
        return ok({ data: [result] });
      }) as typeof fetch,
      minIntervalMs: 10,
      backoffMs: 0,
    });
    const r = await fetchWallets(wh, h, rawDir, wallets, { now: T, stamp: "s", concurrency: 4 });
    expect(Object.keys(r.fetched).sort()).toEqual([...wallets].sort());
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(9);
    // Four wallets with 30 ms latency each finish well under 4 × 30 ms when overlapped.
    expect(times.at(-1)! - times[0]).toBeLessThan(90);
    expect(Object.values(r.fetched).every((f) => f.credits === 10)).toBe(true);
  });
});

describe("rate limits", () => {
  it("spaces Parsed Events calls on their own limit, apart from plain RPC", async () => {
    const calls: { kind: string; at: number }[] = [];
    const h = new HeliusClient("k", {
      fetch: (async (u: string | URL | Request) => {
        calls.push({ kind: String(u).includes("parsed-events") ? "enhanced" : "rpc", at: Date.now() });
        return String(u).includes("parsed-events") ? ok({ data: [result] }) : ok({ result: null });
      }) as typeof fetch,
      enhancedRps: 10, // ~120 ms apart
      rpcRps: 1000,
      backoffMs: 0,
    });
    await Promise.all([
      (async () => {
        for (const w of [W, OTHER_W, W]) for await (const _ of h.transactionHistory(w)) void _;
      })(),
      Promise.all(["a", "b", "c"].map((s) => h.getTransaction(s))),
    ]);
    const enhanced = calls.filter((c) => c.kind === "enhanced").map((c) => c.at);
    expect(Math.min(...enhanced.slice(1).map((t, i) => t - enhanced[i]))).toBeGreaterThanOrEqual(115);
    // RPC calls are not held up behind the slower enhanced queue.
    const rpc = calls.filter((c) => c.kind === "rpc").map((c) => c.at);
    expect(Math.max(...rpc) - enhanced[0]).toBeLessThan(100);
  });
});

describe("adaptive throttle", () => {
  it("slows down on 429 and gets through", async () => {
    let n = 0;
    const h = new HeliusClient("k", {
      fetch: (async () => (++n <= 2 ? new Response("slow down", { status: 429 }) : ok({ data: [result] }))) as typeof fetch,
      minIntervalMs: 1,
      backoffMs: 1,
    });
    const pages = [];
    for await (const { response } of h.transactionHistory(W)) pages.push(response);
    expect(pages).toHaveLength(1);
    expect([h.rateLimited, h.requests]).toEqual([2, 3]);
  });
});

describe("request timeout", () => {
  it("gives up on a request that never answers and moves on to the next wallet", async () => {
    const { wh, rawDir } = setup();
    await addWallets(wh, [W, OTHER_W], { via: "manual", now: T - DAY });
    const h = new HeliusClient("k", {
      fetch: ((_u: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.address === OTHER_W) {
          // Hangs until aborted, like a dead connection.
          return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        }
        return Promise.resolve(ok({ data: [result] }));
      }) as typeof fetch,
      minIntervalMs: 0,
      backoffMs: 0,
      timeoutMs: 20,
    });
    const r = await fetchWallets(wh, h, rawDir, [OTHER_W, W], { now: T, stamp: "s", concurrency: 2 });
    expect(Object.keys(r.fetched)).toEqual([W]);
    expect(r.errors.map((e) => e.wallet)).toEqual([OTHER_W]);
  });
});

describe("ingest isolation", () => {
  it("skips a wallet whose raw files cannot be read and ingests the rest", async () => {
    const { wh, rawDir } = setup();
    await addWallets(wh, [W, OTHER_W], { via: "manual", now: T - DAY });
    const h = client(() => ok({ data: [result] }));
    await fetchWallets(wh, h, rawDir, [W], { now: T, stamp: "s" });
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const bad = path.join(rawDir, "helius", "transaction-history", OTHER_W);
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, "s.jsonl.gz"), "not gzip");
    const { ingestWallets } = await import("../src/lib/jobs");
    const r = await ingestWallets(wh, rawDir, [OTHER_W, W], T);
    expect(r.errors.map((e) => [e.step, e.wallet])).toEqual([["ingest", OTHER_W]]);
    expect(r.trades).toBe(1);
    const reg = new Map((await loadWallets(wh)).map((w) => [w.address, w]));
    expect([reg.get(W)!.last_ingested_at, reg.get(OTHER_W)!.last_ingested_at]).toEqual([T, null]);
  });
});

describe("backfill cap", () => {
  it("stops a first backfill at the page cap and starts history at the oldest page", async () => {
    const { wh, rawDir } = setup();
    await addWallets(wh, [W], { via: "manual", now: T - DAY });
    let page = 0;
    const h = client(() => {
      page += 1;
      const t = T - page * 3600;
      return ok({
        data: [{ ...result, signature: `s${page}`, parsed: { slot: t, blockTime: t }, rawTransaction: { ...BUY, blockTime: t } }],
        paginationToken: `p${page}`,
      });
    });
    const r = await fetchWallets(wh, h, rawDir, [W], { now: T, stamp: "s", maxPages: 3 });
    expect(r.fetched[W].truncated).toBe(true);
    const [w] = await loadWallets(wh);
    expect([w.fetch_cursor_time, w.history_from]).toEqual([T - 3600, T - 3 * 3600]);
  });
});
