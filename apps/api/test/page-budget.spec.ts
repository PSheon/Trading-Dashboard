import { testConfig } from "./config-test-utils.js";
import { Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clientKey } from "../src/common/http/client-key.js";
import { MAX_QUEUED, PAGE_RANK, PAGE_SHARE, PageBusyError, RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";
import { withRequestSignal } from "../src/runtime/request-context.js";
import { requestContext } from "../src/runtime/request-middleware.js";
import { TradeAnalyticsController, MAX_PENDING_PER_CLIENT } from "../src/traders/trade-analytics.controller.js";
import { BusyException } from "../src/traders/busy.js";
import type { TradeAnalyticsService } from "../src/traders/trade-analytics.service.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

/** Runs `work` as if inside an HTTP request from `client`. */
function asClient<T>(client: string, work: () => T, answered = new AbortController()): T {
  return withRequestSignal(new AbortController().signal, work, undefined, { client, answered: answered.signal });
}

/** Where a promise got to, without leaving a rejection unhandled. */
function track(p: Promise<unknown>) {
  const s: { state: "queued" | "sent" | "refused"; reason?: unknown } = { state: "queued" };
  p.then(() => { s.state = "sent"; }, (reason: unknown) => { s.state = "refused"; s.reason = reason; });
  return s;
}

/** A portfolio call for a random address, as `/traders/sparklines` makes it. */
const pageCall = (budget: RequestBudgeterService) => budget.acquire(20, "background", PAGE_RANK.fills);

/** A budgeter at 600/min (0.01 weight/ms) whose 20-token bucket starts empty. */
async function drained(): Promise<RequestBudgeterService> {
  vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "600");
  vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "20");
  const budget = new RequestBudgeterService(testConfig());
  await budget.acquire(20, "live");
  return budget;
}

describe("clientKey", () => {
  it("keys IPv4 per address and IPv6 per /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("not-an-ip")).toBe("unknown");
  });
});

describe("page work in the Hyperliquid budget", () => {
  it("a burst of random-address page requests can't push watcher-priority work out", async () => {
    vi.useFakeTimers();
    const budget = await drained();
    // ~35 sparkline requests × 30 random addresses from one client …
    const one = Array.from({ length: 35 * 30 }, () => track(asClient("198.51.100.1", () => pageCall(budget))));
    await vi.advanceTimersByTimeAsync(0);
    expect(budget.pageQueuedWeight("198.51.100.1")).toBeLessThanOrEqual(budget.pageClientQueueMax);
    // … and the same again spread over 200 clients.
    const many = Array.from({ length: 35 * 30 }, (_, i) => track(asClient(`198.51.100.${i % 200}`, () => pageCall(budget))));
    await vi.advanceTimersByTimeAsync(0);
    const refused = [...one, ...many].filter((r) => r.state === "refused");
    expect(refused.length).toBeGreaterThan(2000);
    expect(refused.every((r) => r.reason instanceof PageBusyError)).toBe(true);
    // The page queue stays within its caps, overall and per client.
    expect(budget.pageQueuedWeight()).toBeLessThanOrEqual(budget.pageQueueMax);
    expect(budget.pageQueuedWeight("198.51.100.1")).toBeLessThanOrEqual(budget.pageClientQueueMax);

    // The watcher's queue is untouched: a full queue of other work still
    // fits, and a live call goes before every page waiter.
    const order: string[] = [];
    const background = Array.from({ length: MAX_QUEUED - 1 }, () => budget.acquire(2, "background").catch(() => undefined));
    const live = budget.acquire(2, "live").then(() => order.push("live"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300);
    await live;
    expect(order).toEqual(["live"]);
    budget.onModuleDestroy();
    await Promise.all(background);
  });

  it("gives other background work the budget once page work has spent its share", { timeout: 60_000 }, async () => {
    vi.useFakeTimers();
    const budget = await drained();
    const order: string[] = [];
    let pageWeight = 0;
    let n = 0;
    // Page work keeps coming from many clients, always first in rank …
    const feed = (): void => {
      void asClient(`203.0.113.${n++ % 250}`, () => pageCall(budget))
        .then(() => { pageWeight += 20; order.push("page"); feed(); }, () => undefined);
    };
    for (let i = 0; i < 5; i++) feed();
    // … while fill storage behind the alerts waits.
    let stored = 0;
    const store = (): void => {
      budget.acquire(20, "background").then(() => { stored += 1; order.push("store"); store(); }, () => undefined);
    };
    store();
    // The share is measured over three minutes (a few cold pages in a row
    // go out at once); over ten the flood is held to it.
    await vi.advanceTimersByTimeAsync(600_000);
    // Page work got about its share and no more; the rest went to storage.
    expect(stored).toBeGreaterThan(0);
    const total = pageWeight + stored * 20;
    expect(pageWeight / total).toBeLessThanOrEqual(PAGE_SHARE + 0.1);
    budget.onModuleDestroy();
  });

  it("drops page work still queued once its request has been answered", async () => {
    vi.useFakeTimers();
    const budget = await drained();
    const answered = new AbortController();
    const page = asClient("192.0.2.1", () => pageCall(budget), answered);
    // Background work started from a request (explicit rank, not page) keeps going.
    const sweep = asClient("192.0.2.1", () => budget.acquire(2, "background"), answered);
    const rejected = expect(page).rejects.toMatchObject({ name: "AbortError" });
    answered.abort(new DOMException("Response already sent", "AbortError"));
    await rejected;
    expect(budget.pageQueuedWeight()).toBe(0);
    expect(budget.pageQueuedWeight("192.0.2.1")).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(sweep).resolves.toBeUndefined();
    budget.onModuleDestroy();
  });

  it("the HTTP middleware drops a request's queued Hyperliquid calls when it answers or the client goes away", async () => {
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "600");
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "20");
    const budget = new RequestBudgeterService(testConfig());
    await budget.acquire(20, "live");
    const outcomes: string[] = [];
    let seen: string | undefined;
    @Controller("probe") class Probe {
      @Get() read() {
        // Five portfolio calls for this page, answered before any goes out.
        for (let i = 0; i < 5; i++) pageCall(budget).then(() => outcomes.push("sent"), (e: Error) => outcomes.push(e.name));
        seen = budget.pageQueuedWeight() > 0 ? "queued" : "none";
        return { ok: true };
      }
    }
    const ref = await Test.createTestingModule({ controllers: [Probe] }).compile();
    const app = ref.createNestApplication({ logger: false });
    app.use(requestContext(new BackgroundJobs()));
    await app.init();
    try {
      await request(app.getHttpServer()).get("/probe").expect(200);
      await vi.waitFor(() => expect(outcomes).toHaveLength(5));
      expect(seen).toBe("queued");
      expect(outcomes).toEqual(Array(5).fill("AbortError"));
      expect(budget.queued()).toEqual({ live: 0, background: 0 });
      expect(budget.pageQueuedWeight()).toBe(0);
    } finally { await app.close(); budget.onModuleDestroy(); }
  });
});

describe("trade analytics per client", () => {
  it(`answers busy past ${MAX_PENDING_PER_CLIENT} cold addresses in progress for one client, not for others`, async () => {
    const never = new Promise<never>(() => undefined);
    const stored = new Set<string>();
    const analytics = { analytics: vi.fn((address: string) => stored.has(address) ? Promise.resolve({ address }) : never), trades: vi.fn(() => never),
      isStored: vi.fn(async (address: string) => stored.has(address)) } as unknown as TradeAnalyticsService;
    const controller = new TradeAnalyticsController(analytics);
    controller.pageDeadlineMs = 10;
    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    const ask = (client: string, n: number) => asClient(client, () => controller.summary({ address: addr(n) }, { window: "all" }));
    for (let n = 0; n < MAX_PENDING_PER_CLIENT; n++) await expect(ask("198.51.100.9", n)).rejects.toBeInstanceOf(BusyException);
    expect(analytics.analytics).toHaveBeenCalledTimes(MAX_PENDING_PER_CLIENT);
    // A fourth address is refused without starting a computation …
    await expect(ask("198.51.100.9", 99)).rejects.toBeInstanceOf(BusyException);
    expect(analytics.analytics).toHaveBeenCalledTimes(MAX_PENDING_PER_CLIENT);
    // … an address already in progress may be asked again …
    await expect(ask("198.51.100.9", 0)).rejects.toBeInstanceOf(BusyException);
    expect(analytics.analytics).toHaveBeenCalledTimes(MAX_PENDING_PER_CLIENT + 1);
    // … and another client is unaffected.
    await expect(ask("198.51.100.10", 99)).rejects.toBeInstanceOf(BusyException);
    expect(analytics.analytics).toHaveBeenCalledTimes(MAX_PENDING_PER_CLIENT + 2);
    // An address whose figures are stored is answered at once, even past the limit (item 6).
    stored.add(addr(77));
    await expect(ask("198.51.100.9", 77)).resolves.toEqual({ address: addr(77) });
  });

  it("maps a refused page budget to 503 busy, not 502", async () => {
    const analytics = { analytics: vi.fn(async () => { throw new PageBusyError(); }) } as unknown as TradeAnalyticsService;
    const controller = new TradeAnalyticsController(analytics);
    await expect(controller.summary({ address: `0x${"1".repeat(40)}` }, { window: "all" })).rejects.toBeInstanceOf(BusyException);
  });
});

describe("one honest cold page", () => {
  it("fits a client's page share at the default budget even when nothing has gone out yet", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", undefined);
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", undefined);
    const budget = new RequestBudgeterService(testConfig());
    await budget.acquire(budget.introspect().burstCapacity, "live"); // empty bucket: nothing dispatches
    const calls: ReturnType<typeof track>[] = [];
    await asClient("203.0.113.50", async () => {
      // Profile: dex list, 9 dexes' clearinghouse states, spot, account mode,
      // staking, price book; the chart; activity's two fill lists (base 20,
      // worst case 120 each).
      calls.push(track(budget.acquire(20, "background", PAGE_RANK.profile)));
      for (let i = 0; i < 9; i++) calls.push(track(budget.acquire(2, "background", PAGE_RANK.profile)));
      for (const w of [2, 20, 20, 22]) calls.push(track(budget.acquire(w, "background", PAGE_RANK.profile)));
      calls.push(track(budget.acquire(20, "background", PAGE_RANK.portfolio)));
      for (let i = 0; i < 2; i++) calls.push(track(budget.acquire(120, "background", PAGE_RANK.fills, { known: 20 })));
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.state === "refused")).toEqual([]);
    budget.onModuleDestroy();
  });
});
