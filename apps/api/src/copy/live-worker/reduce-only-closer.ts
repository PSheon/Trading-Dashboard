import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { Pool } from 'pg';
import { AppConfig } from '../../config/app-config.js';
import { Dec } from '../../common/decimal/dec.js';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import type { UnitOfWork } from '../../db/unit-of-work.js';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { RequestBudgeterService } from '../../hyperliquid/request-budgeter.service.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { roundPx, slippedPx } from '../copy-math.js';
import { HyperliquidAgentApprovalVerifier } from '../live/hyperliquid-agent-approval.js';
import { HyperliquidLiveAccountObserver, type LiveAccountSnapshot } from '../live/live-account-observer.js';
import { HyperliquidAllDexsAccountSource } from '../live/live-account-ws-source.js';
import type { LiveExecutionGate, LiveExecutionPermit } from '../live/live-execution-gate.js';
import { LiveOrderExecutor, type LiveExecutionRecord } from '../live/live-execution.js';
import { boundedLiveRead, HyperliquidLiveMarketResolver } from '../live/live-market-resolver.js';
import type { LiveOrderIntent } from '../live/live-order.js';
import { HyperliquidLiveTransport } from '../live/hyperliquid-live-transport.js';
import { PostgresLiveExecutionJournal } from '../live/postgres-live-journal.js';
import { PostgresWalletAuthorizationSource, type GrantPurpose } from '../live/postgres-wallet-authorizations.js';
import { BoundaryPrivyOrderSigningClient } from '../live/privy-order-client.js';
import { PrivyOrderSigner } from '../live/privy-order-signer.js';
import { address, LiveBoundaryError, WalletAuthorizationService } from '../live/wallet-authorization.js';

/** A close must reduce the observed position: opposite side, no larger
 * than it (never open, enlarge or flip). */
export function assertCloseWithinPosition(intent: Pick<LiveOrderIntent, 'side' | 'size'>, position: { size: string } | undefined): void {
  const size = Dec.from(position?.size ?? '0');
  if (size.isZero || (size.isPositive ? intent.side !== 'A' : intent.side !== 'B') || Dec.from(intent.size).gt(size.abs()))
    throw new LiveBoundaryError('close_exceeds_position');
}

/** The account's current trading grant: the agent the owner approved. */
export interface CloseAccount {
  readonly userId: number; readonly strategyId: number; readonly accountId: string; readonly accountAddress: string;
  readonly authorizationId: string; readonly walletId: string; readonly workerQuorumId: string;
}
export interface CloseRequest {
  readonly account: CloseAccount;
  readonly coin: string;
  /** Stable identity of this close attempt (e.g. `stop:<id>:<coin>:<n>`); its
   * hash is the order's cloid, so a retry never makes a second order. */
  readonly seed: string;
  /** Rechecked at both boundaries: the stop/close request is still current. */
  readonly stillWanted: () => Promise<boolean>;
}
export const closeCloid = (seed: string): `0x${string}` => `0x${createHash('sha256').update(JSON.stringify(['live-close-v1', seed])).digest('hex').slice(0, 32)}`;
const SNAPSHOT_MAX_AGE_MS = 4000;

/**
 * Reduce-only IOC closes on the dedicated testnet account, for a stop and a
 * single-position close. Signed by the owner-approved agent (grant scope
 * copy:reduce) through Codex's executor, journal, Privy signer and exchange
 * transport. The gate admits only a reduce-only IOC no larger than the
 * position a fresh account observation shows, while the request is wanted.
 * It can never open, enlarge or flip a position, and never transfers funds.
 */
export class TestnetReduceOnlyCloser {
  private snapshot: { at: number; value: LiveAccountSnapshot } | null = null;
  constructor(private readonly pool: Pool, private readonly db: DrizzleDb, private readonly uow: UnitOfWork, private readonly config: AppConfig,
    private readonly global: HyperliquidGlobalTransport, private readonly budget: RequestBudgeterService, private readonly slippageBps: number,
    private readonly now = Date.now) {}
  private acquire = (weight: number) => this.budget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) });

  /** A fresh all-venue observation of the account (positions and orders). */
  async observe(accountAddress: string): Promise<LiveAccountSnapshot> {
    const sockets = new HyperliquidAllDexsAccountSource(this.now, undefined, 'testnet', this.global);
    try {
      const value = await new HyperliquidLiveAccountObserver('testnet', this.acquire, this.global.fetchInfo, this.now, 5000, sockets).observe(accountAddress);
      this.snapshot = { at: this.now(), value };
      return value;
    } finally { await sockets.close(); }
  }

  private executor(account: CloseAccount, stillWanted: () => Promise<boolean>, purpose?: GrantPurpose) {
    const { auth, copy } = this.config.value;
    if (!auth.appId || !auth.appSecret || !copy.agent || copy.agent.workerQuorumId !== account.workerQuorumId) throw new LiveBoundaryError('close_signing_configuration');
    const agent = copy.agent;
    const authorizations = new WalletAuthorizationService(PostgresWalletAuthorizationSource.forPurpose(this.db, purpose),
      new HyperliquidAgentApprovalVerifier('testnet', this.acquire, this.global.fetchInfo, this.now), this.now);
    const gate: LiveExecutionGate = { assertReady: async ({ phase, intent, record }) => {
      if (!intent.reduceOnly || intent.timeInForce !== 'Ioc' || intent.network !== 'testnet' || address(intent.accountAddress) !== address(account.accountAddress))
        throw new LiveBoundaryError('close_gate_not_reduce_only');
      if (!await stillWanted()) throw new LiveBoundaryError('close_no_longer_requested');
      const held = this.snapshot && this.now() - this.snapshot.at <= SNAPSHOT_MAX_AGE_MS && this.snapshot.value.accountAddress === address(account.accountAddress)
        ? this.snapshot : { at: this.now(), value: await this.observe(account.accountAddress) };
      const position = held.value.positions.find(p => p.coin === intent.market?.coin);
      assertCloseWithinPosition(intent, position);
      const observedAt = held.at;
      const permit: LiveExecutionPermit = { phase, key: record.key, fingerprint: record.fingerprint, assertFresh: () => {
        const now = this.now();
        if (!Number.isSafeInteger(now) || now - observedAt > 5000) throw new LiveBoundaryError('close_evidence_expired');
      } };
      return permit;
    } };
    const signingClient = new BoundaryPrivyOrderSigningClient({ appId: auth.appId, appSecret: auth.appSecret }, fetch, this.now);
    const signer = new PrivyOrderSigner(signingClient, authorizations, async () => {
      this.signingKey(agent.authorizationPrivateKey, agent.authorizationPublicKey);
      return { authorization_context: { authorization_private_keys: [agent.authorizationPrivateKey] } };
    }, gate, this.now);
    const resolver = new HyperliquidLiveMarketResolver('testnet', this.acquire, this.global.fetchInfo, this.now);
    const transport = new HyperliquidLiveTransport('testnet', signer, gate, fetch, 5000, this.now, { marketResolver: resolver, acquire: this.acquire, globalTransport: this.global });
    const journal = new PostgresLiveExecutionJournal(this.db, this.pool, this.uow);
    return { executor: new LiveOrderExecutor(authorizations, journal, transport, gate, this.now), resolver, journal };
  }

  /** Reconciles an order of this account from the exchange (read only). */
  async reconcile(account: CloseAccount, key: string): Promise<LiveExecutionRecord> {
    return this.executor(account, async () => false).executor.reconcile(key);
  }

  /** Places (or reconciles) the one reduce-only IOC for `request.coin`.
   * Null when the account holds no position in it. */
  async close(request: CloseRequest): Promise<LiveExecutionRecord | null> {
    const { account } = request, cloid = closeCloid(request.seed), key = `testnet:${address(account.accountAddress)}:${cloid}`;
    // A stop's close (seed stop:…) may use a grant whose revocation was
    // requested; a single-position close may not.
    const { executor, resolver, journal } = this.executor(account, request.stillWanted, request.seed.startsWith('stop:') ? 'stop' : undefined);
    const existing = await journal.get(key);
    if (existing) return ['submitting', 'unknown', 'resting'].includes(existing.state) ? executor.reconcile(key) : existing;
    // The caller's observation of a moment ago (same pass) is reused: every
    // observation weighs about 350 of the testnet minute's 1200.
    const held = this.snapshot && this.now() - this.snapshot.at <= SNAPSHOT_MAX_AGE_MS && this.snapshot.value.accountAddress === address(account.accountAddress) ? this.snapshot.value : null;
    const snapshot = held ?? await this.observe(account.accountAddress);
    const position = snapshot.positions.find(p => p.coin === request.coin);
    if (!position || Dec.from(position.size).isZero) return null;
    const market = await resolver.resolve(request.coin);
    if (market.asset !== position.asset || market.sizeDecimals !== position.sizeDecimals) throw new LiveBoundaryError('close_market_identity_mismatch');
    const mid = await this.mid(market.coin, market.dex);
    const side = Dec.from(position.size).isPositive ? 'A' as const : 'B' as const;
    const limit = roundPx(slippedPx(mid, side, this.slippageBps), market.sizeDecimals);
    if (!limit.isPositive) throw new LiveBoundaryError('close_price_unavailable');
    const intent: LiveOrderIntent = { authorizationId: account.authorizationId, userId: account.userId, strategyId: account.strategyId, walletId: account.walletId,
      network: 'testnet', accountAddress: address(account.accountAddress), cloid, asset: market.asset, side, size: Dec.from(position.size).abs().toString(),
      limitPrice: limit.toString(), sizeDecimals: market.sizeDecimals, timeInForce: 'Ioc', reduceOnly: true, market };
    return executor.execute(intent);
  }

  private async mid(coin: string, dex: string): Promise<Dec> {
    await boundedLiveRead(this.acquire(2), 5000);
    const response = await boundedLiveRead(this.global.fetchInfo('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dex ? { type: 'allMids', dex } : { type: 'allMids' }), redirect: 'error', signal: AbortSignal.timeout(5000) }), 5000);
    if (!response.ok) throw new LiveBoundaryError('close_price_unavailable');
    const mids = await boundedLiveRead(readInfoJson(response, 'testnet mids', 2 * 1024 * 1024), 5000) as Record<string, unknown>;
    const value = typeof mids?.[coin] === 'string' ? Dec.parse(mids[coin] as string) : null;
    if (!value?.isPositive) throw new LiveBoundaryError('close_price_unavailable');
    return value;
  }

  private signingKey(privateKey: string, publicKey: string): void {
    try {
      const bytes = Buffer.from(privateKey, 'base64'), key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
      if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') !== publicKey) throw new Error();
    } catch { throw new LiveBoundaryError('close_signing_configuration'); }
  }
}
