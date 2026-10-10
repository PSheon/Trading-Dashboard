import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyFundingExchangeClient, isFundingNotDispatched, consumeFundingNotDispatched } from "../src/copy/copy-funding-exchange.client.js";
import type { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { HyperliquidGlobalTransport } from "../src/hyperliquid/hyperliquid-global-transport.js";
import { LiveBoundaryError } from "../src/copy/live/wallet-authorization.js";
import type { FundingRow } from "../src/copy/copy-funding.repository.js";
import { RequestBudgeterService as RealRequestBudgeter } from "../src/hyperliquid/request-budgeter.service.js";
import type { AppConfig } from "../src/config/app-config.js";
import { testConfig } from "./config-test-utils.js";

const op: FundingRow = { id: "test", userId: 1, accountId: "account", strategyId: 1, idempotencyKey: "test-key", network: "testnet", address: `0x${"11".repeat(20)}`, destination: `0x${"22".repeat(20)}`, amount: "12.5", nonce: 1780000000000, status: "unknown", direction: "to_account", stopId: null, claimedAt: new Date(), attemptedAt: new Date(), evidenceHash: null, transactionHash: null, creditedAmount: null, fee: null, scanState: null, scanRevision: 0, liveSetupId: null, setupAbortId: null, createdAt: new Date(), updatedAt: new Date() };
const signature = `0x${"11".repeat(64)}1b`;
function client() { const budget = { acquire: vi.fn(async () => {}), liveCapacity: 1000, liveWaitMs: () => 0, refillMs: () => 0 }; return { budget, transport: new CopyFundingExchangeClient(budget as unknown as RequestBudgeterService) }; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("strategy funding trusted transport", () => {
  it("sends the immutable usdSend exactly once to its stored network with bounded waits and no redirects", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "ok", response: { type: "default" } }))); vi.stubGlobal("fetch", fetcher);
    const { transport, budget } = client(); await transport.acquire(); await transport.send(op, signature);
    expect(budget.acquire).toHaveBeenCalledWith(1, "live", 0, { signal: expect.any(AbortSignal) }); expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]; expect(url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ action: { type: "usdSend", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination: op.destination, amount: "12.5", time: op.nonce }, nonce: op.nonce, signature: { r: `0x${"11".repeat(32)}`, s: `0x${"11".repeat(32)}`, v: 27 } });
  });
  it.each([new Response("private response", { status: 503 }), new Response("invalid json"), new Response("x".repeat(65 * 1024))])("does not retry invalid upstream responses", async (response) => {
    const fetcher = vi.fn(async () => response); vi.stubGlobal("fetch", fetcher); await expect(client().transport.send(op, signature)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses actual transferable collateral from the original source", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ withdrawable: "12.499999" }))); vi.stubGlobal("fetch", fetcher);
    const { transport, budget } = client(); expect(await transport.available(op)).toBe(false);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]; expect(url).toBe("https://api.hyperliquid-testnet.xyz/info"); expect(JSON.parse(init.body as string)).toEqual({ type: "clearinghouseState", user: op.address });
    expect(budget.acquire).toHaveBeenCalledWith(2, "live", 0, expect.any(Object));
  });
  it('keeps balance checks on their original short admission wait', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { budget } = client();
    budget.liveWaitMs = () => 12_000; budget.refillMs = () => 120_000;
    await expect(new CopyFundingExchangeClient(budget as unknown as RequestBudgeterService).available(op)).rejects.toMatchObject({ retryMs: 12_000, reason: 'local_budget' });
    expect(budget.acquire).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("queries only the fixed explorer for a valid receipt hash and refuses arbitrary inputs", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ type: "txDetails", tx: {} }))); vi.stubGlobal("fetch", fetcher);
    const { transport, budget } = client(), hash = `0x${"aa".repeat(32)}`; await transport.txDetails("testnet", hash);
    expect(budget.acquire).toHaveBeenCalledWith(40, "live", 0, { signal: expect.any(AbortSignal) });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]; expect(url).toBe("https://rpc.hyperliquid-testnet.xyz/explorer"); expect(JSON.parse(init.body as string)).toEqual({ type: "txDetails", hash });
    expect(() => transport.txDetails("testnet", "https://foreign.example")).toThrow("Invalid funding evidence"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not wait indefinitely for receipt admission when a bucket refill estimate exceeds two minutes', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { budget } = client();
    budget.liveWaitMs = () => 120_001; budget.refillMs = () => 600_000;
    await expect(new CopyFundingExchangeClient(budget as unknown as RequestBudgeterService).txDetails('testnet', `0x${'aa'.repeat(32)}`))
      .rejects.toMatchObject({ retryMs: 120_001, reason: 'local_budget' });
    expect(budget.acquire).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps a receipt lookup queued behind original order evidence instead of abandoning its place after a ten-second estimate", async () => {
    vi.useFakeTimers();
    const base = testConfig().value;
    const budget = new RealRequestBudgeter({ value: { ...base, hyperliquid: { ...base.hyperliquid,
      budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } } } as AppConfig);
    const fetcher = vi.fn(async () => Response.json({ type: 'txDetails', tx: {} })); vi.stubGlobal('fetch', fetcher);
    try {
      await budget.acquire(800, 'live');
      const orderEvidence = budget.acquire(568, 'live', 0);
      void orderEvidence.catch(() => undefined); // Cleanup also observes a still-queued reservation after a failed assertion.
      const receipt = new CopyFundingExchangeClient(budget).txDetails('testnet', `0x${'aa'.repeat(32)}`);
      const result = receipt.then(value => ({ value }), error => ({ error }));
      expect(budget.queued().live).toBe(2);
      expect(fetcher).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100_000);
      await orderEvidence;
      expect(await result).toEqual({ value: { type: 'txDetails', tx: {} } });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://rpc.hyperliquid-testnet.xyz/explorer');
      expect(JSON.parse(init.body as string).type).toBe('txDetails');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(budget.queued().live).toBe(0);
    } finally { budget.onModuleDestroy(); }
  });
  it("account deletion: an account is empty only with no value above a cent, no position, no resting order and no spot balance", async () => {
    const answer = (perp: unknown, orders: unknown, spot: unknown) => vi.fn(async (_url: string, init: RequestInit) => {
      const type = JSON.parse(init.body as string).type;
      return new Response(JSON.stringify(type === "clearinghouseState" ? perp : type === "openOrders" ? orders : spot));
    });
    const perp = (accountValue: string, szi?: string) => ({ marginSummary: { accountValue }, withdrawable: accountValue, assetPositions: szi ? [{ position: { coin: "BTC", szi } }] : [] });
    const cases: Array<[unknown, unknown, unknown, boolean]> = [
      [perp("0.004"), [], { balances: [{ coin: "USDC", total: "0.0" }] }, true],
      [perp("12.5"), [], { balances: [] }, false],
      [perp("0", "0.01"), [], { balances: [] }, false],
      [perp("0"), [{ coin: "BTC", oid: 1 }], { balances: [] }, false],
      [perp("0"), [], { balances: [{ coin: "USDC", total: "3.2" }] }, false],
    ];
    for (const [p, o, sp, empty] of cases) {
      const fetcher = answer(p, o, sp); vi.stubGlobal("fetch", fetcher);
      expect((await client().transport.holdings("testnet", op.address)).empty).toBe(empty);
      expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)])).toEqual(["clearinghouseState", "openOrders", "spotClearinghouseState"]
        .map(type => ["https://api.hyperliquid-testnet.xyz/info", { type, user: op.address }]));
    }
    // An answer it can't read is never "empty".
    vi.stubGlobal("fetch", answer({ assetPositions: [] }, [], { balances: [] }));
    await expect(client().transport.holdings("testnet", op.address)).rejects.toThrow("Account holdings unavailable");
  });
  it("rechecks the quota permit after the caller's proof, and reports the send dispatched only after both passed", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "ok", response: { type: "default" } }))); vi.stubGlobal("fetch", fetcher);
    const global = Object.create(HyperliquidGlobalTransport.prototype) as HyperliquidGlobalTransport;
    const permit = { assertFresh: () => { throw new Error("hyperliquid_quota_expired"); }, dispatch: <T>(work: () => T) => work() };
    Object.defineProperty(global, "currentQuota", { value: () => ({ acquireRest: async () => permit }) });
    const budget = { acquire: vi.fn(async () => {}), liveCapacity: 1000, liveWaitMs: () => 0, refillMs: () => 0 };
    let proved = false, dispatched = false;
    await expect(new CopyFundingExchangeClient(budget as unknown as RequestBudgeterService, global).send(op, signature, () => { proved = true; }, () => { dispatched = true; })).rejects.toThrow("funding_not_dispatched");
    expect(proved).toBe(true); expect(dispatched).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });
  it('brands only original pre-dispatch errors and binds them to the exact original attempt', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const error = await client().transport.send(op, signature, () => {
      throw new LiveBoundaryError('funding_not_dispatched');
    }).catch(error => error);
    expect(isFundingNotDispatched(error, op)).toBe(true);
    expect(isFundingNotDispatched(new LiveBoundaryError('funding_not_dispatched'), op)).toBe(false);
    expect(isFundingNotDispatched(error, { ...op, nonce: op.nonce + 1 })).toBe(false);
    expect(isFundingNotDispatched(error, { ...op, attemptedAt: new Date(op.attemptedAt!.getTime() + 1) })).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('consumes genuine reset evidence once without burning it on a mismatched attempt', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const error = await client().transport.send(op, signature, () => { throw Error('expired proof'); }).catch(error => error);
    expect(consumeFundingNotDispatched(error, { ...op, nonce: op.nonce + 1 })).toBe(false);
    expect(consumeFundingNotDispatched(error, op)).toBe(true);
    expect(consumeFundingNotDispatched(error, op)).toBe(false);
    expect(isFundingNotDispatched(error, op)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['http', 'sdk', 'hook'] as const)('retains unknown after the %s dispatch boundary without minting reset evidence', async kind => {
    const fetcher = vi.fn(async () => {
      if (kind === 'sdk') throw new LiveBoundaryError('funding_not_dispatched');
      return new Response('upstream failed', { status: 503 });
    }); vi.stubGlobal('fetch', fetcher);
    const error = await client().transport.send(op, signature, () => undefined, () => {
      if (kind === 'hook') throw new LiveBoundaryError('funding_not_dispatched');
    }).catch(error => error);
    expect(error).toMatchObject({ code: 'funding_submission_unknown' });
    expect(isFundingNotDispatched(error, op)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(kind === 'hook' ? 0 : 1);
  });
  it("never retries response loss", async () => {
    const fetcher = vi.fn(async () => { throw new Error("response lost"); }); vi.stubGlobal("fetch", fetcher);
    await expect(client().transport.send(op, signature)).rejects.toThrow("funding_submission_unknown"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
