import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrivyClient } from '@privy-io/node';
import { UserSetAbstractionTypes } from '@nktkas/hyperliquid/api/exchange';
import { WALLET_NETWORKS, splitSignature } from '@trading-dashboard/shared/contracts';
import { verifyTypedData } from 'viem';
import { z } from 'zod';
import { Dec } from '../../common/decimal/dec.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { boundedLiveRead } from './live-market-resolver.js';
import {HyperliquidGlobalTransport} from '../../hyperliquid/hyperliquid-global-transport.js';
import { LiveBoundaryError } from './wallet-authorization.js';

export interface AccountModeIntent {
  readonly operationId: string; readonly accountId: string; readonly strategyId: number;
  readonly network: 'testnet'; readonly accountAddress: string; readonly nonce: number; readonly consentExpiresAt: number;
}
export interface AccountModeOwnedMaster { readonly walletId: string; readonly address: string; readonly ownerQuorumId: string }
export interface AccountModeObservation {
  readonly network: 'testnet'; readonly accountAddress: string;
  readonly role: 'missing' | 'user' | 'agent' | 'vault' | 'subAccount';
  readonly abstraction: 'default' | 'disabled' | 'unifiedAccount' | 'portfolioMargin';
  readonly dexAbstraction: boolean | null; readonly portfolioMarginEnabled: boolean;
  readonly earliestObservedAt: number; readonly completedAt: number;
  readonly source: 'https://api.hyperliquid-testnet.xyz/info'; readonly sourceDigest: `0x${string}`;
  readonly status: 'confirmed' | 'unproven' | 'unsupported'; readonly issue: string | null;
}
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const ethereumAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v)).transform(v => v.toLowerCase());
const intentSchema = z.object({ operationId: identifier, accountId: identifier, strategyId: integer,
  network: z.literal('testnet'), accountAddress: ethereumAddress, nonce: integer, consentExpiresAt: integer }).strict()
  .refine(v => v.consentExpiresAt > v.nonce && v.consentExpiresAt - v.nonce <= 300_000);
const masterSchema = z.object({ walletId: identifier, address: ethereumAddress, ownerQuorumId: identifier }).strict();
const domainFields = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
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
async function readSdkJson(response: Response, remaining: () => number, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > 64 * 1024) throw new Error();
    for (;;) {
      if (signal.aborted) throw new Error();
      const { done, value } = await boundedLiveRead(reader.read(), remaining());
      if (done) break;
      size += value.byteLength; if (size > 64 * 1024) throw new Error(); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', abort);
    await boundedLiveRead(reader.cancel(), 100).catch(() => undefined); reader.releaseLock();
  }
}

/** Current principal action only. No deprecated DEX opt-out or multisig aliases. */
export function accountModeTypedData(raw: AccountModeIntent) {
  const intent = capture(raw);
  return frozen({ domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 421614,
    verifyingContract: '0x0000000000000000000000000000000000000000' as const },
  types, primaryType: 'HyperliquidTransaction:UserSetAbstraction' as const,
  message: { type: 'userSetAbstraction' as const, signatureChainId: '0x66eee' as const, hyperliquidChain: 'Testnet' as const,
    user: intent.accountAddress as `0x${string}`, abstraction: 'disabled' as const, nonce: intent.nonce } });
}

/** One explicitly authorized owner setup action. Durable attempted state and
 * final local ownership/consent gates belong to the caller; this client never
 * retries, retains a JWT, creates a wallet or approves an agent. */
export class PrivyAccountModeClient {
  private readonly credentials: Readonly<{ appId: string; appSecret: string }> | null;
  constructor(config: { appId?: string; appSecret?: string }, private readonly budget: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now,private readonly global?:HyperliquidGlobalTransport) {
    if(global!==undefined&&!(global instanceof HyperliquidGlobalTransport))fail('account_mode_invalid_client');
    if (typeof budget !== 'function' || typeof fetcher !== 'function' || typeof now !== 'function') fail('account_mode_invalid_client');
    this.credentials = config.appId && config.appSecret ? Object.freeze({ appId: config.appId, appSecret: config.appSecret }) : null;
  }
  get available(): boolean { return this.credentials !== null; }
  /** Caller reserves weight exactly once before its durable attempt/POST. */
  async acquire(): Promise<void> {
    try { await boundedLiveRead(this.budget(1), 5000); } catch { fail('account_mode_budget_unavailable'); }
  }
  async signMaster(rawMaster: AccountModeOwnedMaster, rawIntent: AccountModeIntent, userJwt: string, assertFreshProof?: () => void): Promise<string> {
    const controller = new AbortController(); let timer: NodeJS.Timeout | undefined;
    try {
      if (this.global && typeof assertFreshProof !== 'function') throw new Error();
      const intent = capture(rawIntent), master = frozen(masterSchema.parse(structuredClone(rawMaster)));
      const data = accountModeTypedData(intent), started = this.now();
      live(intent, started);
      if (!this.credentials || typeof userJwt !== 'string' || !userJwt.trim() || userJwt.length > 32_768 || master.address !== intent.accountAddress) throw new Error();
      const deadline = Math.min(started + 5000, intent.consentExpiresAt);
      timer = setTimeout(() => controller.abort(), deadline - started); timer.unref();
      const remaining = () => { const now = this.now(); live(intent, now);
        if (now < started || now >= deadline || controller.signal.aborted) throw new Error(); return deadline - now; };
      let verifiedIdentity = false, rpcSubmitted = false;
      const walletPath = `/v1/wallets/${encodeURIComponent(master.walletId)}`;
      const rpcPath = `/v1/wallets/${encodeURIComponent(master.walletId)}/rpc`;
      const sdkFetch: typeof fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (url.origin !== 'https://api.privy.io' || url.search || url.hash ||
            !(url.pathname === walletPath && method === 'GET' || url.pathname === '/v1/wallets/authenticate' && method === 'POST' || url.pathname === rpcPath && method === 'POST')) throw new Error();
        remaining();
        // SDK JWT authorization awaits HPKE exchange internally. Recheck at
        // the actual RPC boundary, after that wait, before invoking transport.
        if (url.pathname === rpcPath) {
          live(intent, this.now()); fresh(started, this.now());
          if (!verifiedIdentity || rpcSubmitted) throw new Error();
          synchronousProof(assertFreshProof);
          live(intent, this.now()); fresh(started, this.now()); remaining(); rpcSubmitted = true;
        }
        const work = this.fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
        return (async () => {
          const response = await boundedLiveRead(work, remaining());
          const value = await readSdkJson(response, remaining, controller.signal);
          return Response.json(value, { status: response.status, headers: response.headers });
        })();
      };
      // Exchanged authorization keys remain scoped to this invocation.
      const client = new PrivyClient({ ...this.credentials, timeout: Math.min(10_000, remaining()), maxRetries: 0, fetch: sdkFetch, logLevel: 'off' });
      const wallet = await boundedLiveRead(client.wallets().get(master.walletId), remaining());
      if (wallet.id !== master.walletId || wallet.chain_type !== 'ethereum' || typeof wallet.address !== 'string' ||
          wallet.address.toLowerCase() !== master.address || wallet.owner_id !== master.ownerQuorumId || wallet.archived_at !== null) throw new Error();
      verifiedIdentity = true;
      live(intent, this.now()); fresh(started, this.now());
      const result = await boundedLiveRead(client.wallets().ethereum().signTypedData(master.walletId, {
        address: master.address, authorization_context: { user_jwts: [userJwt] }, request_expiry: intent.consentExpiresAt,
        params: { typed_data: { domain: data.domain, types: { ...data.types, EIP712Domain: domainFields }, primary_type: data.primaryType, message: data.message } },
      }), remaining());
      live(intent, this.now()); fresh(started, this.now());
      if (result.encoding !== 'hex') throw new Error(); validSignature(result.signature);
      if (!await verifyTypedData({ address: master.address as `0x${string}`, ...data, signature: result.signature as `0x${string}` })) throw new Error();
      live(intent, this.now()); fresh(started, this.now());
      return result.signature;
    } catch { return fail('account_mode_master_signature_unavailable'); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  /** Exactly one POST per call. Caller must persist attempted/unknown first;
   * neither success acknowledgment nor timeout grants authority to resubmit. */
  async send(rawIntent: AccountModeIntent, signature: string, assertFreshProof?: () => void): Promise<unknown> {
    const intent = capture(rawIntent), data = accountModeTypedData(intent);
    live(intent, this.now()); validSignature(signature);
    const body = JSON.stringify({ action: data.message, nonce: intent.nonce, signature: splitSignature(signature) });
    try {
      const started = this.now(), timeout = Math.max(1, Math.min(10_000, intent.consentExpiresAt - started)), deadline = started + timeout;
      const remaining = () => { const now = this.now(); validTime(now); if (now < started || now >= deadline) throw new Error(); return deadline - now; };
      const request: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(timeout) };
      if(this.global&&typeof assertFreshProof!=='function')throw new Error();
      const permit=this.global?await this.global.currentQuota().acquireRest(1,Math.min(this.now()+5000,intent.consentExpiresAt)):undefined;
      live(intent, this.now()); remaining();
      // Complete request construction first, then check captured caller proof.
      // No await or further clock-dependent preparation precedes actual POST.
      const dispatch=()=>{synchronousProof(assertFreshProof);permit?.assertFresh();live(intent,this.now());remaining();return this.fetcher(WALLET_NETWORKS.testnet.exchangeUrl,request);};
      const work=permit?permit.dispatch(dispatch):dispatch();
      const response = await boundedLiveRead(work, remaining());
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
      return frozen(acknowledgment.parse(await boundedLiveRead(readInfoJson(response, 'account mode acknowledgment', 64 * 1024), remaining())));
    } catch { fail('account_mode_submission_unknown'); }
  }
  /** Read-only recovery intentionally permits an expired original consent. */
  async observe(rawIntent: AccountModeIntent): Promise<Readonly<AccountModeObservation>> {
    try {
      const intent = capture(rawIntent), started = this.now(); validTime(started);
      const remaining = () => { fresh(started, this.now()); return Math.max(1, 5000 - (this.now() - started)); };
      const read = async (type: string, weight: number) => {
        const body = { type, user: intent.accountAddress };
        await boundedLiveRead(this.budget(weight), remaining());
        const response = await boundedLiveRead((this.global?.fetchInfo??this.fetcher)(WALLET_NETWORKS.testnet.infoUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(remaining()) }), remaining());
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
        const value = await boundedLiveRead(readInfoJson(response, 'account mode evidence', 2 * 1024 * 1024), remaining());
        fresh(started, this.now());
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (row.user !== undefined && (typeof row.user !== 'string' || row.user.toLowerCase() !== intent.accountAddress) ||
              row.network !== undefined && row.network !== 'testnet') throw new Error();
        }
        return { body, value };
      };
      const evidence = await Promise.all([read('userRole', 60), read('userAbstraction', 20), read('userDexAbstraction', 20), read('spotClearinghouseState', 2)]);
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
      const sourceDigest = `0x${createHash('sha256').update(JSON.stringify({ network: 'testnet', user: intent.accountAddress, evidence, started, completedAt })).digest('hex')}` as const;
      return frozen({ network: 'testnet', accountAddress: intent.accountAddress, role, abstraction, dexAbstraction, portfolioMarginEnabled,
        earliestObservedAt: started, completedAt, source: 'https://api.hyperliquid-testnet.xyz/info', sourceDigest, status, issue });
    } catch (error) {
      // Which read or check failed, without request bodies or responses.
      const reason = error instanceof Error ? `${error.name}${error.message ? `: ${error.message.slice(0, 160)}` : ''}` : 'unknown';
      observationLogger.warn(`Account mode observation unavailable (${reason})`);
      fail('account_mode_observation_unavailable');
    }
  }
}

const observationLogger = new Logger('PrivyAccountModeClient');
