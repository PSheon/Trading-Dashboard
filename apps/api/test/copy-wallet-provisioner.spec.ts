import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyQuorum, Wallet } from "@privy-io/node/resources";
import type { AppConfig } from "../src/config/app-config.js";
import { PrivyUserWalletProvisioner, ProvisioningVerificationPending, ProvisioningWalletConflict } from "../src/copy/live/privy-wallet-provisioner.js";

const sdk = vi.hoisted(() => {
  const wallets = { create: vi.fn(), get: vi.fn(), list: vi.fn() };
  const quorums = { get: vi.fn() };
  const client = vi.fn(function () { return { wallets: () => wallets, keyQuorums: () => quorums }; });
  return { wallets, quorums, client };
});
vi.mock("@privy-io/node", () => ({ PrivyClient: sdk.client }));

const userId = "did:privy:execution-owner";
const externalId = `copy_${"a".repeat(32)}`;
const address = `0x${"aB".repeat(20)}`;
function config(appId: string | undefined = "test-app", appSecret: string | undefined = "test-secret"): AppConfig {
  return { value: { auth: { appId, appSecret } } } as AppConfig;
}
function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: "privy-execution-wallet", address, chain_type: "ethereum", external_id: externalId,
    owner_id: "user-owner-quorum", additional_signers: [], policy_ids: [],
    created_at: 1, exported_at: null, imported_at: null, archived_at: null,
    ...overrides,
  };
}
function responses(direct = wallet(), listed = wallet()) {
  sdk.wallets.get.mockResolvedValue(direct);
  sdk.wallets.list.mockResolvedValue({ data: [listed] });
}
function quorum(overrides: Partial<KeyQuorum> = {}): KeyQuorum {
  return { id: "user-owner-quorum", user_ids: [userId], authorization_keys: [], authorization_threshold: 1, display_name: null, ...overrides };
}
beforeEach(() => {
  vi.clearAllMocks();
  sdk.wallets.create.mockReset().mockResolvedValue(wallet());
  sdk.wallets.get.mockReset();
  sdk.wallets.list.mockReset();
  sdk.quorums.get.mockReset().mockResolvedValue(quorum());
  responses();
});

describe("Privy execution wallet provider", () => {
  it("bounds SDK requests to ten seconds and disables automatic retries", () => {
    expect(new PrivyUserWalletProvisioner(config()).available).toBe(true);
    expect(sdk.client).toHaveBeenCalledExactlyOnceWith({ appId: "test-app", appSecret: "test-secret", timeout: 10_000, maxRetries: 0, logLevel: "off" });
  });

  it.each([
    { appId: "", appSecret: "" },
    { appId: "test-app", appSecret: "" },
    { appId: "", appSecret: "test-secret" },
  ])("fails closed with missing credentials %j", async ({ appId, appSecret }) => {
    const provider = new PrivyUserWalletProvisioner(config(appId, appSecret));
    expect(provider.available).toBe(false);
    await expect(provider.create(userId, externalId)).rejects.toThrow("provider_unavailable");
    await expect(provider.findOwned(userId, externalId)).rejects.toThrow("provider_unavailable");
    expect(sdk.client).not.toHaveBeenCalled();
    expect(sdk.wallets.create).not.toHaveBeenCalled();
    expect(sdk.wallets.get).not.toHaveBeenCalled();
    expect(sdk.wallets.list).not.toHaveBeenCalled();
    expect(sdk.quorums.get).not.toHaveBeenCalled();
  });

  it("creates with the sole user owner and durable external/idempotency identity", async () => {
    const provider = new PrivyUserWalletProvisioner(config());
    await expect(provider.create(userId, externalId)).resolves.toBeUndefined();
    // Exact payload excludes server ownership, additional signers, policies,
    // authorization keys and delegation. No lookup or signing is needed to create.
    expect(sdk.wallets.create).toHaveBeenCalledExactlyOnceWith({
      chain_type: "ethereum", owner: { user_id: userId }, external_id: externalId,
      idempotency_key: externalId, display_name: "Copy execution account",
    });
    expect(sdk.wallets.get).not.toHaveBeenCalled();
    expect(sdk.wallets.list).not.toHaveBeenCalled();
    expect(sdk.quorums.get).not.toHaveBeenCalled();
  });

  it("preserves the idempotency identity when a caller repeats creation", async () => {
    const provider = new PrivyUserWalletProvisioner(config());
    await provider.create(userId, externalId);
    await provider.create(userId, externalId);
    expect(sdk.wallets.create).toHaveBeenCalledTimes(2);
    expect(sdk.wallets.create.mock.calls[0]).toEqual(sdk.wallets.create.mock.calls[1]);
  });

  it("propagates ambiguous create failures without retrying", async () => {
    const failure = new Error("remote timeout after submission");
    sdk.wallets.create.mockRejectedValue(failure);
    await expect(new PrivyUserWalletProvisioner(config()).create(userId, externalId)).rejects.toBe(failure);
    expect(sdk.wallets.create).toHaveBeenCalledTimes(1);
    expect(sdk.wallets.get).not.toHaveBeenCalled();
  });

  it("uses the immutable external ID and a matching user-filtered result as ownership proof", async () => {
    responses(wallet(), wallet({ address: address.toLowerCase() }));
    const provider = new PrivyUserWalletProvisioner(config());
    await expect(provider.findOwned(userId, externalId)).resolves.toEqual({
      id: "privy-execution-wallet", address: address.toLowerCase(), externalId, ownerQuorumId: "user-owner-quorum",
    });
    expect(sdk.wallets.get).toHaveBeenCalledExactlyOnceWith(`ext_wal_${externalId}`);
    expect(sdk.wallets.list).toHaveBeenCalledExactlyOnceWith({ user_id: userId, external_id: externalId, chain_type: "ethereum" });
    expect(sdk.quorums.get).toHaveBeenCalledExactlyOnceWith("user-owner-quorum");
    expect(sdk.wallets.create).not.toHaveBeenCalled();
  });

  it("accepts optional archive/automation fields absent on an active SDK wallet", async () => {
    responses(wallet({ archived_at: undefined, automations: undefined }), wallet({ archived_at: undefined, automations: [] }));
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).resolves.toMatchObject({ id: "privy-execution-wallet" });
  });

  it("does not treat owner_id as a user DID without provider ownership evidence", async () => {
    sdk.wallets.get.mockResolvedValue(wallet({ owner_id: userId }));
    sdk.wallets.list.mockResolvedValue({ data: [] });
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toBeInstanceOf(ProvisioningVerificationPending);
    expect(sdk.quorums.get).not.toHaveBeenCalled();
    expect(sdk.wallets.create).not.toHaveBeenCalled();
  });

  it("keeps ownership verification pending when listing has no matching provider wallet ID", async () => {
    responses(wallet(), wallet({ id: "foreign-wallet" }));
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toBeInstanceOf(ProvisioningVerificationPending);
    expect(sdk.quorums.get).not.toHaveBeenCalled();
  });

  it("recovers pending verification once user-filter indexing supplies corroboration", async () => {
    sdk.wallets.list.mockResolvedValueOnce({ data: [] });
    const provider = new PrivyUserWalletProvisioner(config());
    await expect(provider.findOwned(userId, externalId)).rejects.toBeInstanceOf(ProvisioningVerificationPending);
    await expect(provider.findOwned(userId, externalId)).resolves.toMatchObject({ id: "privy-execution-wallet" });
    expect(sdk.wallets.create).not.toHaveBeenCalled();
    expect(sdk.quorums.get).toHaveBeenCalledTimes(1);
  });

  const conflicts: { name: string; override: Partial<Wallet> }[] = [
    { name: "missing external ID", override: { external_id: undefined } },
    { name: "different external ID", override: { external_id: "foreign-external-id" } },
    { name: "ownerless wallet", override: { owner_id: null } },
    { name: "empty owner quorum", override: { owner_id: "" } },
    { name: "different owner quorum", override: { owner_id: "foreign-quorum" } },
    { name: "different address", override: { address: `0x${"12".repeat(20)}` } },
    { name: "different chain", override: { chain_type: "solana" } },
    { name: "archived wallet", override: { archived_at: 1 } },
    { name: "archive timestamp zero", override: { archived_at: 0 } },
    { name: "additional server signer", override: { additional_signers: [{ signer_id: "server-quorum" }] } },
    { name: "enabled automation", override: { automations: [{ id: "automation", enabled: true }] } },
    { name: "disabled automation", override: { automations: [{ id: "automation", enabled: false }] } },
  ];
  describe.each(["direct", "listed"] as const)("%s response ownership conflicts", (source) => {
    it.each(conflicts)("rejects $name", async ({ override }) => {
      responses(source === "direct" ? wallet(override) : wallet(), source === "listed" ? wallet(override) : wallet());
      await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toBeInstanceOf(ProvisioningWalletConflict);
      expect(sdk.wallets.create).not.toHaveBeenCalled();
      expect(sdk.quorums.get).not.toHaveBeenCalled();
    });
  });

  it.each(["", "0x1234", "0x" + "gg".repeat(20), "ab".repeat(20), "0x" + "ab".repeat(21)])("rejects a malformed address agreed by both endpoints: %s", async (invalid) => {
    responses(wallet({ address: invalid }), wallet({ address: invalid }));
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toThrow("wallet_conflict");
  });

  it("returns null only when the direct wallet lookup returns a numeric 404", async () => {
    sdk.wallets.get.mockRejectedValue({ status: 404 });
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).resolves.toBeNull();
    expect(sdk.wallets.list).not.toHaveBeenCalled();
    expect(sdk.quorums.get).not.toHaveBeenCalled();
  });

  it.each([401, 403, 409, 429, 500, "404"])("propagates direct lookup status %s", async (status) => {
    const failure = Object.assign(new Error("provider lookup failure"), { status });
    sdk.wallets.get.mockRejectedValue(failure);
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toBe(failure);
    expect(sdk.wallets.list).not.toHaveBeenCalled();
  });

  it("propagates transport lookup failures", async () => {
    const failure = new Error("network timeout");
    sdk.wallets.get.mockRejectedValue(failure);
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toBe(failure);
  });

  it.each([404, 429, 500])("does not turn ownership-list status %s into evidence of absence", async (status) => {
    const failure = Object.assign(new Error("ownership proof unavailable"), { status });
    sdk.wallets.list.mockRejectedValue(failure);
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toBe(failure);
    expect(sdk.wallets.create).not.toHaveBeenCalled();
    expect(sdk.quorums.get).not.toHaveBeenCalled();
  });

  const quorumConflicts: { name: string; override: Partial<KeyQuorum> }[] = [
    { name: "wrong quorum ID", override: { id: "foreign-quorum" } },
    { name: "missing users", override: { user_ids: null } },
    { name: "empty user list", override: { user_ids: [] } },
    { name: "foreign user", override: { user_ids: ["did:privy:foreign"] } },
    { name: "additional user", override: { user_ids: [userId, "did:privy:foreign"] } },
    { name: "duplicate user", override: { user_ids: [userId, userId] } },
    { name: "authorization key", override: { authorization_keys: [{ public_key: "server-authorization-key", display_name: null }] } },
    { name: "nested quorum", override: { key_quorum_ids: ["server-quorum"] } },
    { name: "unspecified threshold", override: { authorization_threshold: null } },
    { name: "zero threshold", override: { authorization_threshold: 0 } },
    { name: "multiple-signature threshold", override: { authorization_threshold: 2 } },
  ];
  it.each(quorumConflicts)("rejects owner quorum with $name", async ({ override }) => {
    sdk.quorums.get.mockResolvedValue(quorum(override));
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toBeInstanceOf(ProvisioningWalletConflict);
    expect(sdk.wallets.create).not.toHaveBeenCalled();
  });

  it("accepts an explicitly empty nested-quorum list", async () => {
    sdk.quorums.get.mockResolvedValue(quorum({ key_quorum_ids: [] }));
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).resolves.toMatchObject({ ownerQuorumId: "user-owner-quorum" });
  });

  it.each([404, 403, 429, 500])("propagates unavailable owner-quorum status %s", async (status) => {
    const failure = Object.assign(new Error("owner proof unavailable"), { status });
    sdk.quorums.get.mockRejectedValue(failure);
    await expect(new PrivyUserWalletProvisioner(config()).findOwned(userId, externalId)).rejects.toBe(failure);
    expect(sdk.wallets.create).not.toHaveBeenCalled();
  });
});
