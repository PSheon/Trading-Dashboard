'use client';
import { useLayoutEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { createLiveCopyStrategySchema, copyExecutionWalletsSchema, copyExecutionAccountSchema, copyAgentSetupSchema, copyWalletGrantSchema, liveCopyMandateRenewalSchema, copyStrategySettingsSchema, liveCopyOverviewSchema, liveCopyStrategySchema, liveCopyMandateChallengeSchema, liveCopyMandateSchema, liveCopyMandateOwnerTypedData, approveLiveCopyMandateSchema, type CreateLiveCopyStrategy, type LiveCopyStrategy, type LiveCopyMandate, type CopyExecutionAccount, type CopyAgentSetup, type CopyWalletGrant } from '@trading-dashboard/shared/contracts';
import { api, sessionKey } from './api';
import { useAuth } from './auth';
import { liveCopyEnabled } from './copy-live-setup';
import { queryKeys } from './query-keys';
import type { Eip712TypedData } from './wallet-signer';
import type { AgentOwnerSnapshot } from './copy-agents';

const ROOT = '/me/copy/live';
const preparationSchema = z.object({ accountId: z.string(), strategyId: z.number().int().positive(), accountAddress: z.string(), strategyVersion: z.number().int().positive(), key: z.string().min(16).max(128), mandateId: z.string().nullable() }).strict();
const draftSchema = z.object({ request: createLiveCopyStrategySchema, strategyId: z.number().int().positive().nullable() }).strict();
const walletPreparationSchema = z.object({ strategyId: z.number().int().positive(), strategyVersion: z.number().int().positive(), leaderAddress: z.string(), network: z.literal('testnet'), accountId: z.string().nullable() }).strict();
const barrierSchema = z.object({ id: z.string(), command: z.enum(['pause', 'revoke']) }).strict();
const journalSchema = z.object({ barriers: z.array(barrierSchema).max(100).default([]), wallets: z.array(walletPreparationSchema).max(100).default([]), drafts: z.array(draftSchema).max(100), preparations: z.array(preparationSchema).max(100), approvals: z.array(z.string()).max(100) }).strict();
const renewalAttemptSchema = preparationSchema.extend({
  predecessor: z.object({ id: z.string().min(1).max(128), revision: z.number().int().positive(), nonce: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  evidence: liveCopyMandateRenewalSchema,
  settingsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  binding: z.object({ account: copyExecutionAccountSchema, strategy: liveCopyStrategySchema, setup: copyAgentSetupSchema, grant: copyWalletGrantSchema }).strict(),
}).strict();
const renewalsSchema = z.object({ generations: z.array(renewalAttemptSchema).max(100) }).strict().refine(v => new Set(v.generations.map(g => g.key)).size === v.generations.length);
type RenewalAttempt = z.infer<typeof renewalAttemptSchema>;
type LegacyJournalData = z.infer<typeof journalSchema>;
type JournalData = LegacyJournalData & { renewals: RenewalAttempt[] };
/** Recovery requests/IDs only. No JWT, consent signature or wallet key is stored. */
export function createLiveCopyJournal(scope: string, storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `copy-live-recovery:v1:${encodeURIComponent(scope)}`;
  const renewalKey = `copy-live-renewals:v1:${encodeURIComponent(scope)}`;
  const readLegacy = (): LegacyJournalData => { const raw = storage.getItem(key); return raw ? journalSchema.parse(JSON.parse(raw)) : { barriers: [], wallets: [], drafts: [], preparations: [], approvals: [] }; };
  const readRenewals = () => { const raw = storage.getItem(renewalKey); if (raw && new TextEncoder().encode(raw).byteLength > 524288) throw new Error('live_recovery_storage_full'); return raw ? renewalsSchema.parse(JSON.parse(raw)).generations : []; };
  const read = (): JournalData => ({ ...readLegacy(), renewals: readRenewals() });
  const write = (v: LegacyJournalData) => { const raw = JSON.stringify(journalSchema.parse(v)); storage.setItem(key, raw); if (storage.getItem(key) !== raw) throw new Error('live_recovery_storage_unavailable'); };
  return { read,
    renewal(v: RenewalAttempt) {
      const generations = readRenewals(), previous = generations.find(g => g.key === v.key);
      if (previous && (JSON.stringify({ ...previous, mandateId: null }) !== JSON.stringify({ ...v, mandateId: null }) || previous.mandateId !== null && previous.mandateId !== v.mandateId)) throw new Error('live_renewal_changed');
      const raw = JSON.stringify(renewalsSchema.parse({ generations: previous ? generations.map(g => g.key === v.key ? v : g) : [...generations, v] }));
      if (new TextEncoder().encode(raw).byteLength > 524288) throw new Error('live_recovery_storage_full');
      storage.setItem(renewalKey, raw); if (storage.getItem(renewalKey) !== raw) throw new Error('live_recovery_storage_unavailable');
    },
    markBarrier(id: string, command: 'pause' | 'revoke') { const data = readLegacy(); if (data.barriers.some(b => b.id === id)) throw new Error('live_barrier_uncertain'); data.barriers.push({ id, command }); write(data); },
    observedBarrier(m: LiveCopyMandate) { const data = readLegacy(); data.barriers = data.barriers.filter(b => b.id !== m.id || !(b.command === 'pause' && m.state === 'paused' || b.command === 'revoke' && m.state === 'revoked')); write(data); },
    wallet(v: JournalData['wallets'][number]) { const data = readLegacy(); data.wallets = [...data.wallets.filter(w => w.strategyId !== v.strategyId), v]; write(data); },
    draft(v: JournalData['drafts'][number]) { const data = readLegacy(); data.drafts = [...data.drafts.filter(d => d.request.idempotencyKey !== v.request.idempotencyKey), v]; write(data); },
    preparation(v: JournalData['preparations'][number]) { const data = readLegacy(); data.preparations = [...data.preparations.filter(p => p.accountId !== v.accountId), v]; write(data); },
    uncertain(id: string) { return read().approvals.includes(id); },
    mark(id: string) { const data = readLegacy(); if (!data.approvals.includes(id)) data.approvals.push(id); write(data); },
    resolve(id: string) { const data = readLegacy(); data.approvals = data.approvals.filter(v => v !== id); write(data); },
  };
}
export interface LiveBindingContext { account: CopyExecutionAccount; strategy: LiveCopyStrategy; setup: CopyAgentSetup; grant?: CopyWalletGrant }
export interface LiveConsentContext extends LiveBindingContext { mandate: LiveCopyMandate; reviewedIntent?: z.infer<typeof liveCopyMandateChallengeSchema>['intent'] }
interface OwnerDeps { snapshot(): AgentOwnerSnapshot; journal: ReturnType<typeof createLiveCopyJournal> }
interface DraftDeps extends OwnerDeps { newKey(): string; create(body: CreateLiveCopyStrategy, guard: () => void): Promise<unknown>; findStrategy(key: string): Promise<unknown> }
interface PrepareDeps extends OwnerDeps { newKey(): string; current(): LiveBindingContext | null; now(): number; prepare(id: string, body: { idempotencyKey: string }, guard: () => void): Promise<unknown>; findMandate(key: string): Promise<unknown> }
interface RenewDeps extends PrepareDeps { current(): LiveConsentContext | null; challenge(id: string): Promise<unknown> }
interface ApproveDeps extends OwnerDeps { current(): LiveConsentContext | null; now(): number; challenge(id: string): Promise<unknown>; sign(data: Eip712TypedData): Promise<string>; approve(id: string, body: { consentSignature: string }, guard: () => void): Promise<unknown> }
function ownerGuard(deps: OwnerDeps, wallet: boolean) {
  const initial = { ...deps.snapshot() };
  if (initial.status !== 'signedIn' || initial.mode !== 'privy' || !initial.identity || wallet && !/^0x[0-9a-f]{40}$/.test(initial.walletAddress ?? '')) throw new Error('live_owner_unavailable');
  return () => { const now = deps.snapshot(); if (Object.keys(initial).some(k => initial[k as keyof AgentOwnerSnapshot] !== now[k as keyof AgentOwnerSnapshot])) throw new Error('live_session_changed'); };
}
function settingsEqual(a: unknown, b: unknown) { return JSON.stringify(copyStrategySettingsSchema.strict().parse(a)) === JSON.stringify(copyStrategySettingsSchema.strict().parse(b)); }
function requestMatches(request: CreateLiveCopyStrategy, result: LiveCopyStrategy) { if (result.leaderAddress !== request.leader || result.sourceNetwork !== request.sourceNetwork || result.budgetUsd !== request.budgetUsd || !settingsEqual(result.settings, request.settings)) throw new Error('live_draft_changed'); }
export async function createLiveCopyDraft(input: Omit<CreateLiveCopyStrategy, 'idempotencyKey'>, deps: DraftDeps): Promise<LiveCopyStrategy> {
  const guard = ownerGuard(deps, false); guard();
  const previous = deps.journal.read().drafts.find(d => d.strategyId === null);
  const request = createLiveCopyStrategySchema.parse({ ...structuredClone(input), idempotencyKey: previous?.request.idempotencyKey ?? deps.newKey() });
  if (request.sourceNetwork !== 'testnet' && request.sourceNetwork !== 'mainnet') throw new Error('live_source_unsupported');
  if (previous && JSON.stringify(previous.request) !== JSON.stringify(request)) throw new Error('live_draft_changed');
  if (!previous) deps.journal.draft({ request, strategyId: null }); guard();
  // An uncertain response is never retried as a POST, even with the same key.
  const raw = previous ? await deps.findStrategy(request.idempotencyKey) : await deps.create(request, guard); guard();
  const result = liveCopyStrategySchema.parse(raw); requestMatches(request, result);
  if (!previous && (result.status !== 'paused' || !result.pauseNewRisk || result.reduceOnly)) throw new Error('live_draft_changed');
  deps.journal.draft({ request, strategyId: result.id }); return result;
}
function sameContext(original: LiveBindingContext, value: LiveBindingContext | null, mandate = true) {
  if (!value || ['id', 'strategyId', 'network', 'address', 'state', 'updatedAt', 'revision'].some(k => Reflect.get(original.account, k) !== Reflect.get(value.account, k)) ||
    ['id', 'mode', 'network', 'sourceNetwork', 'leaderAddress', 'budgetUsd', 'version', 'status', 'pauseNewRisk', 'reduceOnly'].some(k => Reflect.get(original.strategy, k) !== Reflect.get(value.strategy, k)) || !settingsEqual(original.strategy.settings, value.strategy.settings) ||
    ['id', 'accountId', 'strategyId', 'network', 'accountAddress', 'agentAddress', 'authorizationId', 'state', 'expiresAt', 'updatedAt', 'revision'].some(k => Reflect.get(original.setup, k) !== Reflect.get(value.setup, k)) || JSON.stringify(original.grant) !== JSON.stringify(value.grant) ||
    mandate && JSON.stringify(Reflect.get(original, 'mandate')) !== JSON.stringify(Reflect.get(value, 'mandate'))) throw new Error('live_binding_changed');
}
function ready(context: LiveBindingContext, now: number) {
  const { account: a, strategy: s, setup, grant } = context;
  if (a.state !== 'ready' || a.network !== 'testnet' || s.id !== a.strategyId || s.mode !== 'actual' || s.network !== 'testnet' || (s.sourceNetwork !== 'testnet' && s.sourceNetwork !== 'mainnet') || s.settings.copyStartMode !== 'delta' || s.status !== 'paused' || !s.pauseNewRisk || s.reduceOnly || setup.state !== 'active' || setup.accountId !== a.id || setup.strategyId !== s.id || setup.network !== a.network || setup.accountAddress !== a.address || !setup.authorizationId || Date.parse(setup.expiresAt) <= now || grant && (grant.id !== setup.authorizationId || grant.status !== 'active' || grant.strategyId !== s.id || grant.network !== a.network || grant.accountAddress !== a.address || grant.signerAddress !== setup.agentAddress || grant.revokedAt !== null || Date.parse(grant.expiresAt) <= now || !grant.scopes.includes('copy:trade') || !grant.scopes.includes('copy:reduce'))) throw new Error('live_binding_unavailable');
}
function sameMandate(original: LiveCopyMandate, result: LiveCopyMandate) {
  for (const k of ['id', 'accountId', 'strategyId', 'mode', 'network', 'accountAddress', 'sourceNetwork', 'leaderAddress', 'budgetUsd', 'strategyVersion', 'expiresAt', 'createdAt'] as const) if (original[k] !== result[k]) throw new Error('live_mandate_changed');
}
function challengeMatches(context: LiveBindingContext, raw: unknown, ownerAddress?: string | null) {
  const challenge = liveCopyMandateChallengeSchema.parse(raw), { intent: i, mandate: m } = challenge, { account: a, strategy: s, setup } = context;
  if (m.accountId !== a.id || m.strategyId !== s.id || m.accountAddress !== a.address || m.strategyVersion !== s.version || m.leaderAddress !== s.leaderAddress || m.budgetUsd !== s.budgetUsd || m.sourceNetwork !== s.sourceNetwork ||
    i.mandateId !== m.id || i.accountId !== a.id || i.strategyId !== s.id || i.strategyVersion !== s.version || i.accountAddress !== a.address || i.leaderAddress !== s.leaderAddress || i.budgetUsd !== s.budgetUsd || i.sourceNetwork !== s.sourceNetwork ||
    context.grant?.version !== undefined && i.authorizationVersion !== context.grant.version || i.setupId !== setup.id || i.agentAddress !== setup.agentAddress || i.authorizationId !== setup.authorizationId || i.expiresAt !== Date.parse(m.expiresAt) || i.expiresAt > Date.parse(setup.expiresAt) ||
    Reflect.has(a, 'revision') && Reflect.get(a, 'revision') !== undefined && i.accountRevision !== Reflect.get(a, 'revision') || Reflect.has(setup, 'revision') && Reflect.get(setup, 'revision') !== undefined && i.setupRevision !== Reflect.get(setup, 'revision') || ownerAddress && i.ownerAddress !== ownerAddress) throw new Error('live_challenge_changed');
  return challenge;
}
export async function prepareLiveCopyConsent(input: LiveBindingContext, deps: PrepareDeps) {
  const context = structuredClone(input), owner = ownerGuard(deps, true), guard = () => { owner(); sameContext(context, deps.current(), false); ready(context, deps.now()); }; guard();
  const previous = deps.journal.read().preparations.find(p => p.accountId === context.account.id);
  if (previous && (previous.strategyId !== context.strategy.id || previous.accountAddress !== context.account.address || previous.strategyVersion !== context.strategy.version)) throw new Error('live_preparation_changed');
  const attempt = previous ?? { accountId: context.account.id, strategyId: context.strategy.id, accountAddress: context.account.address!, strategyVersion: context.strategy.version, key: deps.newKey(), mandateId: null };
  deps.journal.preparation(attempt); guard();
  const raw = previous ? await deps.findMandate(attempt.key) : await deps.prepare(context.account.id, { idempotencyKey: attempt.key }, guard); guard();
  const result = challengeMatches(context, raw, deps.snapshot().walletAddress);
  if (attempt.mandateId && attempt.mandateId !== result.mandate.id) throw new Error('live_preparation_changed');
  deps.journal.preparation({ ...attempt, mandateId: result.mandate.id }); return result;
}
export type LiveCopyChallenge = z.infer<typeof liveCopyMandateChallengeSchema>;
/** Optional rolling response evidence is never replaced with a browser deadline. */
export function liveCopyRenewalEligible(value: LiveCopyChallenge, now: number): boolean {
  const parsed = liveCopyMandateChallengeSchema.safeParse(value);
  if (!parsed.success) return false;
  const { mandate: m, intent: i, renewal: r } = parsed.data;
  if (!r || !r.eligible || !Number.isSafeInteger(now) || m.state === 'stopped') return false;
  if (r.mandateId !== m.id || r.revision !== m.revision || r.nonce !== i.nonce || i.mandateId !== m.id) return false;
  const checked = Date.parse(r.checkedAt);
  if (!Number.isSafeInteger(checked) || checked < i.nonce || checked > now || now - checked > 5000) return false;
  if (r.reason === 'revoked') return m.state === 'revoked';
  if (r.reason === 'generation_expired') return m.state !== 'revoked' && checked >= i.expiresAt;
  return r.reason === 'prepared_consent_expired' && (m.state === 'prepared' || m.state === 'expired') && checked >= i.consentExpiresAt && checked < i.expiresAt;
}
export async function renewLiveCopyConsent(input: LiveConsentContext, reviewed: LiveCopyChallenge, deps: RenewDeps) {
  const context = structuredClone(input), original = liveCopyMandateChallengeSchema.parse(structuredClone(reviewed)), owner = ownerGuard(deps, true), started = deps.now();
  const guard = () => { owner(); sameContext(context, deps.current()); if (!Number.isSafeInteger(deps.now()) || deps.now() < started) throw new Error('live_renewal_clock_changed'); };
  guard(); sameMandate(context.mandate, original.mandate);
  if (JSON.stringify(context.mandate) !== JSON.stringify(original.mandate) || original.intent.ownerAddress !== deps.snapshot().walletAddress) throw new Error('live_mandate_changed');
  const previous = deps.journal.read().renewals.find(g => g.accountId === context.account.id && g.predecessor.id === original.mandate.id);
  const validate = (raw: unknown, attempt: RenewalAttempt) => {
    const result = challengeMatches(attempt.binding, raw, deps.snapshot().walletAddress);
    if (result.mandate.id === attempt.predecessor.id || result.intent.nonce <= attempt.predecessor.nonce || attempt.mandateId && result.mandate.id !== attempt.mandateId || result.intent.settingsDigest !== attempt.settingsDigest) throw new Error('live_renewal_changed');
    return result;
  };
  if (previous) {
    const result = validate(await deps.findMandate(previous.key), previous); guard();
    deps.journal.renewal({ ...previous, mandateId: result.mandate.id }); return result;
  }
  const renewable = (value: LiveCopyChallenge) => { guard(); ready(context, deps.now()); if (!context.grant || !liveCopyRenewalEligible(value, deps.now()) || deps.journal.read().barriers.some(b => b.id === original.mandate.id)) throw new Error('live_renewal_unavailable'); };
  renewable(original);
  const fresh = liveCopyMandateChallengeSchema.parse(await deps.challenge(original.mandate.id)); guard();
  if (JSON.stringify(fresh.mandate) !== JSON.stringify(original.mandate) || JSON.stringify(fresh.intent) !== JSON.stringify(original.intent)) throw new Error('live_mandate_changed');
  renewable(fresh);
  const currentSettings = await settingsDigest(context.strategy.settings); renewable(fresh);
  const attempt: RenewalAttempt = renewalAttemptSchema.parse({ accountId: context.account.id, strategyId: context.strategy.id, accountAddress: context.account.address,
    strategyVersion: context.strategy.version, key: deps.newKey(), mandateId: null, predecessor: { id: original.mandate.id, revision: original.mandate.revision, nonce: original.intent.nonce }, evidence: fresh.renewal, settingsDigest: currentSettings,
    binding: { account: context.account, strategy: context.strategy, setup: context.setup, grant: context.grant } });
  deps.journal.renewal(attempt); renewable(fresh);
  const response = await deps.prepare(context.account.id, { idempotencyKey: attempt.key }, () => renewable(fresh)); guard();
  const result = validate(response, attempt);
  if (result.mandate.state !== 'prepared' || result.intent.nonce > deps.now() || result.intent.consentExpiresAt <= deps.now() || result.intent.expiresAt <= deps.now()) throw new Error('live_renewal_changed');
  deps.journal.renewal({ ...attempt, mandateId: result.mandate.id }); return result;
}
async function settingsDigest(settings: LiveCopyStrategy['settings']) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(copyStrategySettingsSchema.strict().parse(settings))));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function approveLiveCopyConsent(input: LiveConsentContext, deps: ApproveDeps): Promise<LiveCopyMandate> {
  const context = structuredClone(input), owner = ownerGuard(deps, true), signing = context.mandate.state === 'prepared' && !deps.journal.uncertain(context.mandate.id);
  const guard = () => { owner(); sameContext(context, deps.current()); if (signing) ready(context, deps.now()); }; guard();
  const raw = await deps.challenge(context.mandate.id); guard();
  const result = signing ? challengeMatches(context, raw, deps.snapshot().walletAddress) : liveCopyMandateChallengeSchema.parse(raw); sameMandate(context.mandate, result.mandate);
  if (!signing) { if (result.mandate.state !== 'prepared') deps.journal.resolve(context.mandate.id); return result.mandate; }
  const { intent, mandate } = result;
  if (context.reviewedIntent && JSON.stringify(context.reviewedIntent) !== JSON.stringify(intent)) throw new Error('live_challenge_changed');
  if (mandate.state !== 'prepared' || mandate.revision !== context.mandate.revision) throw new Error('live_mandate_changed');
  if (intent.settingsDigest !== await settingsDigest(context.strategy.settings)) throw new Error('live_settings_changed'); guard();
  const expires = () => { const now = deps.now(); if (!Number.isSafeInteger(now) || now < intent.nonce || now >= intent.consentExpiresAt || now >= intent.expiresAt) throw new Error('live_consent_expired'); };
  guard(); expires(); const signature = await deps.sign(liveCopyMandateOwnerTypedData(intent)); guard(); expires();
  const body = approveLiveCopyMandateSchema.parse({ consentSignature: signature }); deps.journal.mark(mandate.id); guard(); expires();
  const response = await deps.approve(mandate.id, body, () => { guard(); expires(); }); owner();
  const approved = liveCopyMandateSchema.parse(response); sameMandate(mandate, approved);
  if (approved.state !== 'prepared') deps.journal.resolve(mandate.id); return approved;
}

function useLiveKey() { const a = useAuth(); return [...queryKeys.copy.all, 'actual-live', a.status, a.mode, a.identity, sessionKey(), a.wallet?.address?.toLowerCase()] as const; }
export function useLiveCopyOverview() {
  const auth = useAuth(), latest = useRef(auth), mounted = useRef(true);
  useLayoutEffect(() => { latest.current = auth; }, [auth]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = () => { const a = latest.current; return { status: mounted.current ? a.status : 'disposed', mode: a.mode, identity: a.identity, session: sessionKey(), walletAddress: a.wallet?.address?.toLowerCase() ?? null }; };
  // Privy users, and the fixture signer's stand-in (browser tests of one-click copy).
  const enabled = liveCopyEnabled(auth);
  const query = useQuery({ queryKey: useLiveKey(), enabled, queryFn: async ({ signal }) => {
    const captured = snapshot(); const guard = () => { signal.throwIfAborted(); if (JSON.stringify(captured) !== JSON.stringify(snapshot())) throw new Error('live_session_changed'); }; guard(); const result = await api.get(ROOT, signal); guard(); return liveCopyOverviewSchema.parse(result);
  }, staleTime: 0, gcTime: 0, retry: false, refetchInterval: 15000, refetchOnWindowFocus: true });
  return { ...query, data: enabled && !query.isError ? query.data : undefined };
}
export function useLiveCopyActions(accounts: readonly CopyExecutionAccount[], overview: z.infer<typeof liveCopyOverviewSchema> | undefined, setups: readonly CopyAgentSetup[], selected: string, draft: Omit<CreateLiveCopyStrategy, 'idempotencyKey'> | null, grants?: readonly CopyWalletGrant[]) {
  const auth = useAuth(), state = useRef({ auth, accounts, overview, setups, selected, draft, grants }), mounted = useRef(true), busy = useRef(false), client = useQueryClient(), key = useLiveKey();
  useLayoutEffect(() => { state.current = { auth, accounts, overview, setups, selected, draft, grants }; }, [auth, accounts, overview, setups, selected, draft, grants]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = (): AgentOwnerSnapshot => { const a = state.current.auth; return { status: mounted.current ? a.status : 'disposed', mode: a.mode, identity: a.identity, session: sessionKey(), walletAddress: a.wallet?.address?.toLowerCase() ?? null }; };
  const journal = () => { const a = snapshot(); return createLiveCopyJournal(`${a.mode}:${a.identity}:${a.walletAddress}`, window.sessionStorage); };
  const recoveryKey = [...key, 'recovery'];
  const recovery = useQuery({ queryKey: recoveryKey, enabled: auth.status === 'signedIn' && auth.mode === 'privy', retry: false, gcTime: 0, queryFn: async () => journal().read() });
  const binding = (): LiveBindingContext | null => { const v = state.current, account = v.accounts.find(a => a.id === v.selected), strategy = v.overview?.strategies.find(s => s.id === account?.strategyId), setup = v.setups.find(s => s.accountId === account?.id && s.state === 'active'); const grant = v.grants?.find(g => g.id === setup?.authorizationId); return account && strategy && setup && (v.grants === undefined || grant) ? { account, strategy, setup, ...(grant ? { grant } : {}) } : null; };
  const context = (id: string): LiveConsentContext | null => { const b = binding(), mandate = state.current.overview?.mandates.find(m => m.id === id); return b && mandate ? { ...b, mandate } : null; };
  const exclusive = async <T,>(run: () => Promise<T>) => { if (busy.current) throw new Error('live_action_in_progress'); busy.current = true; try { return await run(); } finally { busy.current = false; } };
  const settled = async () => { await Promise.all([client.invalidateQueries({ queryKey: key, exact: true }), client.invalidateQueries({ queryKey: recoveryKey, exact: true }), client.invalidateQueries({ queryKey: [...queryKeys.copy.all, 'execution-wallets'] })]); };
  const create = useMutation({ retry: false, mutationFn: (request: Omit<CreateLiveCopyStrategy, 'idempotencyKey'>) => exclusive(() => {
    const captured = structuredClone(request), source = snapshot();
    const guardDraft = () => { if (JSON.stringify(captured) !== JSON.stringify(state.current.draft) || !state.current.overview?.capabilities.strategyPreparation || JSON.stringify(source) !== JSON.stringify(snapshot())) throw new Error('live_draft_changed'); };
    guardDraft(); return createLiveCopyDraft(request, { snapshot, journal: journal(), newKey: () => crypto.randomUUID(), findStrategy: value => api.get(`${ROOT}/strategies/by-key/${encodeURIComponent(value)}`), create: (body, guard) => api.post(`${ROOT}/strategies`, body, { beforeSend: () => { guardDraft(); guard(); } }) });
  }), onSettled: settled });
  const prepare = useMutation({ retry: false, mutationFn: () => exclusive(() => { const b = binding(); if (!b || !state.current.overview?.capabilities.strategyPreparation) throw new Error('live_binding_unavailable'); return prepareLiveCopyConsent(b, { snapshot, journal: journal(), current: binding, now: Date.now, newKey: () => crypto.randomUUID(), prepare: (id, body, beforeSend) => api.post(`${ROOT}/execution-wallets/${encodeURIComponent(id)}/mandates`, body, { beforeSend }), findMandate: value => api.get(`${ROOT}/mandates/by-key/${encodeURIComponent(value)}`) }); }), onSettled: settled });
  const renew = useMutation({ retry: false, mutationFn: (review: LiveCopyChallenge) => exclusive(() => {
    const c = context(review.mandate.id); if (!c || !state.current.overview?.capabilities.strategyPreparation) throw new Error('live_binding_unavailable');
    return renewLiveCopyConsent(c, review, { snapshot, journal: journal(), current: () => context(review.mandate.id), now: Date.now, newKey: () => crypto.randomUUID(), challenge: id => api.get(`${ROOT}/mandates/${encodeURIComponent(id)}/challenge`),
      prepare: (id, body, beforeSend) => api.post(`${ROOT}/execution-wallets/${encodeURIComponent(id)}/mandates`, body, { beforeSend }), findMandate: value => api.get(`${ROOT}/mandates/by-key/${encodeURIComponent(value)}`) });
  }), onSettled: settled });
  const read = useMutation({ retry: false, mutationFn: (mandate: LiveCopyMandate) => exclusive(async () => {
    const saved = journal(), guard = ownerGuard({ snapshot, journal: saved }, false), selectedAccount = structuredClone(state.current.accounts.find(a => a.id === state.current.selected));
    const check = () => { guard(); const a = state.current.accounts.find(a => a.id === state.current.selected); if (!selectedAccount || !a || a.id !== mandate.accountId || a.strategyId !== mandate.strategyId || a.address !== mandate.accountAddress || a.network !== mandate.network || JSON.stringify(selectedAccount) !== JSON.stringify(a)) throw new Error('live_binding_changed'); }; check();
    const response = await api.get(`${ROOT}/mandates/${encodeURIComponent(mandate.id)}/challenge`); check(); const result = liveCopyMandateChallengeSchema.parse(response); sameMandate(mandate, result.mandate); if (result.mandate.state !== 'prepared') saved.resolve(mandate.id); saved.observedBarrier(result.mandate); return result;
  }), onSettled: settled });
  const approve = useMutation({ retry: false, mutationFn: (review: z.infer<typeof liveCopyMandateChallengeSchema>) => exclusive(() => {
    const c = context(review.mandate.id); if (!c || !state.current.overview?.capabilities.strategyPreparation) throw new Error('live_binding_unavailable');
    return approveLiveCopyConsent({ ...c, reviewedIntent: review.intent }, { snapshot, journal: journal(), current: () => context(review.mandate.id), now: Date.now, challenge: id => api.get(`${ROOT}/mandates/${encodeURIComponent(id)}/challenge`), sign: typed => { const wallet = state.current.auth.wallet; if (!wallet) throw new Error('live_owner_unavailable'); return wallet.signTypedData(typed); }, approve: (id, body, beforeSend) => api.post(`${ROOT}/mandates/${encodeURIComponent(id)}/approve`, body, { beforeSend }) });
  }), onSettled: settled });
  const recover = useMutation({ retry: false, mutationFn: (item: { kind: 'draft'; value: JournalData['drafts'][number] } | { kind: 'preparation'; value: JournalData['preparations'][number] } | { kind: 'renewal'; value: RenewalAttempt }) => exclusive(async () => {
    const saved = journal(), guard = ownerGuard({ snapshot, journal: saved }, false); guard();
    if (item.kind === 'draft') { const result = liveCopyStrategySchema.parse(await api.get(`${ROOT}/strategies/by-key/${encodeURIComponent(item.value.request.idempotencyKey)}`)); guard(); requestMatches(item.value.request, result); saved.draft({ ...item.value, strategyId: result.id }); return; }
    const original = structuredClone(state.current.accounts.find(a => a.id === state.current.selected));
    const check = () => { guard(); const a = state.current.accounts.find(a => a.id === state.current.selected); if (!a || !original || JSON.stringify(a) !== JSON.stringify(original) || a.id !== item.value.accountId || a.strategyId !== item.value.strategyId || a.address !== item.value.accountAddress) throw new Error('live_binding_changed'); }; check();
    const result = liveCopyMandateChallengeSchema.parse(await api.get(`${ROOT}/mandates/by-key/${encodeURIComponent(item.value.key)}`)); check();
    if (result.mandate.accountId !== item.value.accountId || result.mandate.accountAddress !== item.value.accountAddress || result.mandate.strategyId !== item.value.strategyId || result.mandate.strategyVersion !== item.value.strategyVersion || item.value.mandateId && result.mandate.id !== item.value.mandateId) throw new Error('live_preparation_changed');
    if (item.kind === 'renewal') {
      challengeMatches(item.value.binding, result, snapshot().walletAddress);
      if (result.mandate.id === item.value.predecessor.id || result.intent.nonce <= item.value.predecessor.nonce || result.intent.settingsDigest !== item.value.settingsDigest) throw new Error('live_renewal_changed');
      saved.renewal({ ...item.value, mandateId: result.mandate.id });
    } else saved.preparation({ ...item.value, mandateId: result.mandate.id });
    return result;
  }), onSettled: settled });
  const barrier = useMutation({ retry: false, mutationFn: ({ mandate, command }: { mandate: LiveCopyMandate; command: 'pause' | 'revoke' }) => exclusive(async () => {
    const saved = journal(), owner = ownerGuard({ snapshot, journal: saved }, false), originalAccount = structuredClone(state.current.accounts.find(a => a.id === state.current.selected));
    const guard = () => { owner(); const v = state.current, account = v.accounts.find(a => a.id === v.selected), currentMandate = v.overview?.mandates.find(m => m.id === mandate.id);
      if (!originalAccount || !account || account.id !== mandate.accountId || account.address !== mandate.accountAddress || account.strategyId !== mandate.strategyId || account.network !== mandate.network || JSON.stringify(account) !== JSON.stringify(originalAccount) || JSON.stringify(currentMandate) !== JSON.stringify(mandate)) throw new Error('live_binding_changed'); }; guard();
    saved.markBarrier(mandate.id, command); guard();
    const raw = await api.post(`${ROOT}/mandates/${encodeURIComponent(mandate.id)}/${command}`, {}, { beforeSend: guard }); owner(); const result = liveCopyMandateSchema.parse(raw); sameMandate(mandate, result); saved.observedBarrier(result); return result;
  }), onSettled: settled });
  return { create, prepare, renew, approve, read, recover, barrier, recovery, ownerReady: auth.status === 'signedIn' && auth.mode === 'privy' && Boolean(auth.identity && auth.wallet?.address) };
}
interface WalletDeps extends OwnerDeps { currentStrategy(): LiveCopyStrategy | null; createWallet(id: number, body: { network: 'testnet' }, guard: () => void): Promise<unknown>; readWallets(): Promise<unknown> }
export async function prepareActualCopyWallet(input: LiveCopyStrategy, deps: WalletDeps): Promise<CopyExecutionAccount> {
  const strategy = liveCopyStrategySchema.parse(structuredClone(input)), owner = ownerGuard(deps, false);
  const guard = () => { owner(); const current = deps.currentStrategy(); if (!current || JSON.stringify(strategy) !== JSON.stringify(current) || strategy.status !== 'paused' || !strategy.pauseNewRisk || strategy.reduceOnly || (strategy.sourceNetwork !== 'testnet' && strategy.sourceNetwork !== 'mainnet')) throw new Error('live_wallet_strategy_changed'); }; guard();
  const saved = deps.journal.read().wallets.find(w => w.strategyId === strategy.id);
  if (saved && (saved.strategyVersion !== strategy.version || saved.leaderAddress !== strategy.leaderAddress)) throw new Error('live_wallet_strategy_changed');
  const attempt = saved ?? { strategyId: strategy.id, strategyVersion: strategy.version, leaderAddress: strategy.leaderAddress, network: 'testnet' as const, accountId: null };
  deps.journal.wallet(attempt); guard();
  let result: CopyExecutionAccount;
  if (saved) {
    const overview = copyExecutionWalletsSchema.parse(await deps.readWallets()); guard(); const originals = overview.accounts.filter(a => a.strategyId === strategy.id && a.network === 'testnet');
    if (originals.length !== 1 || saved.accountId && originals[0].id !== saved.accountId) throw new Error('live_wallet_original_unconfirmed'); result = originals[0];
  } else { const raw = await deps.createWallet(strategy.id, { network: 'testnet' }, guard); guard(); result = copyExecutionAccountSchema.parse(raw); }
  if (result.strategyId !== strategy.id || result.network !== 'testnet') throw new Error('live_wallet_strategy_changed');
  deps.journal.wallet({ ...attempt, accountId: result.id }); return result;
}
export function useActualCopyWalletPreparation(strategies: readonly LiveCopyStrategy[], selectedStrategyId: number | null) {
  const auth = useAuth(), latest = useRef({ auth, strategies, selectedStrategyId }), mounted = useRef(true), client = useQueryClient(), key = useLiveKey();
  useLayoutEffect(() => { latest.current = { auth, strategies, selectedStrategyId }; }, [auth, strategies, selectedStrategyId]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = () => { const a = latest.current.auth; return { status: mounted.current ? a.status : 'disposed', mode: a.mode, identity: a.identity, session: sessionKey(), walletAddress: a.wallet?.address?.toLowerCase() ?? null }; };
  const recoveryKey = [...key, 'wallet-recovery'];
  const recovery = useQuery({ queryKey: recoveryKey, enabled: auth.status === 'signedIn' && auth.mode === 'privy', retry: false, gcTime: 0, queryFn: async () => { const a = snapshot(); return createLiveCopyJournal(`${a.mode}:${a.identity}:${a.walletAddress}`, window.sessionStorage).read().wallets; } });
  const mutation = useMutation({ retry: false, mutationFn: (strategy: LiveCopyStrategy) => {
    const a = snapshot(); return prepareActualCopyWallet(strategy, { snapshot, journal: createLiveCopyJournal(`${a.mode}:${a.identity}:${a.walletAddress}`, window.sessionStorage), currentStrategy: () => latest.current.selectedStrategyId === strategy.id ? latest.current.strategies.find(s => s.id === strategy.id) ?? null : null,
      createWallet: (id, body, beforeSend) => api.post(`/me/copy/strategies/${id}/execution-wallet`, body, { beforeSend }), readWallets: () => api.get('/me/copy/execution-wallets') });
  }, onSettled: async () => { await Promise.all([client.invalidateQueries({ queryKey: key, exact: true }), client.invalidateQueries({ queryKey: recoveryKey, exact: true }), client.invalidateQueries({ queryKey: [...queryKeys.copy.all, 'execution-wallets'] })]); } });
  return { ...mutation, recovery };
}
