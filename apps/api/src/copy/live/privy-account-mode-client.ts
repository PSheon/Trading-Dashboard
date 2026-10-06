import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { UserSetAbstractionTypes } from '@nktkas/hyperliquid/api/exchange';
import { HYPERLIQUID_NETWORKS, WALLET_NETWORKS, splitSignature, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { z } from 'zod';
import { Dec } from '../../common/decimal/dec.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { boundedLiveRead } from './live-market-resolver.js';
import {HyperliquidGlobalTransport} from '../../hyperliquid/hyperliquid-global-transport.js';
import { LiveBoundaryError } from './wallet-authorization.js';
import { LIVE_RESERVE_WAIT_MS, sharedCapacityWait, type LiveBudget, type LiveReserveOptions } from '../../hyperliquid/hyperliquid-budget-wait.js';

export interface AccountModeIntent {
  readonly operationId: string; readonly accountId: string; readonly strategyId: number;
  readonly network: HyperliquidNetwork; readonly accountAddress: string; readonly nonce: number; readonly consentExpiresAt: number;
}
export interface AccountModeOwnedMaster { readonly walletId: string; readonly address: string; readonly ownerQuorumId: string }
/** Provider weight of one observation: userRole 60, userAbstraction 20,
 * userDexAbstraction 20, spotClearinghouseState 2. */
export const ACCOUNT_MODE_OBSERVE_WEIGHT = 102;
export interface AccountModeObserveOptions {
  /** The caller already took the weight from the budget (a preflight). */
  readonly prepaid?: boolean;
  /** Longest wait for the local budget (not prepaid). */
  readonly maxWaitMs?: number;
  /** Longest wait for room in the shared per-IP meter, before the clock starts. */
  readonly meterWaitMs?: number;
  /** Abandoned (a sibling read failed): nothing more is started. */
  readonly signal?: AbortSignal;
}
export interface AccountModeObservation {
  readonly network: HyperliquidNetwork; readonly accountAddress: string;
  readonly role: 'missing' | 'user' | 'agent' | 'vault' | 'subAccount';
  readonly abstraction: 'default' | 'disabled' | 'unifiedAccount' | 'portfolioMargin';
  readonly dexAbstraction: boolean | null; readonly portfolioMarginEnabled: boolean;
  readonly earliestObservedAt: number; readonly completedAt: number;
  readonly source: (typeof WALLET_NETWORKS)[HyperliquidNetwork]['infoUrl']; readonly sourceDigest: `0x${string}`;
  readonly status: 'confirmed' | 'unproven' | 'unsupported'; readonly issue: string | null;
}
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const ethereumAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v)).transform(v => v.toLowerCase());
const intentSchema = z.object({ operationId: identifier, accountId: identifier, strategyId: integer,
  network: z.enum(HYPERLIQUID_NETWORKS), accountAddress: ethereumAddress, nonce: integer, consentExpiresAt: integer }).strict()
  .refine(v => v.consentExpiresAt > v.nonce && v.consentExpiresAt - v.nonce <= 300_000);
const types = frozen(structuredClone(UserSetAbstractionTypes));
const roleSchema = z.object({ role: z.enum(['missing', 'user', 'agent', 'vault', 'subAccount']) });
const abstractionSchema = z.enum(['default', 'disabled', 'unifiedAccount', 'portfolioMargin']);
const decimal = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const spotSchema = z.object({ portfolioMarginEnabled: z.boolean().optional(), balances: z.array(z.object({
  coin: z.string().min(1).max(80), token: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), total: decimal, hold: decimal,
})).max(10_000) });
const acknowledgment = z.union([z.object({ status: z.literal('ok'), response: z.object({ type: z.literal('default') }).strict() }).strict(),
  z.object({ status: z.literal('err'), response: z.string().min(1).max(8192) }).strict()]);
function fail(code: string): never { throw new LiveBoundaryError(code); }
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function capture(intent: AccountModeIntent): AccountModeIntent { return frozen(intentSchema.parse(structuredClone(intent))); }
function validTime(now: number): void { if (!Number.isSafeInteger(now) || now <= 0) fail('account_mode_invalid_clock'); }
function live(intent: AccountModeIntent, now: number): void {
  validTime(now);
  if (now < intent.nonce || now >= intent.consentExpiresAt) fail('account_mode_consent_expired');
}
function fresh(started: number, now: number): void {
  validTime(now);
  if (now < started || now - started > 5000) fail('account_mode_evidence_stale');
}
function validSignature(signature: string): void {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(signature)) fail('account_mode_invalid_signature');
}
function synchronousProof(assertFreshProof?: () => void): void {
  const result: unknown = assertFreshProof?.();
  if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); throw new Error(); }
}

/** Current principal action only. No deprecated DEX opt-out or multisig aliases. */
export function accountModeTypedData(raw: AccountModeIntent) {
  const intent = capture(raw), network = WALLET_NETWORKS[intent.network];
  return frozen({ domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: Number.parseInt(network.signatureChainId, 16),
    verifyingContract: '0x0000000000000000000000000000000000000000' as const },
  types, primaryType: 'HyperliquidTransaction:UserSetAbstraction' as const,
  message: { type: 'userSetAbstraction' as const, signatureChainId: network.signatureChainId, hyperliquidChain: network.hyperliquidChain,
    user: intent.accountAddress as `0x${string}`, abstraction: 'disabled' as const, nonce: intent.nonce } });
}

/** One explicitly authorized owner setup action. Durable attempted state and
 * final local ownership/consent gates belong to the caller; this client never
 * retries, signs, creates a wallet or approves an agent (the copy account's
 * own signature is made in the owner's browser). */
export class PrivyAccountModeClient {
  private readonly credentials: Readonly<{ appId: string; appSecret: string }> | null;
  constructor(config: { appId?: string; appSecret?: string }, private readonly budget: LiveBudget,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now,private readonly global?:HyperliquidGlobalTransport) {
    if(global!==undefined&&!(global instanceof HyperliquidGlobalTransport))fail('account_mode_invalid_client');
    if (typeof budget !== 'function' || typeof fetcher !== 'function' || typeof now !== 'function') fail('account_mode_invalid_client');
    this.credentials = config.appId && config.appSecret ? Object.freeze({ appId: config.appId, appSecret: config.appSecret }) : null;
  }
  get available(): boolean { return this.credentials !== null; }
  /** Caller reserves weight exactly once before its durable attempt/POST. */
  async acquire(): Promise<void> {
    try { await boundedLiveRead(() => this.budget(1), 5000); } catch { fail('account_mode_budget_unavailable'); }
  }
  /** Exactly one POST per call. Caller must persist attempted/unknown first;
   * neither success acknowledgment nor timeout grants authority to resubmit. */
  async send(rawIntent: AccountModeIntent, signature: string, assertFreshProof?: () => void): Promise<unknown> {
    const intent = capture(rawIntent), data = accountModeTypedData(intent);
    live(intent, this.now()); validSignature(signature);
    const body = JSON.stringify({ action: data.message, nonce: intent.nonce, signature: splitSignature(signature) });
    let dispatched = false;
    try {
      const started = this.now(), timeout = Math.max(1, Math.min(10_000, intent.consentExpiresAt - started)), deadline = started + timeout;
      const remaining = () => { const now = this.now(); validTime(now); if (now < started || now >= deadline) throw new Error(); return deadline - now; };
      const request: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(timeout) };
      if(this.global&&typeof assertFreshProof!=='function')throw new Error();
      const permit=this.global?await this.global.currentQuota().acquireRest(1,Math.min(this.now()+5000,intent.consentExpiresAt)):undefined;
      live(intent, this.now()); remaining();
      // Complete request construction first, then check captured caller proof.
      // No await or further clock-dependent preparation precedes actual POST.
      const dispatch=()=>{synchronousProof(assertFreshProof);permit?.assertFresh();live(intent,this.now());remaining();dispatched=true;return this.fetcher(WALLET_NETWORKS[intent.network].exchangeUrl,request);};
      const work=permit?permit.dispatch(dispatch):dispatch();void Promise.resolve(work).catch(()=>undefined);
      const response = await boundedLiveRead(() => work, remaining());
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
      return frozen(acknowledgment.parse(await boundedLiveRead(() => readInfoJson(response, 'account mode acknowledgment', 64 * 1024), remaining())));
    } catch {
      // Refused before the POST was handed to the transport (the meter's
      // permit, a stale proof, the clock): nothing left this process, and
      // the caller may put the operation back. Once handed over, unknown.
      fail(dispatched ? 'account_mode_submission_unknown' : 'account_mode_not_dispatched');
    }
  }
  /** Takes `weight` from this client's Hyperliquid budget, before any
   * evidence clock starts (`HyperliquidBudgetWait` when it isn't available
   * within `maxWaitMs`). A preflight pays for all of its reads at once. */
  async reserve(weight: number, options: LiveReserveOptions = {}): Promise<void> {
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 1200) fail('account_mode_invalid_client');
    await this.budget(weight, options);
  }
  /** Read-only recovery intentionally permits an expired original consent.
   * Its weight is paid before its 5 s clock starts: by the caller
   * (`prepaid`), or here. The four reads are one charge of the shared meter,
   * sent together; the clock starts as they go out, after every wait. */
  async observe(rawIntent: AccountModeIntent, options: AccountModeObserveOptions = {}): Promise<Readonly<AccountModeObservation>> {
    const trace: string[] = [];
    try {
      const intent = capture(rawIntent), { signal } = options;
      const t0 = this.now();
      const budgetWaitMs = options.maxWaitMs ?? LIVE_RESERVE_WAIT_MS;
      // The budget bounds its own wait; this bounds a budget that doesn't.
      if (!options.prepaid) await boundedLiveRead(() => this.budget(ACCOUNT_MODE_OBSERVE_WEIGHT, { signal, maxWaitMs: budgetWaitMs }), budgetWaitMs + 2_000);
      trace.push(`budget ${this.now() - t0}ms`);
      const bodies = (['userRole', 'userAbstraction', 'userDexAbstraction', 'spotClearinghouseState'] as const).map(type => ({ type, user: intent.accountAddress }));
      let started = 0;
      const startClock = () => { signal?.throwIfAborted(); started = this.now(); validTime(started); return AbortSignal.timeout(5000); };
      const meterWaitMs = options.meterWaitMs ?? (options.prepaid ? 0 : LIVE_RESERVE_WAIT_MS);
      const t1 = this.now();
      const global = this.global;
      const responses = await boundedLiveRead(() => global
        ? global.fetchInfoBatch(WALLET_NETWORKS[intent.network].infoUrl, bodies, { maxWaitMs: meterWaitMs, signal, onDispatch: startClock })
        : (() => { const bound = startClock(); return Promise.all(bodies.map(body => this.fetcher(WALLET_NETWORKS[intent.network].infoUrl, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: bound }))); })(), meterWaitMs + 5000);
      const remaining = () => { fresh(started, this.now()); return Math.max(1, 5000 - (this.now() - started)); };
      trace.push(`meter ${started - t1}ms`, `fetch ${this.now() - started}ms ${responses.map(r => r.status).join('/')}`);
      const evidence = await Promise.all(responses.map(async (response, i) => {
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
        const value = await boundedLiveRead(() => readInfoJson(response, 'account mode evidence', 2 * 1024 * 1024), remaining);
        fresh(started, this.now());
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (row.user !== undefined && (typeof row.user !== 'string' || row.user.toLowerCase() !== intent.accountAddress) ||
              row.network !== undefined && row.network !== intent.network) throw new Error();
        }
        return { body: bodies[i]!, value };
      }));
      const role = roleSchema.parse(evidence[0]!.value).role, abstraction = abstractionSchema.parse(evidence[1]!.value);
      const dexAbstraction = z.boolean().nullable().parse(evidence[2]!.value), spot = spotSchema.parse(evidence[3]!.value);
      if (new Set(spot.balances.map(b => b.token)).size !== spot.balances.length || new Set(spot.balances.map(b => b.coin)).size !== spot.balances.length ||
          spot.balances.some(b => Dec.from(b.hold).gt(b.total))) throw new Error();
      const portfolioMarginEnabled = spot.portfolioMarginEnabled ?? false;
      let status: AccountModeObservation['status'] = 'confirmed', issue: string | null = null;
      if (role !== 'user') { status = 'unsupported'; issue = 'account_mode_unsupported_role'; }
      else if (portfolioMarginEnabled || dexAbstraction === true || abstraction === 'unifiedAccount' || abstraction === 'portfolioMargin') {
        status = 'unsupported'; issue = 'account_mode_unsupported_abstraction';
      } else if (abstraction !== 'disabled') { status = 'unproven'; issue = 'account_mode_standard_unproven'; }
      else if (dexAbstraction !== false) { status = 'unproven'; issue = 'account_mode_legacy_state_unproven'; }
      const completedAt = this.now(); fresh(started, completedAt);
      const sourceDigest = `0x${createHash('sha256').update(JSON.stringify({ network: intent.network, user: intent.accountAddress, evidence, started, completedAt })).digest('hex')}` as const;
      return frozen({ network: intent.network, accountAddress: intent.accountAddress, role, abstraction, dexAbstraction, portfolioMarginEnabled,
        earliestObservedAt: started, completedAt, source: WALLET_NETWORKS[intent.network].infoUrl, sourceDigest, status, issue });
    } catch (error) {
      // Which read or check failed, without request bodies or responses.
      const reason = error instanceof Error ? `${error.name}${error.message ? `: ${error.message.slice(0, 160)}` : ''}` : 'unknown';
      observationLogger.warn(`Account mode observation unavailable (${reason}) [${trace.join('; ')}]`);
      // Nothing was observed because the weight isn't there yet: say when.
      const wait = sharedCapacityWait(error);
      if (wait) throw wait;
      fail('account_mode_observation_unavailable');
    }
  }
}

const observationLogger = new Logger('PrivyAccountModeClient');
