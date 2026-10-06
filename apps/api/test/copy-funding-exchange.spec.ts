import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyFundingExchangeClient } from "../src/copy/copy-funding-exchange.client.js";
import type { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import type { FundingRow } from "../src/copy/copy-funding.repository.js";

const op: FundingRow = { id: "test", userId: 1, accountId: "account", strategyId: 1, idempotencyKey: "test-key", network: "testnet", address: `0x${"11".repeat(20)}`, destination: `0x${"22".repeat(20)}`, amount: "12.5", nonce: 1780000000000, status: "unknown", direction: "to_account", stopId: null, claimedAt: new Date(), attemptedAt: new Date(), evidenceHash: null, transactionHash: null, creditedAmount: null, fee: null, scanState: null, scanRevision: 0, liveSetupId: null, signerKind: null, createdAt: new Date(), updatedAt: new Date() };
const signature = `0x${"11".repeat(64)}1b`;
function client() { const budget = { acquire: vi.fn(async () => {}), liveCapacity: 1000, liveWaitMs: () => 0, refillMs: () => 0 }; return { budget, transport: new CopyFundingExchangeClient(budget as unknown as RequestBudgeterService) }; }
afterEach(() => vi.unstubAllGlobals());
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
  it("queries only the fixed explorer for a valid receipt hash and refuses arbitrary inputs", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ type: "txDetails", tx: {} }))); vi.stubGlobal("fetch", fetcher);
    const { transport, budget } = client(), hash = `0x${"aa".repeat(32)}`; await transport.txDetails("testnet", hash);
    expect(budget.acquire).toHaveBeenCalledWith(40, "live", 0, { signal: expect.any(AbortSignal) });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]; expect(url).toBe("https://rpc.hyperliquid-testnet.xyz/explorer"); expect(JSON.parse(init.body as string)).toEqual({ type: "txDetails", hash });
    expect(() => transport.txDetails("testnet", "https://foreign.example")).toThrow("Invalid funding evidence"); expect(fetcher).toHaveBeenCalledTimes(1);
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
  it("never retries response loss", async () => {
    const fetcher = vi.fn(async () => { throw new Error("response lost"); }); vi.stubGlobal("fetch", fetcher);
    await expect(client().transport.send(op, signature)).rejects.toThrow("funding_submission_unknown"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
