import { afterEach, describe, expect, it, vi } from "vitest";
import { WithdrawalExchangeClient } from "../src/wallet/withdrawal-exchange.client.js";
import type { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import type { WithdrawalRow } from "../src/wallet/withdrawal.repository.js";
import { offlineGlobalTransport } from './hyperliquid-global-test-utils.js';

const op: WithdrawalRow = { id: "test", userId: 1, network: "testnet", address: `0x${"11".repeat(20)}`, destination: `0x${"22".repeat(20)}`, amount: "12.5", nonce: 1780000000000, status: "unknown", origin: "client", claimedAt: new Date(), attemptedAt: new Date(), evidenceHash: null, createdAt: new Date(), updatedAt: new Date() };
const signature = `0x${"11".repeat(64)}1b`;
function client() {
  const budget = { acquire: vi.fn(async () => {}) };
  const global = offlineGlobalTransport(fetch);
  return { budget, global, client: new WithdrawalExchangeClient(budget as unknown as RequestBudgeterService, global.transport) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("trusted withdrawal transport", () => {
  it("uses the stored network and exact immutable payload, with bounded queueing and no redirects", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "ok", response: { type: "default" } })));
    vi.stubGlobal("fetch", fetcher);
    const { client: transport, budget } = client();
    await transport.acquire();
    expect(budget.acquire).toHaveBeenCalledWith(1, "live", 0, { signal: expect.any(AbortSignal) });
    expect(await transport.send(op, signature, () => {})).toEqual({ status: "ok", response: { type: "default" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ action: { type: "withdraw3", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination: op.destination, amount: "12.5", time: op.nonce }, nonce: op.nonce, signature: { r: `0x${"11".repeat(32)}`, s: `0x${"11".repeat(32)}`, v: 27 } });
  });
  it.each([new Response("private response", { status: 503 }), new Response("invalid json"), new Response("x".repeat(65 * 1024))])("never retries or exposes invalid upstream data", async (response) => {
    const fetcher = vi.fn(async () => response); vi.stubGlobal("fetch", fetcher);
    await expect(client().client.send(op, signature, () => {})).rejects.toThrow('withdrawal_submission_unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not retry a transport failure", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network down"); }); vi.stubGlobal("fetch", fetcher);
    await expect(client().client.send(op, signature, () => {})).rejects.toThrow('withdrawal_submission_unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('denies a withdrawal before transport when shared quota is unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher); const f = client();
    f.global.acquire.mockRejectedValueOnce(Error('quota exhausted'));
    await expect(f.client.send(op, signature, () => {})).rejects.toThrow('withdrawal_submission_unknown');
    expect(f.global.acquire).toHaveBeenCalledWith(1, expect.any(Number)); expect(fetcher).not.toHaveBeenCalled();
  });
  it('rechecks the original shared permit after the final identity proof and never renews it', async () => {
    let now = Date.now(); const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    const global = offlineGlobalTransport(fetcher, () => now), transport = new WithdrawalExchangeClient({} as RequestBudgeterService, global.transport);
    await expect(transport.send(op, signature, () => { now += 5001; })).rejects.toThrow('withdrawal_submission_unknown');
    expect(global.acquire).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires a synchronous captured proof and a concrete shared transport', async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    await expect(client().client.send(op, signature)).rejects.toThrow('withdrawal_submission_unknown');
    await expect(new WithdrawalExchangeClient({} as RequestBudgeterService).send(op, signature, () => {})).rejects.toThrow('withdrawal_submission_unknown');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
