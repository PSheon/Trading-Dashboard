import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { WALLET_NETWORKS, approveBuilderFeeTypedData, usdSendTypedData, withdraw3TypedData } from "@trading-dashboard/shared/contracts";

import { canonical, masterPolicyRules, MASTER_POLICY_NAME, PrivyMasterPolicy } from "../src/copy/live/privy-master-policy.js";
import { PrivyPolicyMasterSigner } from "../src/copy/live/privy-policy-master-signer.js";

const ownerMain = `0x${"5a".repeat(20)}`, other = `0x${"6b".repeat(20)}`;
const copyKey = privateKeyToAccount(`0x${"07".repeat(32)}`);
const account = copyKey.address.toLowerCase();
const binding = { ownerMain: ownerMain.toUpperCase().replace("0X", "0x"), account };
const cond = (rule: { conditions: { field: string; value: unknown }[] }, field: string) => rule.conditions.find(c => c.field === field)?.value;

describe("the copy account's master policy (one-click plan §2)", () => {
  it("allows a testnet UsdSend only to the owner's main wallet (lowercase), the account's own standard mode, and denies export", () => {
    const rules = masterPolicyRules(binding);
    expect(rules.map(r => [r.method, r.action])).toEqual([["eth_signTypedData_v4", "ALLOW"], ["eth_signTypedData_v4", "ALLOW"], ["exportPrivateKey", "DENY"], ["exportSeedPhrase", "DENY"]]);
    const [send, mode] = rules as unknown as { conditions: { field: string; value: unknown; typed_data?: { primary_type: string } }[] }[];
    expect(cond(send!, "chainId")).toBe("421614");
    expect(cond(send!, "verifyingContract")).toBe(`0x${"00".repeat(20)}`);
    expect(cond(send!, "destination")).toBe(ownerMain);
    expect(cond(send!, "hyperliquidChain")).toBe("Testnet");
    expect(send!.conditions.filter(c => c.typed_data).every(c => c.typed_data!.primary_type === "HyperliquidTransaction:UsdSend")).toBe(true);
    expect(cond(mode!, "abstraction")).toBe("disabled");
    expect(cond(mode!, "user")).toBe(account);
    // The agent and builder rules appear only when bound.
    const full = masterPolicyRules({ ...binding, agent: { address: other, name: "copy7 valid_until 1" }, builder: { address: other, maxFeeRate: "0.01%" } });
    expect(full).toHaveLength(6);
    expect(() => masterPolicyRules({ ...binding, ownerMain: "nope" })).toThrow();
  });

  it("creates the policy owned by the user and verifies exactly; it never changes a wallet's signers", async () => {
    const policies = { create: vi.fn(async () => ({ id: "policy-1" })), get: vi.fn() };
    const wallets = { update: vi.fn(async () => ({})), get: vi.fn() };
    const keyQuorums = { get: vi.fn(async () => ({ id: "owner-q", authorization_threshold: 1, authorization_keys: [], user_ids: ["did:privy:u"], key_quorum_ids: [] })) };
    const client = { policies: () => policies, wallets: () => wallets, keyQuorums: () => keyQuorums };
    const privy = new PrivyMasterPolicy({}, client as never);
    expect(await privy.create("did:privy:u", binding, "master-acc-1")).toEqual({ id: "policy-1" });
    expect(policies.create).toHaveBeenCalledWith(expect.objectContaining({ owner: { user_id: "did:privy:u" }, idempotency_key: "master-acc-1", name: MASTER_POLICY_NAME, chain_type: "ethereum" }));
    const stored = { id: "policy-1", owner_id: "owner-q", name: MASTER_POLICY_NAME, version: "1.0", chain_type: "ethereum", rules: masterPolicyRules(binding).map((r, i) => ({ id: `r${i}`, ...r })) };
    policies.get.mockResolvedValue(stored);
    const verified = await privy.verify("policy-1", "did:privy:u", binding);
    expect(verified).toMatchObject({ id: "policy-1", ownerQuorumId: "owner-q", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Another destination, or another owner, is a conflict.
    await expect(privy.verify("policy-1", "did:privy:u", { ...binding, ownerMain: other })).rejects.toThrow("master_policy_conflict");
    await expect(privy.verify("policy-1", "did:privy:someone", binding)).rejects.toThrow("master_policy_conflict");
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(wallets.update).not.toHaveBeenCalled();
  });

  it("accepts the policy as Privy stores it: address-typed values come back checksummed (Stage 2026-10-06), strings exactly", async () => {
    const policies = { create: vi.fn(), get: vi.fn() };
    const keyQuorums = { get: vi.fn(async () => ({ id: "owner-q", authorization_threshold: 1, authorization_keys: [], user_ids: ["did:privy:u"], key_quorum_ids: [] })) };
    const privy = new PrivyMasterPolicy({}, { policies: () => policies, wallets: () => ({}), keyQuorums: () => keyQuorums } as never);
    const agent = { address: `0x${"ab".repeat(20)}`, name: "copy7 valid_until 1" }, bound = { ...binding, agent };
    const checksum = (value: string) => `0x${value.slice(2).split("").map((c, i) => i % 2 ? c.toUpperCase() : c).join("")}`;
    // Privy rewrites every \`address\`-typed condition value (user, agentAddress) in checksum case.
    const stored = (destination?: string) => ({ id: "policy-1", owner_id: "owner-q", name: MASTER_POLICY_NAME, version: "1.0", chain_type: "ethereum",
      rules: masterPolicyRules(bound).map((r, i) => ({ id: `r${i}`, ...r, conditions: (r.conditions as { field: string; value: unknown }[]).map(c =>
        ["user", "agentAddress"].includes(c.field) ? { ...c, value: checksum(String(c.value)) } : c.field === "destination" && destination ? { ...c, value: destination } : c) })) });
    policies.get.mockResolvedValue(stored());
    await expect(privy.verify("policy-1", "did:privy:u", bound)).resolves.toMatchObject({ id: "policy-1" });
    // A string-typed value (the UsdSend destination) must still match exactly: Privy compares it as written.
    policies.get.mockResolvedValue(stored(checksum(ownerMain)));
    await expect(privy.verify("policy-1", "did:privy:u", bound)).rejects.toThrow("master_policy_conflict");
  });

  it("account deletion checks with the app secret that no signer is left (the owner's browser removed it)", async () => {
    const wallets = { update: vi.fn(async () => ({})), get: vi.fn(async () => ({ id: "wallet-1", address: account, owner_id: "owner-q", policy_ids: [], additional_signers: [] })) };
    const privy = new PrivyMasterPolicy({}, { wallets: () => wallets } as never);
    await privy.assertDetached("wallet-1");
    // Still a signer, or Privy can't tell: never reported as detached.
    wallets.get.mockResolvedValueOnce({ id: "wallet-1", address: account, owner_id: "owner-q", policy_ids: [], additional_signers: [{ signer_id: "worker-q", override_policy_ids: ["policy-1"] }] } as never);
    await expect(privy.assertDetached("wallet-1")).rejects.toThrow("master_policy_conflict");
    wallets.get.mockRejectedValueOnce(new Error("provider detail"));
    await expect(privy.assertDetached("wallet-1")).rejects.toThrow("master_policy_unavailable");
    expect(wallets.update).not.toHaveBeenCalled();
  });
});

describe("the worker signs as a copy account only under the owner's policy (PrivyPolicyMasterSigner)", () => {
  const cfg = { appId: "a", appSecret: "s", workerQuorumId: "worker-q", authorizationPrivateKey: "wallet-auth:key" };
  const target = { walletId: "wallet-1", address: account, ownerQuorumId: "owner-q", workerQuorumId: "worker-q", policyId: "policy-1" };
  function fake(walletOverrides: Record<string, unknown> = {}) {
    const wallet = { id: "wallet-1", address: copyKey.address, owner_id: "owner-q", chain_type: "ethereum", archived_at: null, policy_ids: [],
      additional_signers: [{ signer_id: "worker-q", override_policy_ids: ["policy-1"] }], ...walletOverrides };
    const signTypedData = vi.fn(async (_id: string, body: { params: { typed_data: { domain: never; types: Record<string, never>; primary_type: string; message: never } } }) => {
      const { domain, types, primary_type, message } = body.params.typed_data;
      const { EIP712Domain: _domain, ...rest } = types;
      return { encoding: "hex", signature: await copyKey.signTypedData({ domain, types: rest, primaryType: primary_type, message }) };
    });
    const client = { wallets: () => ({ get: vi.fn(async () => wallet), ethereum: () => ({ signTypedData }) }) };
    return { signer: new PrivyPolicyMasterSigner(cfg, client as never), signTypedData };
  }
  const send = (to: string) => usdSendTypedData(WALLET_NETWORKS.testnet, to, "12.5", 1_000) as never;
  const bound = { network: "testnet" as const, destination: ownerMain };

  it("signs the return to the owner's main wallet with the worker key, and the signature recovers to the account", async () => {
    const { signer, signTypedData } = fake();
    expect(signer.available).toBe(true);
    await expect(signer.sign(target, send(ownerMain), bound, Date.now() + 10_000)).resolves.toMatch(/^0x[0-9a-f]{130}$/);
    expect(signTypedData.mock.calls[0]![1]).toMatchObject({ authorization_context: { authorization_private_keys: ["wallet-auth:key"] } });
  });

  it.each([
    ["another destination", () => fake(), send(other), bound],
    ["a destination the caller did not bind", () => fake(), send(ownerMain), { network: "testnet" as const, destination: other }],
    ["a withdrawal (not an allowed type)", () => fake(), withdraw3TypedData(WALLET_NETWORKS.testnet, ownerMain, "1", 1) as never, bound],
    ["mainnet", () => fake(), usdSendTypedData(WALLET_NETWORKS.mainnet, ownerMain, "1", 1) as never, bound],
    ["a builder fee for another builder", () => fake(), approveBuilderFeeTypedData(WALLET_NETWORKS.testnet, other, 10, 1) as never, { network: "testnet" as const, builder: ownerMain }],
    ["a foreign additional signer", () => fake({ additional_signers: [{ signer_id: "worker-q", override_policy_ids: ["policy-1"] }, { signer_id: "x", override_policy_ids: [] }] }), send(ownerMain), bound],
    ["the worker without its policy", () => fake({ additional_signers: [{ signer_id: "worker-q", override_policy_ids: [] }] }), send(ownerMain), bound],
    ["a wallet-level policy", () => fake({ policy_ids: ["p"] }), send(ownerMain), bound],
    ["an owner that changed", () => fake({ owner_id: "someone" }), send(ownerMain), bound],
    ["an address that changed", () => fake({ address: other }), send(ownerMain), bound],
  ])("refuses %s before Privy signs", async (_name, make, data, b) => {
    const { signer, signTypedData } = make();
    await expect(signer.sign(target, data, b as never, Date.now() + 10_000)).rejects.toThrow("worker_master_signing_unavailable");
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("refuses another worker quorum than its own", async () => {
    const { signer, signTypedData } = fake();
    await expect(signer.sign({ ...target, workerQuorumId: "other-q" }, send(ownerMain), bound, Date.now() + 10_000)).rejects.toThrow("worker_master_signing_unavailable");
    expect(signTypedData).not.toHaveBeenCalled();
    expect(new PrivyPolicyMasterSigner({ appId: "a", appSecret: "s" }, {} as never).available).toBe(false);
  });
});
