"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { accountModeOwnerConsentTypedData, approveCopyAccountModeSchema, copyAccountModeChallengeSchema, copyAccountModeOperationSchema, copyAccountModeOverviewSchema, prepareCopyAccountModeSchema, type CopyAccountModeOperation, type CopyExecutionAccount } from "@trading-dashboard/shared/contracts";
import { api, sessionKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { queryKeys } from "@/lib/query-keys";
import type { Eip712TypedData } from "@/lib/wallet-signer";

const ROOT = "/me/copy/account-modes";
const creationSchema = z.object({ accountId: z.string(), strategyId: z.number().int().positive(), network: z.literal("testnet"), address: z.string().regex(/^0x[0-9a-f]{40}$/), key: prepareCopyAccountModeSchema.shape.idempotencyKey, operationId: z.string().nullable() }).strict();
const recoverySchema = z.object({ creations: z.array(creationSchema), approvals: z.array(z.string()) }).strict();
type Creation = z.infer<typeof creationSchema>;
type Recovery = z.infer<typeof recoverySchema>;
/** Nonsecret recovery identities only; an uncertain action never becomes a new request. */
export function createAccountModeJournal(scope: string, storage: Pick<Storage, "getItem" | "setItem">) {
  const key = `copy-account-mode:v1:${encodeURIComponent(scope)}`;
  const read = (): Recovery => { const value = storage.getItem(key); return value ? recoverySchema.parse(JSON.parse(value)) : { creations: [], approvals: [] }; };
  const write = (value: Recovery) => { const encoded = JSON.stringify(recoverySchema.parse(value)); storage.setItem(key, encoded); if (storage.getItem(key) !== encoded) throw new Error("mode_recovery_unavailable"); };
  return { read, creation: (id: string) => read().creations.find(item => item.accountId === id), saveCreation: (item: Creation) => { const value = read(); value.creations = [...value.creations.filter(entry => entry.accountId !== item.accountId), creationSchema.parse(item)]; write(value); }, uncertain: (id: string) => read().approvals.includes(id), markApproval: (id: string) => { const value = read(); if (!value.approvals.includes(id)) value.approvals.push(id); write(value); } };
}
export interface AccountModeOwnerSnapshot { status: string; mode: string; identity: string | null; session: string; walletAddress: string | null }
interface BaseDependencies { snapshot(): AccountModeOwnerSnapshot; journal: ReturnType<typeof createAccountModeJournal> }
interface CreationDependencies extends BaseDependencies { newKey(): string; assertAccount?(account: CopyExecutionAccount): void; create(id: string, body: { idempotencyKey: string }, beforeSend: () => void): Promise<unknown> }
interface ConsentDependencies extends BaseDependencies {
  now(): number; assertCurrent?(operation: CopyAccountModeOperation, signing: boolean): void;
  adoptChallenge?(original: CopyAccountModeOperation, operation: CopyAccountModeOperation, expiresAt: number): void;
  sign(data: Eip712TypedData): Promise<string>;
  challenge(id: string, beforeSend: () => void): Promise<unknown>;
  approve(id: string, body: { consentSignature: string }, beforeSend: () => void): Promise<unknown>;
  reconcile(id: string, beforeSend: () => void): Promise<unknown>;
}
function ownerGuard(deps: Pick<BaseDependencies, "snapshot">, requireWallet = true) {
  const initial = deps.snapshot();
  if (initial.status !== "signedIn" || initial.mode !== "privy" || !initial.identity || (requireWallet && !/^0x[0-9a-fA-F]{40}$/.test(initial.walletAddress ?? ""))) throw new Error("mode_owner_unavailable");
  return () => { const value = deps.snapshot(); if (Object.keys(initial).some(k => value[k as keyof AccountModeOwnerSnapshot] !== initial[k as keyof AccountModeOwnerSnapshot])) throw new Error("mode_session_changed"); };
}
function sameIdentity(original: CopyAccountModeOperation, raw: unknown) {
  const value = copyAccountModeOperationSchema.parse(raw);
  for (const k of ["id", "accountId", "strategyId", "network", "accountAddress", "target", "createdAt"] as const) if (value[k] !== original[k]) throw new Error("mode_operation_changed");
  if (value.revision < original.revision) throw new Error("mode_operation_changed");
  return value;
}
export function canSignAccountMode(op: CopyAccountModeOperation) { return op.submissionState === "prepared" && ["unknown", "unproven"].includes(op.targetState); }
export async function prepareCopyAccountMode(input: CopyExecutionAccount, deps: CreationDependencies): Promise<CopyAccountModeOperation> {
  const account = structuredClone(input), owner = ownerGuard(deps);
  const guard = () => { owner(); deps.assertAccount?.(account); }; guard();
  if (account.state !== "ready" || account.network !== "testnet" || !/^0x[0-9a-f]{40}$/.test(account.address ?? "") || account.address === `0x${"00".repeat(20)}`) throw new Error("mode_account_unavailable");
  if (deps.journal.creation(account.id)) throw new Error("mode_original_unresolved");
  const body = prepareCopyAccountModeSchema.parse({ idempotencyKey: deps.newKey() });
  const saved: Creation = { accountId: account.id, strategyId: account.strategyId, network: "testnet", address: account.address!, key: body.idempotencyKey, operationId: null };
  deps.journal.saveCreation(saved); guard(); const raw = await deps.create(account.id, body, guard); guard();
  const op = copyAccountModeOperationSchema.parse(raw);
  if (op.accountId !== saved.accountId || op.strategyId !== saved.strategyId || op.network !== saved.network || op.accountAddress !== saved.address) throw new Error("mode_operation_changed");
  deps.journal.saveCreation({ ...saved, operationId: op.id }); return op;
}
export async function runCopyAccountModeConsent(input: CopyAccountModeOperation, deps: ConsentDependencies, reconcileOnly = false): Promise<CopyAccountModeOperation> {
  let op = copyAccountModeOperationSchema.parse(input);
  const signing = !reconcileOnly && canSignAccountMode(op) && !deps.journal.uncertain(op.id), owner = ownerGuard(deps, signing);
  const guard = (ready = signing) => { owner(); deps.assertCurrent?.(op, ready); }; guard();
  if (!signing) { const raw = await deps.reconcile(op.id, () => guard(false)); guard(false); return sameIdentity(op, raw); }
  const raw = await deps.challenge(op.id, () => guard()); guard();
  const challenge = copyAccountModeChallengeSchema.parse(raw), returned = sameIdentity(op, challenge.operation), intent = challenge.intent;
  if (!canSignAccountMode(returned) || intent.operationId !== op.id || intent.accountId !== op.accountId || intent.strategyId !== op.strategyId || intent.network !== op.network || intent.accountAddress !== op.accountAddress) throw new Error("mode_challenge_changed");
  // The backend reserves the immutable challenge at a new revision. Adopt only after the old revision guard.
  deps.adoptChallenge?.(op, returned, intent.consentExpiresAt); op = returned;
  const expiry = () => { const now = deps.now(); if (!Number.isSafeInteger(now) || intent.consentExpiresAt <= now || intent.nonce > now + 30000) throw new Error("mode_consent_expired"); };
  const finalGuard = () => { guard(); expiry(); }; finalGuard();
  const signature = await deps.sign(accountModeOwnerConsentTypedData(intent)); finalGuard();
  const body = approveCopyAccountModeSchema.parse({ consentSignature: signature });
  deps.journal.markApproval(op.id); finalGuard(); const result = await deps.approve(op.id, body, finalGuard); guard(false); return sameIdentity(op, result);
}

function useModeKey() { const auth = useAuth(); return [...queryKeys.copy.all, "account-modes", auth.status, auth.mode, auth.identity, sessionKey(), auth.wallet?.address?.toLowerCase()] as const; }
export function useCopyAccountModes() {
  const auth = useAuth(); return useQuery({ queryKey: useModeKey(), queryFn: async ({ signal }) => copyAccountModeOverviewSchema.parse(await api.get(ROOT, signal)), enabled: auth.status === "signedIn" && auth.mode === "privy", staleTime: 0, gcTime: 0, retry: false, refetchInterval: 15000 });
}
export function useCopyAccountModeActions(accounts: readonly CopyExecutionAccount[], operations: readonly CopyAccountModeOperation[], available: boolean, selectedAccountId: string) {
  const [deadlines, setDeadlines] = useState<Record<string, number>>({});
  const auth = useAuth(), latest = useRef(auth), current = useRef({ accounts, operations, available, selectedAccountId }), mounted = useRef(true), busy = useRef(false), client = useQueryClient(), key = useModeKey();
  useLayoutEffect(() => { latest.current = auth; current.current = { accounts, operations, available, selectedAccountId }; }, [auth, accounts, operations, available, selectedAccountId]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = (): AccountModeOwnerSnapshot => { const a = latest.current; return { status: mounted.current ? a.status : "disposed", mode: a.mode, identity: a.identity, session: sessionKey(), walletAddress: a.wallet?.address?.toLowerCase() ?? null }; };
  const journal = () => { const a = snapshot(); return createAccountModeJournal(`${a.mode}:${a.identity}`, window.sessionStorage); };
  const recoveryKey = [...key, "recovery"];
  const ownerReady = auth.status === "signedIn" && auth.mode === "privy" && Boolean(auth.identity && auth.wallet?.address);
  const recovery = useQuery({ queryKey: recoveryKey, queryFn: async () => journal().read(), enabled: auth.status === "signedIn" && auth.mode === "privy", retry: false, gcTime: 0 });
  const assertAccount = (original: CopyExecutionAccount) => { const found = current.current.accounts.find(a => a.id === original.id); if (current.current.selectedAccountId !== original.id || !current.current.available || !found || found.state !== "ready" || ["strategyId", "address", "network", "updatedAt"].some(k => found[k as keyof CopyExecutionAccount] !== original[k as keyof CopyExecutionAccount])) throw new Error("mode_account_changed"); };
  const assertCurrent = (op: CopyAccountModeOperation, signing: boolean) => { const state = current.current, found = state.operations.find(item => item.id === op.id), account = state.accounts.find(a => a.id === op.accountId); if (state.selectedAccountId !== op.accountId || !found || !account || account.strategyId !== op.strategyId || account.network !== op.network || account.address !== op.accountAddress) throw new Error("mode_operation_changed"); sameIdentity(op, found); if (signing && (!state.available || account.state !== "ready" || found.revision !== op.revision || !canSignAccountMode(found))) throw new Error("mode_operation_changed"); };
  const exclusive = async <T,>(fn: () => Promise<T>) => { if (busy.current) throw new Error("mode_action_in_progress"); busy.current = true; try { return await fn(); } finally { busy.current = false; } };
  const settled = async () => { await Promise.all([client.invalidateQueries({ queryKey: key, exact: true }), client.invalidateQueries({ queryKey: recoveryKey, exact: true })]); };
  const prepare = useMutation({ retry: false, mutationFn: (account: CopyExecutionAccount) => exclusive(() => prepareCopyAccountMode(account, { snapshot, journal: journal(), assertAccount, newKey: () => crypto.randomUUID(), create: (id, body, beforeSend) => api.post(`/me/copy/execution-wallets/${encodeURIComponent(id)}/mode`, body, { beforeSend }) })), onSettled: settled });
  const consent = useMutation({ retry: false, mutationFn: ({ operation, reconcileOnly = false }: { operation: CopyAccountModeOperation; reconcileOnly?: boolean }) => exclusive(() => { const account = current.current.accounts.find(a => a.id === operation.accountId); if (!account) throw new Error("mode_account_changed"); const capturedAccount = structuredClone(account); return runCopyAccountModeConsent(operation, { snapshot, journal: journal(), now: () => Date.now(), assertCurrent: (op, signing) => { assertCurrent(op, signing); if (signing) assertAccount(capturedAccount); }, adoptChallenge: (original, next, deadline) => { assertCurrent(original, true); setDeadlines(value => ({ ...value, [next.id]: deadline })); current.current = { ...current.current, operations: current.current.operations.map(op => op.id === original.id ? next : op) }; client.setQueryData(key, (previous: z.infer<typeof copyAccountModeOverviewSchema> | undefined) => previous ? { ...previous, operations: previous.operations.map(op => op.id === original.id ? next : op) } : previous); }, sign: typed => { const wallet = latest.current.wallet; if (!wallet) throw new Error("mode_owner_unavailable"); return wallet.signTypedData(typed); }, challenge: (id, beforeSend) => api.post(`${ROOT}/${encodeURIComponent(id)}/challenge`, {}, { beforeSend }), approve: (id, body, beforeSend) => api.post(`${ROOT}/${encodeURIComponent(id)}/approve`, body, { beforeSend }), reconcile: (id, beforeSend) => api.post(`${ROOT}/${encodeURIComponent(id)}/reconcile`, {}, { beforeSend }) }, reconcileOnly); }), onSettled: settled });
  const recover = useMutation({ retry: false, mutationFn: (creation: Creation) => exclusive(async () => { const guard = ownerGuard({ snapshot }, false); guard(); const raw = await api.get(`${ROOT}/by-key/${encodeURIComponent(creation.key)}`); guard(); const op = copyAccountModeOperationSchema.parse(raw); if (op.accountId !== creation.accountId || op.strategyId !== creation.strategyId || op.network !== creation.network || op.accountAddress !== creation.address || (creation.operationId && creation.operationId !== op.id)) throw new Error("mode_operation_changed"); journal().saveCreation({ ...creation, operationId: op.id }); return op; }), onSettled: settled });
  return { prepare, consent, recover, recovery, ownerReady, deadlines };
}
