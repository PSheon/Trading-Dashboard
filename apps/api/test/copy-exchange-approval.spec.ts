import { describe, expect, it, vi } from "vitest";
import { HyperliquidAgentApprovalVerifier } from "../src/copy/live/hyperliquid-agent-approval.js";
import { LiveBoundaryError, WalletAuthorizationService, type ExchangeApprovalEvidence, type WalletAuthorization, type WalletRequest } from "../src/copy/live/wallet-authorization.js";

const now = 1_790_000_000_000;
const account = `0x${"ab".repeat(20)}` as const;
const signer = `0x${"cd".repeat(20)}` as const;
const grant: WalletAuthorization = { id: "grant", version: 1, userId: 1, strategyId: 2, walletId: "wallet", privyOwnerId: "quorum",
  signerAddress: signer, accountAddress: account, network: "testnet", scopes: ["copy:trade", "copy:reduce"],
  validFrom: now - 1, expiresAt: now + 100_000, revokedAt: null, exchangeApprovedAt: now - 1 };
const request: WalletRequest = { authorizationId: grant.id, userId: grant.userId, strategyId: grant.strategyId, walletId: grant.walletId,
  network: grant.network, accountAddress: account, reduceOnly: false };
const evidence: ExchangeApprovalEvidence = { network: "testnet", accountAddress: account, signerAddress: signer, checkedAt: now, expiresAt: now + 100_000 };

function setup() {
  let clock = now;
  let masterRole: unknown = { role: "user" };
  let signerRole: unknown = { role: "agent", data: { user: account } };
  let agents: unknown = [{ address: signer, name: "copy-2", validUntil: now + 100_000 }];
  const acquire = vi.fn(async () => {});
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    const data = body.type === "extraAgents" ? agents : body.user === account ? masterRole : signerRole;
    return new Response(JSON.stringify(data), { status: 200 });
  });
  const verifier = new HyperliquidAgentApprovalVerifier("testnet", acquire, fetcher, () => clock);
  return { verifier, fetcher, acquire, clock: (value: number) => { clock = value; },
    roles: (master: unknown, agent: unknown = signerRole) => { masterRole = master; signerRole = agent; },
    agents: (value: unknown) => { agents = value; } };
}

describe("fresh Hyperliquid agent approval evidence", () => {
  it("queries the fixed network and actual master account; accepts explicit named agent evidence", async () => {
    const { verifier, fetcher, acquire } = setup();
    expect(await verifier.verify(grant)).toEqual(evidence);
    expect(acquire).toHaveBeenCalledExactlyOnceWith(20);
    const bodies = fetcher.mock.calls.map(([url, options]) => {
      expect(url).toBe("https://api.hyperliquid-testnet.xyz/info");
      expect(options).toMatchObject({ method: "POST", redirect: "error" });
      return JSON.parse(String(options?.body));
    });
    expect(bodies).toEqual([{ type: "extraAgents", user: account }]);
  });
  it("never reuses a successful observation after exchange revocation", async () => {
    const s = setup();
    await s.verifier.verify(grant);
    s.agents([]);
    await expect(s.verifier.verify(grant)).rejects.toThrow("exchange_agent_not_approved");
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([now, now - 1, -1, now + 0.5, "forever", undefined])("rejects expired or malformed expiry %s", async (validUntil) => {
    const s = setup(); s.agents([{ address: signer, name: "copy-2", validUntil }]);
    await expect(s.verifier.verify(grant)).rejects.toThrow();
  });
  it("accepts provider null expiry while local consent retains its own expiry", async () => {
    const s = setup(); s.agents([{ address: signer.toUpperCase().replace("0X", "0x"), name: "copy-2", validUntil: null }]);
    expect((await s.verifier.verify(grant)).expiresAt).toBeNull();
  });
  it.each([[], [{ address: signer, name: "a", validUntil: null }, { address: signer, name: "b", validUntil: null }],
    [{ address: account, name: "foreign", validUntil: null }], { status: "ok" }])("refuses absent, duplicate or malformed listing %j", async (agents) => {
    const s = setup(); s.agents(agents);
    await expect(s.verifier.verify(grant)).rejects.toThrow();
  });
  it.each(["missing", "vault", "agent", "subAccount"])("refuses self signing with unsupported account role %s", async (role) => {
    const s = setup(); s.roles({ role, data: { user: account, master: account } });
    await expect(s.verifier.verify({ ...grant, signerAddress: account })).rejects.toThrow("unsupported_execution_account_role");
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it("self signing requires an actual master account and does not invent an agent listing", async () => {
    const s = setup();
    expect(await s.verifier.verify({ ...grant, signerAddress: account })).toEqual({ ...evidence, signerAddress: account, expiresAt: null });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.acquire).toHaveBeenCalledExactlyOnceWith(60);
  });
  it("rejects another network before any request or budget acquisition", async () => {
    const s = setup();
    await expect(s.verifier.verify({ ...grant, network: "mainnet" })).rejects.toThrow("exchange_approval_network_mismatch");
    expect(s.fetcher).not.toHaveBeenCalled(); expect(s.acquire).not.toHaveBeenCalled();
  });
  it("mainnet configuration cannot query testnet", async () => {
    const s = setup();
    const verifier = new HyperliquidAgentApprovalVerifier("mainnet", s.acquire, s.fetcher, () => now);
    expect((await verifier.verify({ ...grant, network: "mainnet" })).network).toBe("mainnet");
    expect(s.fetcher.mock.calls.every(([url]) => url === "https://api.hyperliquid.xyz/info")).toBe(true);
  });
  it("stale observations, including time spent waiting for budget, cannot authorize trading", async () => {
    const s = setup();
    s.acquire.mockImplementationOnce(async () => { s.clock(now + 5_001); });
    await expect(s.verifier.verify(grant)).rejects.toThrow("exchange_approval_evidence_expired");
  });
  it.each(["http", "json", "large", "redirect", "budget"])("fails closed on %s and sanitizes remote errors", async (failure) => {
    const s = setup();
    if (failure === "budget") s.acquire.mockRejectedValue(new Error("Sensitive credential"));
    else s.fetcher.mockImplementation(async () => {
      if (failure === "redirect") throw new Error("Sensitive credential");
      if (failure === "http") return new Response("Sensitive credential", { status: 503 });
      if (failure === "json") return new Response("Sensitive credential", { status: 200 });
      return new Response(JSON.stringify({ data: "x".repeat(65_537) }));
    });
    await expect(s.verifier.verify(grant)).rejects.toThrow("exchange_approval_unavailable");
    expect(s.fetcher.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("local consent and exchange proof are both required", () => {
  it("a historical approval timestamp cannot substitute for a verifier", async () => {
    const authority = new WalletAuthorizationService({ find: async () => grant }, undefined as never, () => now);
    await expect(authority.authorize(request)).rejects.toThrow("exchange_approval_verifier_missing");
  });
  it("checks the exchange on every call, including reduce-only orders", async () => {
    const verify = vi.fn(async () => evidence);
    const authority = new WalletAuthorizationService({ find: async () => grant }, { verify }, () => now);
    await authority.authorize(request); await authority.authorize({ ...request, reduceOnly: true });
    expect(verify).toHaveBeenCalledTimes(2);
    verify.mockRejectedValue(new LiveBoundaryError("exchange_agent_not_approved"));
    await expect(authority.authorize(request)).rejects.toThrow("exchange_agent_not_approved");
  });
  it.each([{ network: "mainnet" }, { accountAddress: signer }, { signerAddress: account }, { checkedAt: now + 1 },
    { checkedAt: now - 5_001 }, { expiresAt: now }, { expiresAt: undefined }])("refuses mismatched or stale proof %j", async (override) => {
    const authority = new WalletAuthorizationService({ find: async () => grant }, { verify: async () => ({ ...evidence, ...override }) as ExchangeApprovalEvidence }, () => now);
    await expect(authority.authorize(request)).rejects.toThrow("exchange_approval_evidence_invalid");
  });
  it.each(["revoked", "rotated", "disabled", "expired"])("rechecks local %s after remote observation", async (change) => {
    let current: WalletAuthorization | null = structuredClone(grant);
    let clock = now;
    const authority = new WalletAuthorizationService({ find: async () => current }, { verify: async () => {
      if (change === "revoked") current = { ...grant, revokedAt: now };
      if (change === "rotated") current = { ...grant, version: 2 };
      if (change === "disabled") current = null;
      if (change === "expired") clock = grant.expiresAt;
      return evidence;
    } }, () => clock);
    await expect(authority.authorize(request)).rejects.toThrow();
  });
  it("does not query the exchange for already revoked local consent", async () => {
    const verify = vi.fn();
    const authority = new WalletAuthorizationService({ find: async () => ({ ...grant, revokedAt: now }) }, { verify }, () => now);
    await expect(authority.authorize(request)).rejects.toThrow("wallet_authorization_revoked");
    expect(verify).not.toHaveBeenCalled();
  });
});
