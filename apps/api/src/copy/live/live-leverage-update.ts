import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import { verifyTypedData } from 'viem';
import { canonicalize, createL1ActionHash, signL1Action, type AbstractViemLocalAccount } from '@nktkas/hyperliquid/signing';
import { UpdateLeverageRequest } from '@nktkas/hyperliquid/api/exchange';
import { WALLET_NETWORKS, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { copyLiveLeverageUpdates } from '@trading-dashboard/shared/database';
import { allocateSignerNonce } from '../signer-nonce.js';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { boundedLiveRead } from './live-market-resolver.js';
import { PHANTOM_AGENT_SOURCE } from './privy-agent-provisioner.js';
import type { PrivyOrderSigningClient, PrivySigningAuthorization } from './privy-order-signer.js';
import type { LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { address, assertVerifiedAuthorizationFresh, LiveBoundaryError, WalletAuthorizationService, type VerifiedWalletAuthorization, type WalletRequest } from './wallet-authorization.js';

/**
 * The copy account's leverage on the order's coin is above the copy's cap
 * (min of the policy, the copy's settings and the coin's maximum). A fresh
 * Hyperliquid account trades cross at min(20, the coin's maximum), which the
 * order risk gate refuses (live-account-risk.ts). Thrown by the preparation
 * before any journal, nonce or claim, so the runtime can set the leverage
 * (LiveLeverageUpdater) and prepare the order once more.
 */
export class LiveLeverageUpdateRequired extends LiveBoundaryError {
  constructor(readonly coin: string, readonly asset: number, readonly current: number, readonly leverage: number) {
    super('live_leverage_update_required');
  }
}
/** The leverage was set (the exchange acknowledged it): prepare the order again. */
export class LiveLeverageUpdated extends LiveBoundaryError {
  constructor() { super('live_leverage_updated'); }
}

export interface LiveLeverageTarget {
  readonly accountId: string; readonly userId: number; readonly strategyId: number; readonly walletId: string;
  readonly authorizationId: string; readonly accountAddress: string;
  readonly coin: string; readonly asset: number; readonly from: number; readonly leverage: number;
}
export type LiveLeverageUpdateState = 'accepted' | 'rejected' | 'unknown';
/** Exactly the exchange's answer to an accepted updateLeverage. */
const ACCEPTED = { status: 'ok', response: { type: 'default' } };
const domain = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'00'.repeat(20)}` as `0x${string}` };
const agentFields = [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }];
const domainFields = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];

/** The exchange action that sets one coin's cross leverage, in canonical key order. */
export function liveLeverageAction(asset: number, leverage: number) {
  if (!Number.isSafeInteger(asset) || asset < 0 || !Number.isSafeInteger(leverage) || leverage < 1) throw new LiveBoundaryError('live_leverage_invalid');
  return canonicalize(UpdateLeverageRequest.entries.action, { type: 'updateLeverage', asset, isCross: true, leverage });
}

/**
 * Sets a copy account's cross leverage on one coin with the worker's agent,
 * on the same path as an order: the request budget, the signer's shared
 * nonce allocator (copy_signer_nonces, under the order nonce lock), a journal
 * row (copy_live_leverage_updates) committed before signing, the agent's
 * exchange approval and the owner's local grant checked again at the Privy
 * request and the POST, and the shared egress quota. The Privy policy allows
 * it: its rule admits any phantom-agent L1 action on the network
 * (privy-agent-provisioner.ts policyRules). Lowering leverage adds no
 * exposure; nothing here can open, close or move funds.
 */
export class LiveLeverageUpdater {
  constructor(private readonly network: HyperliquidNetwork, private readonly client: PrivyOrderSigningClient,
    private readonly authorizations: WalletAuthorizationService, private readonly signingAuthorization: () => Promise<PrivySigningAuthorization>,
    private readonly global: HyperliquidGlobalTransport, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    if (!(global instanceof HyperliquidGlobalTransport)) throw new LiveBoundaryError('live_leverage_dependencies');
  }

  async update(session: LiveRiskDatabaseSession, supplied: LiveLeverageTarget): Promise<LiveLeverageUpdateState> {
    const target = structuredClone(supplied), accountAddress = address(target.accountAddress);
    const action = liveLeverageAction(target.asset, target.leverage);
    if (!Number.isSafeInteger(target.from) || target.from <= target.leverage) throw new LiveBoundaryError('live_leverage_invalid');
    const request: WalletRequest = { authorizationId: target.authorizationId, userId: target.userId, strategyId: target.strategyId,
      walletId: target.walletId, network: this.network, accountAddress, reduceOnly: false };
    const grant = await this.authorizations.authorizeLocal(request);
    await session.scope.assertHeld();
    const signer = address(grant.signerAddress), id = randomUUID(), created = this.now();
    const checked = async <T>(work: PromiseLike<T>) => { const value = await work; await session.scope.assertHeld(); return value; };
    // Journal and nonce commit together before any signing request.
    const { nonce, expiresAfter } = await session.transaction(async tx => {
      const nonce = await allocateSignerNonce(tx, this.network, signer, created, checked);
      if (!Number.isSafeInteger(nonce) || nonce < created || nonce > created + 30_000) throw new LiveBoundaryError('nonce_clock_skew');
      // From the request's own clock, as an order's (the Privy request expiry
      // must lie within 60 s of the signing request).
      const expiresAfter = created + 60_000;
      await checked(tx.insert(copyLiveLeverageUpdates).values({ id, userId: target.userId, accountId: target.accountId, network: this.network, accountAddress,
        signerAddress: signer, authorizationId: target.authorizationId, coin: target.coin, asset: target.asset, fromLeverage: target.from, leverage: target.leverage,
        nonce, expiresAfter, state: 'prepared', createdAt: new Date(created), updatedAt: new Date(created) }));
      return { nonce, expiresAfter };
    });
    const finish = async (state: LiveLeverageUpdateState | 'submitting', issue: string | null, from: ('prepared' | 'submitting')[]) => {
      const changed = await session.transaction(tx => checked(tx.update(copyLiveLeverageUpdates).set({ state, issue, updatedAt: new Date(this.now()) })
        .where(and(eq(copyLiveLeverageUpdates.id, id), inArray(copyLiveLeverageUpdates.state, from))).returning({ id: copyLiveLeverageUpdates.id })));
      if (changed.length !== 1) throw new LiveBoundaryError('live_leverage_journal_changed');
    };
    let verified: VerifiedWalletAuthorization | undefined, signature: Awaited<ReturnType<typeof signL1Action>>;
    try {
      signature = await signL1Action({ action: { ...action }, nonce, expiresAfter, isTestnet: this.network === 'testnet', wallet: this.wallet(target, request, signer, action, nonce, expiresAfter, v => { verified = v; }) });
    } catch (error) {
      // Nothing was sent: the update is refused, never retried under this nonce.
      await finish('rejected', 'leverage_signing_failed', ['prepared']);
      throw new LiveBoundaryError(error instanceof LiveBoundaryError ? error.code : 'live_leverage_signing_failed');
    }
    await finish('submitting', null, ['prepared']);
    let began = false, state: LiveLeverageUpdateState = 'unknown', issue: string | null = 'leverage_response_ambiguous';
    try {
      const quota = await boundedLiveRead(() => this.global.currentQuota().acquireRest(1, Math.min(this.now() + 5000, expiresAfter)), 5000);
      const timeout = Math.max(1, Math.min(10_000, expiresAfter - this.now()));
      const pending = quota.dispatch(() => {
        quota.assertFresh();
        if (!verified) throw new LiveBoundaryError('exchange_approval_evidence_invalid');
        assertVerifiedAuthorizationFresh(verified, request, this.now());
        if (expiresAfter <= this.now()) throw new LiveBoundaryError('live_leverage_expired');
        began = true;
        return this.fetcher(WALLET_NETWORKS[this.network].exchangeUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, nonce, expiresAfter, signature }), redirect: 'error', signal: AbortSignal.timeout(timeout) });
      });
      const response = await boundedLiveRead(() => pending, timeout);
      if (response.ok) {
        const body = await boundedLiveRead(() => readInfoJson(response, 'live leverage update', 64 * 1024), timeout);
        if (isDeepStrictEqual(body, ACCEPTED)) { state = 'accepted'; issue = null; }
        else if (body && typeof body === 'object' && (body as { status?: unknown }).status === 'err') { state = 'rejected'; issue = 'exchange_rejected_leverage'; }
      }
    } catch {
      // Before the request began nothing reached the exchange.
      if (!began) { state = 'rejected'; issue = 'leverage_not_sent'; }
    }
    await finish(state, issue, ['submitting']);
    return state;
  }

  /** The agent signs this one updateLeverage hash only, after the grant, the
   * exchange approval and the Privy wallet identity are checked again. */
  private wallet(target: LiveLeverageTarget, request: WalletRequest, signer: `0x${string}`, action: ReturnType<typeof liveLeverageAction>,
    nonce: number, expiresAfter: number, onVerified: (verified: VerifiedWalletAuthorization) => void): AbstractViemLocalAccount {
    const hash = createL1ActionHash({ action: { ...action }, nonce, expiresAfter }), source = PHANTOM_AGENT_SOURCE[this.network];
    return { address: signer, signTypedData: async (supplied) => {
      const data = structuredClone(supplied);
      if (!isDeepStrictEqual(data.domain, domain) || data.primaryType !== 'Agent' || !isDeepStrictEqual(data.types, { EIP712Domain: domainFields, Agent: agentFields }) ||
        !isDeepStrictEqual(data.message, { source, connectionId: hash })) throw new LiveBoundaryError('leverage_signer_payload_outside_scope');
      const walletCheckedAt = this.now();
      const wallet = await this.client.getWallet(target.walletId);
      if (wallet.id !== target.walletId || wallet.chain_type !== 'ethereum' || address(wallet.address) !== signer || wallet.archived_at != null)
        throw new LiveBoundaryError('privy_wallet_identity_mismatch');
      const context = await this.signingAuthorization();
      const verified = await this.authorizations.authorizeWithEvidence(request);
      if (address(verified.grant.signerAddress) !== signer || wallet.owner_id !== verified.grant.privyOwnerId) throw new LiveBoundaryError('privy_wallet_identity_mismatch');
      onVerified(verified);
      const guard = () => {
        assertVerifiedAuthorizationFresh(verified, request, this.now());
        const now = this.now();
        if (now < walletCheckedAt || now - walletCheckedAt > 5000) throw new LiveBoundaryError('privy_wallet_identity_stale');
        if (expiresAfter <= now) throw new LiveBoundaryError('live_leverage_expired');
      };
      guard();
      const response = await this.client.signTypedData(target.walletId, { ...context, request_expiry: expiresAfter, address: signer,
        params: { typed_data: { domain, types: { EIP712Domain: domainFields, Agent: agentFields }, primary_type: 'Agent', message: { source, connectionId: hash } } } }, guard);
      if (response.encoding !== 'hex' || !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/.test(response.signature)) throw new LiveBoundaryError('invalid_privy_signature');
      let valid = false;
      try {
        valid = await verifyTypedData({ address: signer, domain, types: { Agent: agentFields }, primaryType: 'Agent',
          message: { source, connectionId: hash }, signature: response.signature as `0x${string}` });
      } catch { /* No signature in errors. */ }
      if (!valid) throw new LiveBoundaryError('privy_signature_scope_mismatch');
      return response.signature as `0x${string}`;
    } };
  }
}
