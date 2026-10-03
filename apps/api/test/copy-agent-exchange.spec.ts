import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivyAgentApprovalClient } from "../src/copy/copy-agent-exchange.client.js";
import type { AgentConsentIntent } from "../src/copy/copy-agent-consent.js";

const time = 1_800_000_000_000;
const intent: AgentConsentIntent = { id: "operation", strategyId: 1, network: "testnet", accountAddress: `0x${"11".repeat(20)}`,
  agentAddress: `0x${"22".repeat(20)}`, policyId: "policy", workerQuorumId: "worker", nonce: time, expiresAt: time + 86_400_000, consentExpiresAt: time + 300_000 };
const signature = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
afterEach(() => vi.unstubAllGlobals());
describe("exact testnet master approval transport", () => {
  it("submits the exact finite-lived approval action with no JWT or alternate network fields", async () => {
    const request = vi.fn(async () => Response.json({ status: "ok", response: { type: "default" } }));
    const client = new PrivyAgentApprovalClient({}, async () => undefined, request, () => time);
    await client.send(intent, signature);
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(JSON.parse(String(options.body))).toEqual({ action: { type: "approveAgent", signatureChainId: "0x66eee", hyperliquidChain: "Testnet",
      agentAddress: intent.agentAddress, agentName: `copy1 valid_until ${intent.expiresAt}`, nonce: time }, nonce: time,
      signature: { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 } });
    expect(options.redirect).toBe("error");
  });
  it("cannot submit expired consent or mainnet approval", async () => {
    const request = vi.fn();
    const client = new PrivyAgentApprovalClient({}, async () => undefined, request, () => intent.consentExpiresAt);
    await expect(client.send(intent, signature)).rejects.toThrow("agent_consent_expired");
    await expect(client.send({ ...intent, network: "mainnet" }, signature)).rejects.toThrow("invalid_agent_consent");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { list: [] },
    { list: [{ address: intent.agentAddress, name: "copy1", validUntil: intent.expiresAt }] },
  ])("observes fresh exact approval without treating absent agents as approval", async ({ list }) => {
    const budget = vi.fn(async (_weight: number) => undefined);
    const request = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => Response.json(JSON.parse(String(options?.body)).type === "userRole" ? { role: "user" } : list));
    const client = new PrivyAgentApprovalClient({}, budget, request, () => time);
    await expect(client.observe(intent)).resolves.toEqual(list.length ? { checkedAt: time, validUntil: intent.expiresAt } : null);
    expect(budget.mock.calls.map(c => c[0])).toEqual([60, 20]);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { list: [{ address: intent.agentAddress, name: "copy2", validUntil: intent.expiresAt }] },
    { list: [{ address: intent.agentAddress, name: "copy1", validUntil: null }] },
    { list: [{ address: intent.agentAddress, name: "copy1", validUntil: intent.expiresAt + 1 }] },
    { list: [{ address: intent.agentAddress, name: "copy1", validUntil: intent.expiresAt }, { address: intent.agentAddress, name: "copy1", validUntil: intent.expiresAt }] },
  ])("rejects contradictory approval metadata", async ({ list }) => {
    const request = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => Response.json(JSON.parse(String(options?.body)).type === "userRole" ? { role: "user" } : list));
    await expect(new PrivyAgentApprovalClient({}, async () => undefined, request, () => time).observe(intent)).rejects.toThrow("agent_approval_evidence_unavailable");
  });
  it("rejects evidence that aged while waiting for exchange budget", async () => {
    let now = time;
    const request = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => Response.json(JSON.parse(String(options?.body)).type === "userRole" ? { role: "user" } : [{ address: intent.agentAddress, name: "copy1", validUntil: intent.expiresAt }]));
    const client = new PrivyAgentApprovalClient({}, async () => { now += 3_000; }, request, () => now);
    await expect(client.observe(intent)).rejects.toThrow("agent_approval_evidence_unavailable");
  });
  it("rejects a foreign Privy master before JWT exchange or RPC, using the installed SDK", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: Request | string | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url.pathname);
      return Response.json({ id: "master", chain_type: "ethereum", address: intent.accountAddress, owner_id: "foreign", archived_at: null });
    });
    const client = new PrivyAgentApprovalClient({ appId: "test-app", appSecret: "test-secret" }, async () => undefined, fetch, () => time);
    await expect(client.signMaster({ walletId: "master", address: intent.accountAddress, ownerQuorumId: "owner" }, intent, "user-jwt")).rejects.toThrow("agent_master_approval_unavailable");
    expect(requests).toEqual(["/v1/wallets/master"]);
  });
  it("redacts provider errors and never retries an ambiguous SDK read", async () => {
    const request = vi.fn(async () => Response.json({ error: "secret token and provider payload" }, { status: 500 }));
    vi.stubGlobal("fetch", request);
    const client = new PrivyAgentApprovalClient({ appId: "test-app", appSecret: "test-secret" }, async () => undefined, request, () => time);
    await expect(client.signMaster({ walletId: "master", address: intent.accountAddress, ownerQuorumId: "owner" }, intent, "user-jwt")).rejects.toThrow(/^agent_master_approval_unavailable$/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
