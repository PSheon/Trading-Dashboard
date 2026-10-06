import { beforeEach, expect, it, vi } from "vitest";
import { createAgentJournal, prepareCopyAgent, runCopyAgentApproval } from "@/lib/copy-agents";
import { agentApprovalTypedData, agentOwnerConsentTypedData, type CopyAgentSetup, type CopyExecutionAccount } from "@trading-dashboard/shared/contracts";

const now = Date.parse("2026-10-03T00:00:00Z");
const account: CopyExecutionAccount = { id: "account", strategyId: 9, network: "testnet", state: "ready", address: `0x${"22".repeat(20)}`, issue: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
const op: CopyAgentSetup = { id: "agent", accountId: account.id, strategyId: 9, network: "testnet", state: "ready", accountAddress: account.address!, agentAddress: `0x${"33".repeat(20)}`, expiresAt: new Date(now + 7 * 86400000).toISOString(), issue: null, authorizationId: null, createdAt: account.createdAt, updatedAt: account.updatedAt };
const intent = { id: op.id, strategyId: 9, network: "testnet" as const, accountAddress: op.accountAddress, agentAddress: op.agentAddress!, policyId: "policy", workerQuorumId: "worker", nonce: now, expiresAt: Date.parse(op.expiresAt), consentExpiresAt: now + 300000 };
/** The server's prepared action: the copy account's exact ApproveAgent. */
const masterAction = { kind: "agent_approval" as const, account: op.accountAddress, typedData: agentApprovalTypedData(intent), digest: `0x${"ab".repeat(32)}`, expiresAt: now + 300000 };
const masterSignature = `0x${"bb".repeat(65)}`;
let owner = { status: "signedIn", mode: "privy", identity: "owner", session: "1", walletAddress: `0x${"11".repeat(20)}` };
let memory: Map<string, string>;
function storage() { return { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } }; }
function deps() { return { snapshot: () => ({ ...owner }), now: () => now, journal: createAgentJournal("owner-scope", storage()), sign: vi.fn().mockResolvedValue(`0x${"aa".repeat(65)}`), signAccount: vi.fn().mockResolvedValue(masterSignature), challenge: vi.fn().mockResolvedValue({ operation: op, intent, masterAction }), approve: vi.fn().mockResolvedValue({ ...op, state: "active", authorizationId: "grant" }), reconcile: vi.fn().mockResolvedValue({ ...op, state: "approval_unknown" }), create: vi.fn().mockResolvedValue(op), newKey: () => "stable-key" }; }
beforeEach(() => { memory = new Map(); owner = { status: "signedIn", mode: "privy", identity: "owner", session: "1", walletAddress: `0x${"11".repeat(20)}` }; });

it("prepares without signing or approving and persists before the request", async () => {
  const d = deps(); d.create.mockImplementation(async () => { expect([...memory.values()].join()).toContain("stable-key"); return op; });
  expect(await prepareCopyAgent(account, 7, d)).toEqual(op);
  expect(d.create).toHaveBeenCalledWith(account.id, { idempotencyKey: "stable-key", validForDays: 7 }, expect.any(Function)); expect(d.sign).not.toHaveBeenCalled(); expect(d.approve).not.toHaveBeenCalled();
});
it("reuses creation identity after response loss and a new journal instance", async () => {
  const d = deps(); d.create.mockRejectedValueOnce(new Error("lost")); await expect(prepareCopyAgent(account, 7, d)).rejects.toThrow("lost");
  const resumed = deps(); await prepareCopyAgent(account, 7, resumed); expect(resumed.create).toHaveBeenCalledWith(account.id, { idempotencyKey: "stable-key", validForDays: 7 }, expect.any(Function));
  expect(resumed.sign).not.toHaveBeenCalled();
});
it("rejects changed account or duration while an original creation is uncertain", async () => {
  const d = deps(); d.create.mockRejectedValue(new Error("lost")); await expect(prepareCopyAgent(account, 7, d)).rejects.toThrow();
  await expect(prepareCopyAgent(account, 8, d)).rejects.toThrow("agent_creation_changed");
  await expect(prepareCopyAgent({ ...account, address: `0x${"44".repeat(20)}` }, 7, d)).rejects.toThrow("agent_creation_changed"); expect(d.create).toHaveBeenCalledTimes(1);
});
it("signs exact owner consent using a main wallet distinct from the dedicated account", async () => {
  const d = deps(); expect(await runCopyAgentApproval(op, d)).toMatchObject({ state: "active" });
  expect(d.sign).toHaveBeenCalledExactlyOnceWith(agentOwnerConsentTypedData(intent)); expect(d.signAccount).toHaveBeenCalledExactlyOnceWith(op.accountAddress, masterAction.typedData); expect(d.approve).toHaveBeenCalledExactlyOnceWith(op.id, { consentSignature: `0x${"aa".repeat(65)}`, masterSignature }, expect.any(Function));
  expect([...memory.values()].join()).not.toContain("aa".repeat(65));
});
it.each(["policy_unknown", "wallet_unknown", "approval_signing", "approval_unknown", "active", "blocked", "revoked", "expired"] as const)("only reconciles %s without challenge, signature or approval", async (state) => {
  const d = deps(); await runCopyAgentApproval({ ...op, state }, d); expect(d.reconcile).toHaveBeenCalledExactlyOnceWith(op.id, expect.any(Function)); expect(d.challenge).not.toHaveBeenCalled(); expect(d.sign).not.toHaveBeenCalled(); expect(d.approve).not.toHaveBeenCalled();
});
it("recovers an uncertain approval across reloads without another challenge or signature", async () => {
  const d = deps(); d.approve.mockRejectedValue(new Error("lost approval")); await expect(runCopyAgentApproval(op, d)).rejects.toThrow("lost approval");
  const resumed = deps(); await runCopyAgentApproval(op, resumed); expect(resumed.reconcile).toHaveBeenCalledOnce(); expect(resumed.sign).not.toHaveBeenCalled(); expect(resumed.approve).not.toHaveBeenCalled();
});
it.each(["session", "identity", "walletAddress", "mode", "status"] as const)("rejects %s changes during signing before submission", async (field) => {
  const d = deps(); d.sign.mockImplementation(async () => { owner = { ...owner, [field]: "changed" }; return `0x${"aa".repeat(65)}`; });
  await expect(runCopyAgentApproval(op, d)).rejects.toThrow("agent_session_changed"); expect(d.approve).not.toHaveBeenCalled();
});
it("rejects a session change during challenge before signing", async () => {
  const d = deps(); d.challenge.mockImplementation(async () => { owner.session = "changed"; return { operation: op, intent, masterAction }; });
  await expect(runCopyAgentApproval(op, d)).rejects.toThrow("agent_session_changed"); expect(d.sign).not.toHaveBeenCalled();
});
it.each([{ intent: { ...intent, strategyId: 10 } }, { intent: { ...intent, id: "wrong" } }, { intent: { ...intent, accountAddress: owner.walletAddress } }, { intent: { ...intent, agentAddress: op.accountAddress } }, { intent: { ...intent, network: "mainnet" } }, { intent: { ...intent, expiresAt: intent.expiresAt + 1 } }, { intent: { ...intent, consentExpiresAt: now - 1 } }, { intent: { ...intent, policyId: "" } }, { operation: { ...op, accountId: "wrong" } }, { operation: { ...op, state: "approval_unknown" } }])("rejects substituted or expired challenges before signing: %j", async (changes) => {
  const d = deps(); d.challenge.mockResolvedValue({ operation: op, intent, masterAction, ...changes }); await expect(runCopyAgentApproval(op, d)).rejects.toThrow(); expect(d.sign).not.toHaveBeenCalled(); expect(d.approve).not.toHaveBeenCalled();
});
it("does not submit when consent expires inside the wallet prompt", async () => {
  const d = deps(); let clock = now; d.now = () => clock; d.sign.mockImplementation(async () => { clock += 300001; return `0x${"aa".repeat(65)}`; });
  await expect(runCopyAgentApproval(op, d)).rejects.toThrow("agent_consent_expired"); expect(d.approve).not.toHaveBeenCalled();
});
it("fails closed before mutations when recovery storage cannot persist", async () => {
  const d = deps(); d.journal = createAgentJournal("owner", { ...storage(), setItem() { throw new Error("disabled"); } });
  await expect(prepareCopyAgent(account, 7, d)).rejects.toThrow(); expect(d.create).not.toHaveBeenCalled();
  await expect(runCopyAgentApproval(op, d)).rejects.toThrow(); expect(d.approve).not.toHaveBeenCalled();
});
it.each([{ account: `0x${"44".repeat(20)}` }, { kind: "account_mode" }, { typedData: agentApprovalTypedData({ ...intent, agentAddress: `0x${"55".repeat(20)}` }) }, { expiresAt: now }])(
  "never signs with the copy account a prepared action other than this approval %j", async (change) => {
    const d = deps(); d.challenge.mockResolvedValue({ operation: op, intent, masterAction: { ...masterAction, ...change } });
    await expect(runCopyAgentApproval(op, d)).rejects.toThrow(); expect(d.signAccount).not.toHaveBeenCalled(); expect(d.approve).not.toHaveBeenCalled();
  });
