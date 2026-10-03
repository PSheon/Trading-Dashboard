"use client";

import { useLayoutEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { agentOwnerConsentTypedData, copyAgentApproveSchema, copyAgentChallengeSchema, copyAgentOverviewSchema, copyAgentSetupSchema, prepareCopyAgentSchema, type CopyAgentSetup, type CopyExecutionAccount } from "@trading-dashboard/shared/contracts";
import { api, sessionKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { queryKeys } from "@/lib/query-keys";
import { defaultRetry } from "@/lib/query-policy";
import type { Eip712TypedData } from "@/lib/wallet-signer";

const ROOT = "/me/copy/agents";
const creationSchema = z.object({ accountId: z.string(), strategyId: z.number().int().positive(), network: z.literal("testnet"), address: z.string(), validForDays: z.number().int().min(1).max(30), key: z.string().min(1).max(128), operationId: z.string().nullable() }).strict();
const journalSchema = z.object({ creations: z.array(creationSchema), approvals: z.array(z.string()) }).strict();
type Creation = z.infer<typeof creationSchema>;
type Recovery = z.infer<typeof journalSchema>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Only recovery identities are persisted. JWTs, keys and consent signatures never enter storage. */
export function createAgentJournal(scope: string, storage: Storage) {
  const key = `copy-agent-recovery:v1:${encodeURIComponent(scope)}`;
  const read = (): Recovery => { const value = storage.getItem(key); return value ? journalSchema.parse(JSON.parse(value)) : { creations: [], approvals: [] }; };
  const write = (value: Recovery) => { const encoded = JSON.stringify(journalSchema.parse(value)); storage.setItem(key, encoded); if (storage.getItem(key) !== encoded) throw new Error("agent_recovery_storage_unavailable"); };
  return {
    read,
    creation: (accountId: string) => read().creations.find((item) => item.accountId === accountId),
    saveCreation: (item: Creation) => { const value = read(); value.creations = [...value.creations.filter((entry) => entry.accountId !== item.accountId), creationSchema.parse(item)]; write(value); },
    forgetCreation: (accountId: string) => { const value = read(); value.creations = value.creations.filter((entry) => entry.accountId !== accountId); write(value); },
    uncertain: (id: string) => read().approvals.includes(id),
    markApproval: (id: string) => { const value = read(); if (!value.approvals.includes(id)) value.approvals.push(id); write(value); },
    resolveApproval: (id: string) => { const value = read(); value.approvals = value.approvals.filter((entry) => entry !== id); write(value); },
  };
}
export interface AgentOwnerSnapshot { status: string; mode: string; identity: string | null; session: string; walletAddress: string | null }
interface OwnerDependencies { snapshot(): AgentOwnerSnapshot }
interface AgentDependencies extends OwnerDependencies {
  journal: ReturnType<typeof createAgentJournal>; now(): number;
  assertCurrent?(operation: CopyAgentSetup, approving: boolean): void;
  sign(data: Eip712TypedData): Promise<string>;
  challenge(id: string, beforeSend: () => void): Promise<unknown>;
  approve(id: string, body: { consentSignature: string }, beforeSend: () => void): Promise<unknown>;
  reconcile(id: string, beforeSend: () => void): Promise<unknown>;
}
interface CreationDependencies extends OwnerDependencies {
  journal: ReturnType<typeof createAgentJournal>; newKey(): string;
  assertAccount?(account: CopyExecutionAccount): void;
  create(id: string, body: { idempotencyKey: string; validForDays: number }, beforeSend: () => void): Promise<unknown>;
}
function ownerGuard(deps: OwnerDependencies, requireWallet = true) {
  const initial = deps.snapshot();
  if (initial.status !== "signedIn" || initial.mode !== "privy" || !initial.identity || (requireWallet && !/^0x[0-9a-fA-F]{40}$/.test(initial.walletAddress ?? ""))) throw new Error("agent_owner_unavailable");
  return () => { const current = deps.snapshot(); if (Object.keys(initial).some((field) => current[field as keyof AgentOwnerSnapshot] !== initial[field as keyof AgentOwnerSnapshot])) throw new Error("agent_session_changed"); };
}
function sameOperation(original: CopyAgentSetup, value: unknown) {
  const result = copyAgentSetupSchema.parse(value);
  for (const key of ["id", "accountId", "strategyId", "network", "accountAddress", "expiresAt"] as const) if (result[key] !== original[key]) throw new Error("agent_operation_changed");
  if (original.agentAddress && result.agentAddress !== original.agentAddress) throw new Error("agent_operation_changed");
  return result;
}
export async function prepareCopyAgent(inputAccount: CopyExecutionAccount, validForDays: number, deps: CreationDependencies): Promise<CopyAgentSetup> {
  const account = structuredClone(inputAccount), owner = ownerGuard(deps);
  const guard = () => { owner(); deps.assertAccount?.(account); }; guard();
  if (account.state !== "ready" || account.network !== "testnet" || !/^0x[0-9a-fA-F]{40}$/.test(account.address ?? "")) throw new Error("agent_account_unavailable");
  const saved = deps.journal.creation(account.id);
  if (saved && (saved.strategyId !== account.strategyId || saved.address !== account.address || saved.network !== account.network || saved.validForDays !== validForDays)) throw new Error("agent_creation_changed");
  const input = prepareCopyAgentSchema.parse({ idempotencyKey: saved?.key ?? deps.newKey(), validForDays });
  const attempt: Creation = saved ?? { accountId: account.id, strategyId: account.strategyId, network: "testnet", address: account.address!, validForDays, key: input.idempotencyKey, operationId: null };
  deps.journal.saveCreation(attempt); guard();
  const raw = await deps.create(account.id, input, guard); guard(); const result = copyAgentSetupSchema.parse(raw);
  if (result.accountId !== account.id || result.strategyId !== account.strategyId || result.network !== account.network || result.accountAddress !== account.address || (attempt.operationId && result.id !== attempt.operationId)) throw new Error("agent_operation_changed");
  deps.journal.saveCreation({ ...attempt, operationId: result.id }); return result;
}

/** Each user action either signs one verified challenge or checks the original operation. */
export async function runCopyAgentApproval(original: CopyAgentSetup, deps: AgentDependencies): Promise<CopyAgentSetup> {
  const owner = ownerGuard(deps); owner(); const op = copyAgentSetupSchema.parse(original);
  const approving = op.state === "ready" && !deps.journal.uncertain(op.id);
  const guard = (requireReady = approving) => { owner(); deps.assertCurrent?.(op, requireReady); }; guard();
  if (!approving) {
    const raw = await deps.reconcile(op.id, () => guard()); guard(); const result = sameOperation(op, raw);
    if (["ready", "active", "blocked", "revoked", "expired"].includes(result.state)) deps.journal.resolveApproval(op.id);
    return result;
  }
  if (op.network !== "testnet" || Date.parse(op.expiresAt) <= deps.now()) throw new Error("agent_consent_expired");
  const raw = await deps.challenge(op.id, () => guard()); guard();
  const { operation, intent } = copyAgentChallengeSchema.parse(raw); sameOperation(op, operation);
  if (operation.state !== "ready" || intent.id !== op.id || intent.strategyId !== op.strategyId || intent.network !== op.network || intent.accountAddress !== op.accountAddress || intent.agentAddress !== op.agentAddress || intent.expiresAt !== Date.parse(op.expiresAt)) throw new Error("agent_challenge_changed");
  const typedData = agentOwnerConsentTypedData(intent);
  const assertExpiry = () => { if (intent.consentExpiresAt <= deps.now() || intent.expiresAt <= deps.now() || intent.nonce > deps.now() + 30_000) throw new Error("agent_consent_expired"); };
  guard(); assertExpiry();
  const signature = await deps.sign(typedData); guard(); assertExpiry();
  const body = copyAgentApproveSchema.parse({ consentSignature: signature });
  // Durable barrier precedes submission, including when the response is lost or the tab closes.
  deps.journal.markApproval(op.id); guard(); assertExpiry();
  // After submission, a concurrent observer may legitimately advance the state.
  const approved = await deps.approve(op.id, body, () => { guard(); assertExpiry(); }); guard(false); const result = sameOperation(op, approved);
  if (["active", "blocked", "revoked", "expired"].includes(result.state)) deps.journal.resolveApproval(op.id);
  return result;
}

function useAgentKey() {
  const { status, identity, mode, wallet } = useAuth();
  return [...queryKeys.copy.all, "agents", status, mode, identity, sessionKey(), wallet?.address?.toLowerCase()] as const;
}
export function useCopyAgents() {
  const { status, mode } = useAuth();
  return useQuery({ queryKey: useAgentKey(), queryFn: async ({ signal }) => copyAgentOverviewSchema.parse(await api.get(ROOT, signal)), enabled: status === "signedIn" && mode === "privy", staleTime: 5_000, refetchInterval: 15_000, ...defaultRetry });
}
export function useCopyAgentActions(accounts: CopyExecutionAccount[], setups: CopyAgentSetup[]) {
  const auth = useAuth(), latest = useRef(auth), current = useRef({ accounts, setups }), mounted = useRef(true), client = useQueryClient(), key = useAgentKey();
  useLayoutEffect(() => { latest.current = auth; }, [auth]);
  useLayoutEffect(() => { current.current = { accounts, setups }; }, [accounts, setups]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = (): AgentOwnerSnapshot => { const value = latest.current; return { status: mounted.current ? value.status : "disposed", mode: value.mode, identity: value.identity, session: sessionKey(), walletAddress: value.wallet?.address?.toLowerCase() ?? null }; };
  const journal = () => { const value = snapshot(); if (typeof window === "undefined") throw new Error("agent_recovery_storage_unavailable"); return createAgentJournal(`${value.mode}:${value.identity}:${value.walletAddress}`, window.sessionStorage); };
  const recoveryKey = [...key, "recovery"];
  const ownerReady = auth.status === "signedIn" && auth.mode === "privy" && Boolean(auth.wallet?.address);
  const recovery = useQuery({ queryKey: recoveryKey, queryFn: async () => journal().read(), enabled: ownerReady, retry: false });
  const settled = async () => { await Promise.all([client.invalidateQueries({ queryKey: key, exact: true }), client.invalidateQueries({ queryKey: recoveryKey, exact: true }), client.invalidateQueries({ queryKey: [...queryKeys.copy.all, "execution-wallets"] })]); };
  const prepare = useMutation({ retry: false, mutationFn: async ({ account, validForDays, replacement }: { account: CopyExecutionAccount; validForDays: number; replacement?: CopyAgentSetup }) => {
    ownerGuard({ snapshot })();
    const saved = journal();
    if (replacement) { if (!["blocked", "revoked", "expired"].includes(replacement.state) || replacement.accountId !== account.id || replacement.strategyId !== account.strategyId || replacement.accountAddress !== account.address || replacement.network !== account.network) throw new Error("agent_operation_changed"); const previous = saved.creation(account.id); if (previous?.operationId === replacement.id) saved.forgetCreation(account.id); }
    return prepareCopyAgent(account, validForDays, { snapshot, journal: saved, newKey: () => crypto.randomUUID(), assertAccount: original => { const value = current.current.accounts.find(a => a.id === original.id); if (!value || value.state !== "ready" || ["strategyId", "network", "address", "updatedAt"].some(k => value[k as keyof CopyExecutionAccount] !== original[k as keyof CopyExecutionAccount])) throw new Error("agent_account_changed"); }, create: (id, input, beforeSend) => api.post(`/me/copy/execution-wallets/${encodeURIComponent(id)}/agent`, input, { beforeSend }) });
  }, onSettled: settled });
  const approve = useMutation({ retry: false, mutationFn: (op: CopyAgentSetup) => { const capturedAccount = structuredClone(current.current.accounts.find(item => item.id === op.accountId)); return runCopyAgentApproval(op, { snapshot, journal: journal(), now: () => Date.now(), assertCurrent: (original, approving) => {
    const value = current.current, operation = value.setups.find((item) => item.id === original.id);
    const account = value.accounts.find((item) => item.id === original.accountId && item.strategyId === original.strategyId && item.network === original.network && item.address === original.accountAddress && item.state === "ready");
    if (!operation || !account) throw new Error("agent_operation_changed"); sameOperation(original, operation);
    if (approving && (!capturedAccount || account.updatedAt !== capturedAccount.updatedAt || operation.state !== "ready" || Date.parse(operation.expiresAt) <= Date.now())) throw new Error("agent_operation_changed");
  }, sign: (typed) => { const wallet = latest.current.wallet; if (!wallet) throw new Error("agent_owner_unavailable"); return wallet.signTypedData(typed); }, challenge: (id, beforeSend) => api.post(`${ROOT}/${encodeURIComponent(id)}/challenge`, {}, { beforeSend }), approve: (id, body, beforeSend) => api.post(`${ROOT}/${encodeURIComponent(id)}/approve`, body, { beforeSend }), reconcile: (id, beforeSend) => api.post(`${ROOT}/${encodeURIComponent(id)}/reconcile`, {}, { beforeSend }) }); }, onSettled: settled });
  const reconcile = useMutation({ retry: false, mutationFn: async (op: CopyAgentSetup) => {
    const guard = ownerGuard({ snapshot }, false); guard(); const raw = await api.post(`${ROOT}/${encodeURIComponent(op.id)}/reconcile`, {}, { beforeSend: guard }); guard();
    // Policy/wallet provisioning can discover its separate agent address during reconciliation.
    const result = copyAgentSetupSchema.parse(raw);
    for (const field of ["id", "accountId", "strategyId", "network", "accountAddress", "expiresAt"] as const) if (result[field] !== op[field]) throw new Error("agent_operation_changed");
    if (op.agentAddress && result.agentAddress !== op.agentAddress) throw new Error("agent_operation_changed");
    if (ownerReady && ["ready", "active", "blocked", "revoked", "expired"].includes(result.state)) journal().resolveApproval(op.id);
    return result;
  }, onSettled: settled });
  return { prepare, approve, reconcile, recovery, ownerReady };
}
