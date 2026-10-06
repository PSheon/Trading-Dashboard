import { afterEach, expect, it, vi } from "vitest";
import { agentApprovalTypedData, type CopyAgentSetup } from "@trading-dashboard/shared/contracts";
import { api, setAccessTokenGetter } from "@/lib/api";
import { createAgentJournal, prepareCopyAgent, runCopyAgentApproval } from "@/lib/copy-agents";
afterEach(() => { vi.unstubAllGlobals(); setAccessTokenGetter(null); });
it.each(["account", "operation", "expiry"] as const)("blocks the actual approval POST after %s changes during token acquisition", async change => {
  const start = Date.now(); let clock = start, altered = false, finish!: (token: string) => void, waiting!: () => void;
  const tokenWait = new Promise<void>(resolve => { waiting = resolve; });
  setAccessTokenGetter(() => { waiting(); return new Promise(resolve => { finish = resolve; }); }, "owner");
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetcher);
  const op: CopyAgentSetup = { id: "original", accountId: "account", strategyId: 9, network: "testnet", state: "ready", accountAddress: `0x${"22".repeat(20)}`, agentAddress: `0x${"33".repeat(20)}`, expiresAt: new Date(start + 86400000).toISOString(), issue: null, authorizationId: null, createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString() };
  const intent = { id: op.id, strategyId: op.strategyId, network: "testnet" as const, accountAddress: op.accountAddress, agentAddress: op.agentAddress!, expiresAt: Date.parse(op.expiresAt), policyId: "policy", workerQuorumId: "worker", nonce: start, consentExpiresAt: start + 300000 };
  const memory = new Map<string, string>(), journal = createAgentJournal("owner", { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } });
  const pending = runCopyAgentApproval(op, { snapshot: () => ({ status: "signedIn", mode: "privy", identity: "owner", session: "1", walletAddress: `0x${"11".repeat(20)}` }), journal, now: () => clock, assertCurrent: (_original, approving) => { if (approving && altered) throw new Error("agent_operation_changed"); }, sign: async () => `0x${"aa".repeat(65)}`, challenge: async () => ({ operation: op, intent, masterAction: { kind: "agent_approval", account: op.accountAddress, typedData: agentApprovalTypedData(intent), digest: `0x${"ab".repeat(32)}`, expiresAt: start + 300000 } }), signAccount: async () => `0x${"bb".repeat(65)}`, approve: (id: string, body: { consentSignature: string }, beforeSend?: () => void) => api.post(`/me/copy/agents/${id}/approve`, body, { beforeSend }), reconcile: async () => op });
  await tokenWait; if (change === "expiry") clock = start + 300000; else altered = true;
  const rejected = expect(pending).rejects.toThrow(change === "expiry" ? "agent_consent_expired" : "agent_operation_changed"); finish("owner-token"); await rejected; expect(fetcher).not.toHaveBeenCalled(); expect(journal.uncertain(op.id)).toBe(true);
});
it("guards a captured ready account at the actual preparation POST after token delay", async () => {
  let changed = false, finish!: (token: string) => void, waiting!: () => void;
  const tokenWait = new Promise<void>(resolve => { waiting = resolve; }); setAccessTokenGetter(() => { waiting(); return new Promise(resolve => { finish = resolve; }); }, 'owner');
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetcher);
  const memory = new Map<string, string>();
  const account = { id: 'account', strategyId: 9, network: 'testnet' as const, state: 'ready' as const, address: `0x${'22'.repeat(20)}`, issue: null, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' };
  const dependencies = { snapshot: () => ({ status: 'signedIn', mode: 'privy', identity: 'owner', session: '1', walletAddress: `0x${'11'.repeat(20)}` }), journal: createAgentJournal('owner', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); } }), newKey: () => 'original-preparation-key', assertAccount: () => { if (changed) throw new Error('agent_account_changed'); }, create: (id: string, body: { idempotencyKey: string; validForDays: number }, beforeSend?: () => void) => api.post(`/me/copy/execution-wallets/${id}/agent`, body, { beforeSend }) };
  const pending = prepareCopyAgent(account, 7, dependencies); await tokenWait; changed = true; const rejected = expect(pending).rejects.toThrow('agent_account_changed'); finish('owner-token'); await rejected; expect(fetcher).not.toHaveBeenCalled();
});
