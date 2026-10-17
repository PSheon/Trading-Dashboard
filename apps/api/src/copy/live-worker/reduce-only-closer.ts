import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { Pool } from 'pg';
import { WALLET_NETWORKS, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../../config/app-config.js';
import { Dec } from '../../common/decimal/dec.js';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import type { UnitOfWork } from '../../db/unit-of-work.js';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { runAsDefaultRestOwner } from '../../hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../../hyperliquid/request-budgeter.service.js';

/** The owner of a close's charges outside a stop (a manual close, a reconcile): `live:close:`. */
const CLOSE_OWNER = 'close';
import { reserveLive } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { roundPx, slippedPx } from '../copy-math.js';
import { HyperliquidAgentApprovalVerifier } from '../live/hyperliquid-agent-approval.js';
import { HyperliquidLiveAccountObserver, observerRestWeight, type LiveAccountSnapshot } from '../live/live-account-observer.js';
import { HyperliquidAllDexsAccountSource, PerReadAllDexsAccountSource } from '../live/live-account-ws-source.js';
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
import { liveReadCache } from '../live/live-read-cache.js';
import { liveEvidenceMaxAgeMs, liveSnapshotMaxAgeMs } from '../../config/live-evidence-window.js';

/** A close must reduce the observed position: opposite side, no larger (never open, enlarge or flip). */
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
  /** Stable attempt identity (e.g. `stop:<id>:<coin>:<n>`) hashed into the cloid: a retry never makes a second order. */
  readonly seed: string;
  /** Rechecked at both boundaries: the request is still current. */
  readonly stillWanted: () => Promise<boolean>;
  /** 0-based attempt; each retry's limit is wider (closeSlippageBps). */
  readonly attempt?: number;
}
/** A close journaled but never sent (see ReduceOnlyCloser.neverSent). */
export const CLOSE_NEVER_SENT = 'close_never_sent';
export const closeCloid = (seed: string): `0x${string}` => `0x${createHash('sha256').update(JSON.stringify(['live-close-v1', seed])).digest('hex').slice(0, 32)}`;
/** Widest retried close limit from the mid (5 %), unless the configured slippage is wider. */
const MAX_CLOSE_SLIPPAGE_BPS = 500;
/** Attempt n's slippage: base × (1 + n/2), capped at MAX_CLOSE_SLIPPAGE_BPS. */
export function closeSlippageBps(baseBps: number, attempt = 0): number {
  const n = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
  return Math.max(baseBps, Math.min(MAX_CLOSE_SLIPPAGE_BPS, Math.round(baseBps * (1 + n / 2))));
}
/** Back-off before attempt n: none for the first retry, then 5 s doubling to 5 min. */
export function closeRetryDelayMs(attempt: number): number {
  return attempt <= 1 ? 0 : Math.min(300_000, 5000 * 2 ** Math.min(attempt - 2, 10));
}

/**
 * Reduce-only IOC closes on a copy account (stops and single-position closes),
 * signed by the owner-approved agent (scope copy:reduce). The gate admits only a
 * reduce-only IOC within a fresh observed position while the request is wanted:
 * it can never open, enlarge or flip a position, nor transfer funds.
 */
export class ReduceOnlyCloser {
  private snapshot: { at: number; value: LiveAccountSnapshot } | null = null;
  constructor(readonly network: HyperliquidNetwork, private readonly pool: Pool, private readonly db: DrizzleDb, private readonly uow: UnitOfWork, private readonly config: AppConfig,
    private readonly global: HyperliquidGlobalTransport, private readonly budget: RequestBudgeterService, private readonly slippageBps: number,
    private readonly now = Date.now) {}
  private acquire = (weight: number) => reserveLive(this.budget, weight, { maxWaitMs: 5000 });

  /** Reserve before evidence clocks start; only unspent local credit is refunded. */
  private async prepaid<T>(weight: number, work: (acquire: (weight: number) => Promise<void>) => Promise<T>): Promise<T> {
    await reserveLive(this.budget, weight, { maxWaitMs: Math.min(180_000, this.budget.refillMs()) });
    let credit = weight;
    const acquire = async (wanted: number) => {
      const paid = Math.min(credit, wanted); credit -= paid;
      try { if (wanted > paid) await this.acquire(wanted - paid); }
      catch (error) { credit += paid; throw error; }
    };
    try { return await work(acquire); }
    finally { if (credit > 0) this.budget.adjust(-credit); }
  }

  /** A fresh all-venue observation of the account (positions and orders). */
  async observe(accountAddress: string): Promise<LiveAccountSnapshot> {
    return runAsDefaultRestOwner(CLOSE_OWNER, () => this.prepaid(observerRestWeight(accountAddress, liveReadCache(this.network)), acquire => this.readObservation(accountAddress, acquire)));
  }

  private async readObservation(accountAddress: string, acquire: (weight: number) => Promise<void>): Promise<LiveAccountSnapshot> {
    const sockets = new PerReadAllDexsAccountSource(() => new HyperliquidAllDexsAccountSource(this.now, undefined, this.network, this.global, { closeAfterRead: true }), 2);
    try {
      const value = await new HyperliquidLiveAccountObserver(this.network, acquire, this.global.fetchInfo, this.now, liveEvidenceMaxAgeMs(this.network), sockets, undefined, liveReadCache(this.network)).observe(accountAddress);
      this.snapshot = { at: this.now(), value };
      return value;
    } finally { await sockets.close(); }
  }

  private executor(account: CloseAccount, stillWanted: () => Promise<boolean>, purpose?: GrantPurpose, acquire = this.acquire) {
    const { auth, copy } = this.config.value;
    if (!auth.appId || !auth.appSecret || !copy.agent || copy.agent.workerQuorumId !== account.workerQuorumId) throw new LiveBoundaryError('close_signing_configuration');
    const agent = copy.agent;
    const authorizations = new WalletAuthorizationService(PostgresWalletAuthorizationSource.forPurpose(this.db, purpose),
      new HyperliquidAgentApprovalVerifier(this.network, acquire, this.global.fetchInfo, this.now), this.now);
    const gate: LiveExecutionGate = { assertReady: async ({ phase, intent, record }) => {
      if (!intent.reduceOnly || intent.timeInForce !== 'Ioc' || intent.network !== this.network || address(intent.accountAddress) !== address(account.accountAddress))
        throw new LiveBoundaryError('close_gate_not_reduce_only');
      if (!await stillWanted()) throw new LiveBoundaryError('close_no_longer_requested');
      const held = this.snapshot && this.now() - this.snapshot.at <= liveSnapshotMaxAgeMs(this.network) && this.snapshot.value.accountAddress === address(account.accountAddress)
        ? this.snapshot : { at: this.now(), value: await this.readObservation(account.accountAddress, acquire) };
      const position = held.value.positions.find(p => p.coin === intent.market?.coin);
      assertCloseWithinPosition(intent, position);
      const observedAt = held.at;
      const permit: LiveExecutionPermit = { phase, key: record.key, fingerprint: record.fingerprint, assertFresh: () => {
        const now = this.now();
        if (!Number.isSafeInteger(now) || now - observedAt > liveEvidenceMaxAgeMs(this.network)) throw new LiveBoundaryError('close_evidence_expired');
      } };
      return permit;
    } };
    const signingClient = new BoundaryPrivyOrderSigningClient(this.network, { appId: auth.appId, appSecret: auth.appSecret }, fetch, this.now);
    const signer = new PrivyOrderSigner(signingClient, authorizations, async () => {
      this.signingKey(agent.authorizationPrivateKey, agent.authorizationPublicKey);
      return { authorization_context: { authorization_private_keys: [agent.authorizationPrivateKey] } };
    }, gate, this.now);
    const resolver = new HyperliquidLiveMarketResolver(this.network, acquire, this.global.fetchInfo, this.now);
    const transport = new HyperliquidLiveTransport(this.network, signer, gate, fetch, 5000, this.now, { marketResolver: resolver, acquire, globalTransport: this.global });
    const journal = new PostgresLiveExecutionJournal(this.db, this.pool, this.uow);
    return { executor: new LiveOrderExecutor(authorizations, journal, transport, gate, this.now), resolver, journal };
  }

  /** Reconciles an order of this account from the exchange (read only). */
  async reconcile(account: CloseAccount, key: string): Promise<LiveExecutionRecord> {
    return runAsDefaultRestOwner(CLOSE_OWNER, () => this.executor(account, async () => false).executor.reconcile(key));
  }

  /** Finishes a close a stop took over: prepared ends unsent, in flight is reconciled (read only). */
  async settle(account: CloseAccount, key: string): Promise<LiveExecutionRecord | null> {
    return runAsDefaultRestOwner('stop', async () => {
      const { executor, journal } = this.executor(account, async () => false, 'stop');
      const record = await journal.get(key);
      if (record?.state === 'prepared') return this.neverSent(journal, key);
      return record && ['submitting', 'unknown', 'resting'].includes(record.state) ? executor.reconcile(key) : record;
    });
  }

  /** Places (or reconciles) the reduce-only IOC for `request.coin`; null when there is no position.
   * Its charges on the shared meter are the stop's (`live:stop:`) or the close's (`live:close:`),
   * unless the work it runs in (a stop's pass) has an owner already. */
  async close(request: CloseRequest): Promise<LiveExecutionRecord | null> {
    return runAsDefaultRestOwner(request.seed.startsWith('stop:') ? 'stop' : CLOSE_OWNER, () => this.place(request));
  }

  private async place(request: CloseRequest): Promise<LiveExecutionRecord | null> {
    const { account } = request, cloid = closeCloid(request.seed), key = `${this.network}:${address(account.accountAddress)}:${cloid}`;
    // Only a stop's close may use a grant whose revocation was requested.
    const purpose = request.seed.startsWith('stop:') ? 'stop' : undefined;
    const { executor, journal } = this.executor(account, request.stillWanted, purpose);
    const existing = await journal.get(key);
    if (existing) {
      // Left prepared by a failed pass: never sent, so end it here (else it
      // wedges the stop); the next attempt is a fresh close.
      if (existing.state === 'prepared') return this.neverSent(journal, key);
      return ['submitting', 'unknown', 'resting'].includes(existing.state) ? executor.reconcile(key) : existing;
    }
    // Upper bound: observation, 4 market reads (40 for a named venue), 4 approval
    // reads, mids, one POST. Grants no authority; boundaries still validate.
    return this.prepaid(observerRestWeight(account.accountAddress, liveReadCache(this.network)) + 4 * 40 + 4 * 20 + 3, async acquire => {
      const { executor, resolver } = this.executor(account, request.stillWanted, purpose, acquire);
      // Reuse the caller's observation only if still fresh after the quota wait.
      const held = this.snapshot && this.now() - this.snapshot.at <= liveSnapshotMaxAgeMs(this.network) && this.snapshot.value.accountAddress === address(account.accountAddress) ? this.snapshot.value : null;
      const snapshot = held ?? await this.readObservation(account.accountAddress, acquire);
      const position = snapshot.positions.find(p => p.coin === request.coin);
      if (!position || Dec.from(position.size).isZero) return null;
      const market = await resolver.resolve(request.coin);
      if (market.asset !== position.asset || market.sizeDecimals !== position.sizeDecimals) throw new LiveBoundaryError('close_market_identity_mismatch');
      const mid = await this.mid(market.coin, market.dex, acquire);
      const side = Dec.from(position.size).isPositive ? 'A' as const : 'B' as const;
      const limit = roundPx(slippedPx(mid, side, closeSlippageBps(this.slippageBps, request.attempt)), market.sizeDecimals);
      if (!limit.isPositive) throw new LiveBoundaryError('close_price_unavailable');
      const intent: LiveOrderIntent = { authorizationId: account.authorizationId, userId: account.userId, strategyId: account.strategyId, walletId: account.walletId,
        network: this.network, accountAddress: address(account.accountAddress), cloid, asset: market.asset, side, size: Dec.from(position.size).abs().toString(),
        limitPrice: limit.toString(), sizeDecimals: market.sizeDecimals, timeInForce: 'Ioc', reduceOnly: true, market };
      try { return await executor.execute(intent); }
      catch (error) {
        // End a still-prepared order now (best effort), so the stop shows this error.
        await this.neverSent(journal, key).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Under the order lock a `prepared` close was provably never sent (`submitting`
   * is recorded before the POST): it becomes a terminal CLOSE_NEVER_SENT
   * rejection. Any other state is returned unchanged.
   */
  private async neverSent(journal: PostgresLiveExecutionJournal, key: string): Promise<LiveExecutionRecord | null> {
    return journal.withOrderLock(key, async lease => {
      const record = await journal.get(key);
      if (record?.state !== 'prepared') return record;
      await lease.assertHeld();
      const ended: LiveExecutionRecord = { ...record, state: 'rejected', errorCode: CLOSE_NEVER_SENT, outcome: { state: 'rejected', reason: CLOSE_NEVER_SENT },
        updatedAt: Math.max(this.now(), record.updatedAt) };
      await journal.save(ended);
      return ended;
    });
  }

  private async mid(coin: string, dex: string, acquire: (weight: number) => Promise<void>): Promise<Dec> {
    await boundedLiveRead(() => acquire(2), 5000);
    const response = await boundedLiveRead(() => this.global.fetchInfo(WALLET_NETWORKS[this.network].infoUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dex ? { type: 'allMids', dex } : { type: 'allMids' }), redirect: 'error', signal: AbortSignal.timeout(5000) }), 5000);
    if (!response.ok) throw new LiveBoundaryError('close_price_unavailable');
    const mids = await boundedLiveRead(() => readInfoJson(response, `${this.network} mids`, 2 * 1024 * 1024), 5000) as Record<string, unknown>;
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
