import { createHash } from 'node:crypto';
import { liveStopCancellationIntentSchema } from '@trading-dashboard/shared/contracts';
import { Pool } from 'pg';
import { Dec } from '../../common/decimal/dec.js';
import { AppConfig } from '../../config/app-config.js';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { RequestBudgeterService } from '../../hyperliquid/request-budgeter.service.js';
import { liveStopCancellationIntentDigest } from '../copy-live-stop-consent.js';
import { HyperliquidAgentApprovalVerifier } from '../live/hyperliquid-agent-approval.js';
import { HyperliquidTrackedCancellationTransport } from '../live/hyperliquid-cancellation-transport.js';
import type { LiveAccountSnapshot } from '../live/live-account-observer.js';
import type { LiveExecutionRecord } from '../live/live-execution.js';
import type { LiveOrderIntent } from '../live/live-order.js';
import { trackedCancellationAction, trackedCancellationFingerprint, type CancellationAuthorization, type PreparedTrackedCancellation,
  type TrackedCancellationAuthority } from '../live/live-tracked-cancellation.js';
import { PostgresLiveRiskScope } from '../live/postgres-live-risk-scope.js';
import { findCurrentWalletAuthorization } from '../live/postgres-wallet-authorizations.js';
import { PrivyTrackedCancellationSigner } from '../live/privy-cancellation-signer.js';
import { BoundaryPrivyOrderSigningClient } from '../live/privy-order-client.js';
import { address, LiveBoundaryError } from '../live/wallet-authorization.js';
import type { CopyLiveStopWorkerRepository, StopRow } from './copy-live-stop-worker.repository.js';
import { closeCloid, type CloseAccount, type TestnetReduceOnlyCloser } from './reduce-only-closer.js';

const MAX_CLOSE_ATTEMPTS = 10, MAX_CANCEL_ATTEMPTS = 3;
const TERMINAL: ReadonlySet<string> = new Set(['filled', 'partial', 'cancelled', 'rejected']);
/** Below this the account holds nothing worth a transfer back (USDC). */
export const SWEEP_DUST_USD = '0.01';
export interface StopperDependencies {
  readonly repository: CopyLiveStopWorkerRepository;
  readonly closer: TestnetReduceOnlyCloser;
  /** Cancels one tracked resting order under the owner's consent. */
  readonly canceller: StopCanceller | null;
  /** True once a transfer back to the owner's main wallet has been credited. */
  readonly swept: (stop: StopRow) => Promise<boolean>;
  readonly log?: (message: string) => void;
  /** A revoke-requested grant is revoked anyway after this long. */
  readonly revokeDeadlineMs?: number;
}
/** Default bound on a pending admin revoke (COPY_LIVE_REVOKE_DEADLINE_MINUTES). */
export const REVOKE_DEADLINE_MS = 30 * 60_000;
const reason = (error: unknown) => (error instanceof LiveBoundaryError ? error.code : 'stop_step_failed').replace(/[^a-z0-9_]/g, '_').slice(0, 80);

/**
 * Executes owner stop requests, resumable at every step because each step's
 * state is the stop row's own (requested → cancelling → closing → flat →
 * stopped) and each order has a fixed identity:
 * 1. wait until no order of the account is in flight (unknown ones are being
 *    reconciled by the engine; a prepared one is harmless once expired);
 * 2. cancel tracked resting orders — needs the owner's signed consent;
 * 3. reduce-only IOC closes of every position, by the approved agent;
 * 4. confirm flat from a fresh account observation (no position, no order),
 *    recorded as the flat certificate;
 * 5. stopped once the account was swept back to the main wallet (or holds
 *    only dust): generations and strategy end, the leader is unwatched.
 */
export class CopyLiveStopper {
  constructor(private readonly deps: StopperDependencies, private readonly now: () => number = Date.now) {}

  async tick(): Promise<void> {
    // A pending admin revoke never outlives its bound: past the deadline, or
    // once the stop it waits for is blocked or gone, the grant is revoked
    // (audited by the system, positions may remain).
    for (const forced of await this.deps.repository.expirePendingRevokes(this.now(), this.deps.revokeDeadlineMs ?? REVOKE_DEADLINE_MS)) {
      this.deps.log?.(`grant ${forced.id} revoked without its stop ending (${forced.reason}); positions may remain on the copy account`);
    }
    for (const stop of await this.deps.repository.open()) {
      try { await this.step(stop); }
      catch (error) { this.deps.log?.(`stop ${stop.id} kept for the next pass: ${reason(error)}`); await this.deps.repository.issue(stop, reason(error)); }
    }
  }

  async step(stop: StopRow): Promise<void> {
    const account = await this.deps.repository.closeAccount(stop);
    if (!account) { await this.deps.repository.issue(stop, 'stop_agent_unavailable'); return; }
    if (stop.state === 'requested') return this.requested(stop);
    if (stop.state === 'cancelling') return this.cancelling(stop, account);
    if (stop.state === 'closing') return this.closing(stop, account);
    if (stop.state === 'flat') return this.flat(stop, account);
  }

  private async requested(stop: StopRow): Promise<void> {
    const inflight = (await this.deps.repository.inflight(stop.accountAddress)).filter(row => !this.expiredPrepared(row.record));
    if (inflight.some(row => row.record.state === 'resting')) { await this.deps.repository.move(stop, 'cancelling', { issue: null }, this.now()); return; }
    if (inflight.length) { await this.deps.repository.issue(stop, 'stop_waiting_for_orders'); return; }
    await this.deps.repository.move(stop, 'closing', { issue: null }, this.now());
  }

  private async cancelling(stop: StopRow, account: CloseAccount): Promise<void> {
    const resting = (await this.deps.repository.inflight(stop.accountAddress)).filter(row => row.record.state === 'resting');
    if (!resting.length) {
      const pending = (await this.deps.repository.inflight(stop.accountAddress)).filter(row => !this.expiredPrepared(row.record));
      if (!pending.length) await this.deps.repository.move(stop, 'closing', { issue: null }, this.now());
      return;
    }
    if (!this.deps.canceller) { await this.deps.repository.issue(stop, 'stop_cancellation_unavailable'); return; }
    for (const target of resting) {
      const outcome = await this.deps.canceller.cancel(stop, account, target);
      if (outcome !== 'attempted' && outcome !== 'waiting') { await this.deps.repository.issue(stop, outcome); return; }
    }
    await this.deps.repository.issue(stop, null);
  }

  private async closing(stop: StopRow, account: CloseAccount): Promise<void> {
    const snapshot = await this.deps.closer.observe(stop.accountAddress);
    const tracked = new Set((await this.deps.repository.inflight(stop.accountAddress)).map(row => row.record.action.orders[0]!.c.toLowerCase()));
    if (snapshot.restingOrders.some(order => !order.cloid || !tracked.has(order.cloid))) { await this.deps.repository.issue(stop, 'stop_untracked_resting_orders'); return; }
    const open = snapshot.positions.filter(position => !Dec.from(position.size).isZero);
    if (!open.length && !snapshot.restingOrders.length) return this.markFlat(stop, snapshot);
    for (const position of open) {
      // One new order per coin per pass: attempt n has a fixed cloid; a
      // terminal attempt that left a remainder moves on to attempt n+1.
      let attempt = 0;
      for (; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        const seed = `stop:${stop.id}:${position.coin}:${attempt}`;
        const state = await this.deps.repository.journalState(`testnet:${address(account.accountAddress)}:${closeCloid(seed)}`);
        if (state !== null && TERMINAL.has(state)) continue;
        await this.deps.closer.close({ account, coin: position.coin, seed, stillWanted: async () => (await this.deps.repository.get(stop.id))?.state === 'closing' });
        break;
      }
      if (attempt >= MAX_CLOSE_ATTEMPTS) { await this.deps.repository.issue(stop, 'stop_close_attempts_exhausted'); return; }
    }
    await this.deps.repository.issue(stop, null);
  }

  private async markFlat(stop: StopRow, snapshot: LiveAccountSnapshot): Promise<void> {
    const { certificate, digest } = this.deps.repository.certificate(snapshot);
    const at = new Date(Math.max(this.now(), stop.updatedAt.getTime()));
    await this.deps.repository.move(stop, 'flat', { flatCertificate: certificate, flatDigest: digest, flatVerifiedAt: at, issue: null }, at.getTime());
  }

  private async flat(stop: StopRow, account: CloseAccount): Promise<void> {
    if (await this.deps.swept(stop)) { await this.deps.repository.finish(stop, this.now()); return; }
    const snapshot = await this.deps.closer.observe(account.accountAddress);
    if (snapshot.positions.some(p => !Dec.from(p.size).isZero) || snapshot.restingOrders.length) {
      await this.deps.repository.issue(stop, 'stop_account_not_flat'); return;
    }
    // Nothing left to return: the stop ends without a transfer.
    if (Dec.from(snapshot.withdrawable).lt(SWEEP_DUST_USD) && Dec.from(snapshot.perpEquity).lt(SWEEP_DUST_USD)) { await this.deps.repository.finish(stop, this.now()); return; }
    await this.deps.repository.issue(stop, 'stop_awaiting_return_to_main_wallet');
  }

  private expiredPrepared(record: LiveExecutionRecord): boolean {
    return record.state === 'prepared' && record.expiresAfter <= this.now();
  }
}

/**
 * Cancels one tracked resting order with Codex's cancellation signer and
 * transport: a cancel by the order's own cloid, signed by the approved agent,
 * only under the owner's verified consent for this stop and its captured
 * revision, while the stop is cancelling and the grant and exchange approval
 * are current. One attempt per claim; an unknown outcome is reconciled from
 * the order's status by the executor before another attempt.
 */
export class StopCanceller {
  constructor(private readonly pool: Pool, private readonly db: DrizzleDb, private readonly config: AppConfig, private readonly global: HyperliquidGlobalTransport,
    private readonly budget: RequestBudgeterService, private readonly repository: CopyLiveStopWorkerRepository,
    private readonly reconcile: (account: CloseAccount, key: string) => Promise<LiveExecutionRecord>, private readonly now = Date.now) {}
  private acquire = (weight: number) => this.budget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) });

  async cancel(stop: StopRow, account: CloseAccount, target: { record: LiveExecutionRecord; intent: LiveOrderIntent | null }): Promise<string> {
    if (!target.intent) return 'stop_cancel_target_unproven';
    const consentRow = await this.repository.consent(stop.id), now = this.now();
    const parsed = consentRow ? liveStopCancellationIntentSchema.safeParse(consentRow.intent) : null;
    if (!consentRow?.consentDigest || !parsed?.success || liveStopCancellationIntentDigest(parsed.data) !== consentRow.intentDigest) return 'stop_cancellation_consent_required';
    const intent = parsed.data;
    if (intent.stopId !== stop.id || intent.capturedStopRevision !== stop.revision || intent.targetDigest !== stop.targetDigest || intent.expiresAt <= now + 5000 ||
      intent.accountAddress !== stop.accountAddress || intent.agentAddress !== address(target.record.authorization.signerAddress)) return 'stop_cancellation_consent_required';
    const attempts = await this.repository.attempts(stop.id, target.record.key);
    const last = attempts.at(-1);
    if (last && last.expiresAfter > now) return 'waiting';
    if (last) { const reconciled = await this.reconcile(account, target.record.key); if (reconciled.state !== 'resting') return 'waiting'; }
    if (attempts.length >= MAX_CANCEL_ATTEMPTS) return 'stop_cancel_attempts_exhausted';
    const authorization: CancellationAuthorization = { id: `stop-cancel:${stop.id}`.slice(0, 200), version: 1, userId: stop.userId, strategyId: stop.strategyId,
      walletId: intent.agentWalletId, privyOwnerId: intent.agentOwnerQuorumId, signerAddress: address(intent.agentAddress), accountAddress: address(intent.accountAddress),
      network: 'testnet', scope: 'copy:cancel', validFrom: intent.nonce, expiresAt: intent.expiresAt, revokedAt: null };
    const claim = await this.repository.claim({ stopId: stop.id, executionKey: target.record.key, attempt: attempts.length + 1, signerAddress: authorization.signerAddress,
      consentDigest: consentRow.consentDigest, now });
    if (!claim) return 'waiting';
    const base = { operationId: claim.id, stopId: stop.id, claimToken: claim.claimToken, state: 'claimed' as const, createdAt: now,
      target: { record: target.record, intent: target.intent }, authorization, ownerConsentDigest: consentRow.consentDigest, nonce: claim.nonce,
      expiresAfter: Math.min(claim.expiresAfter, intent.expiresAt), action: trackedCancellationAction({ record: target.record, intent: target.intent }) };
    const operation: PreparedTrackedCancellation = { ...base, fingerprint: trackedCancellationFingerprint({ ...base, fingerprint: '' }) };
    const verifier = new HyperliquidAgentApprovalVerifier('testnet', this.acquire, this.global.fetchInfo, this.now);
    const authority: TrackedCancellationAuthority = { authorize: async (op, phase) => {
      const current = await this.repository.get(stop.id), consent = await this.repository.consent(stop.id), grant = await findCurrentWalletAuthorization(this.db, account.authorizationId, 'stop');
      if (current?.state !== 'cancelling' || current.revision !== intent.capturedStopRevision || consent?.consentDigest !== consentRow.consentDigest || !await this.repository.ownerEnabled(stop.userId) ||
        !grant || grant.revokedAt !== null || grant.expiresAt <= this.now() || address(grant.signerAddress) !== authorization.signerAddress) throw new LiveBoundaryError('cancel_current_authority_invalid');
      const exchangeApproval = await verifier.verify(grant), checkedAt = this.now();
      return { phase, operationId: op.operationId, operationFingerprint: op.fingerprint, claimToken: op.claimToken, targetExecutionKey: op.target.record.key,
        targetFingerprint: op.target.record.fingerprint, authorization: op.authorization, ownerConsentDigest: op.ownerConsentDigest, ownerEnabled: true as const, checkedAt, exchangeApproval,
        assertFresh: () => { if (this.now() - checkedAt > 5000) throw new LiveBoundaryError('cancel_current_authority_stale'); } };
    } };
    const { auth, copy } = this.config.value;
    if (!auth.appId || !auth.appSecret || !copy.agent || copy.agent.workerQuorumId !== intent.workerQuorumId) return 'stop_cancellation_signing_unavailable';
    const key = copy.agent.authorizationPrivateKey;
    const signer = new PrivyTrackedCancellationSigner(new BoundaryPrivyOrderSigningClient({ appId: auth.appId, appSecret: auth.appSecret }, fetch, this.now), authority,
      async () => ({ authorization_context: { authorization_private_keys: [key] } }), this.now);
    const transport = new HyperliquidTrackedCancellationTransport(signer, this.global, fetch, this.now);
    const evidence = await new PostgresLiveRiskScope(this.pool, this.now).run({ userId: stop.userId, network: 'testnet', accountAddress: stop.accountAddress },
      async (_scope, session) => this.global.runOriginal(session, () => transport.attempt(operation, () => undefined)));
    await this.repository.attempted(claim.id, evidence.state, { ...evidence, response: undefined, responseDigest: createHash('sha256').update(JSON.stringify(evidence.response ?? null)).digest('hex') });
    return 'attempted';
  }
}

/**
 * Executes owner single-position closes on running copies: reduce-only IOC
 * orders by the approved agent until the observation shows no position in
 * that market. Each attempt's key is recorded before its order, attempt n has
 * a fixed cloid, and an unfinished order is only reconciled. A stop takes
 * over (and closes everything) if one starts.
 */
export class CopyLiveManualCloser {
  constructor(private readonly repository: CopyLiveStopWorkerRepository, private readonly closer: TestnetReduceOnlyCloser,
    /** Books the account's fills now, so the copy's next order sees the close. */
    private readonly scanner: { runFor(accountId: string): Promise<void> }, private readonly log?: (message: string) => void) {}
  async tick(): Promise<void> {
    for (const row of await this.repository.manualCloses()) {
      try { await this.step(row); }
      catch (error) { this.log?.(`close ${row.id} kept for the next pass: ${reason(error)}`); }
    }
  }
  private async step(row: Awaited<ReturnType<CopyLiveStopWorkerRepository['manualCloses']>>[number]): Promise<void> {
    const status = await this.repository.strategyStatus(row.strategyId);
    if (status === 'stopping' || status === 'stopped') { await this.repository.finishManual(row.id, 'refused', 'copy_stopping'); return; }
    const account = await this.repository.closeAccountOf(row);
    if (!account) { await this.repository.finishManual(row.id, 'refused', 'agent_unavailable'); return; }
    const stillWanted = async () => (await this.repository.manualClose(row.id))?.state === 'requested' && !['stopping', 'stopped'].includes(await this.repository.strategyStatus(row.strategyId) ?? 'stopped');
    const last = row.executionKeys.at(-1);
    if (last) {
      const state = await this.repository.journalState(last);
      if (state !== null && !TERMINAL.has(state)) {
        await this.closer.close({ account, coin: row.coin, seed: `manual:${row.id}:${row.executionKeys.length - 1}`, stillWanted }); return;
      }
    }
    const snapshot = await this.closer.observe(account.accountAddress);
    const position = snapshot.positions.find(p => p.coin === row.coin && !Dec.from(p.size).isZero);
    if (!position) {
      // The close's own fills must be booked before the copy trades again.
      if (row.executionKeys.length) await this.scanner.runFor(row.accountId);
      await this.repository.finishManual(row.id, 'done', null); return;
    }
    if (row.executionKeys.length >= MAX_CLOSE_ATTEMPTS) { await this.repository.finishManual(row.id, 'refused', 'close_attempts_exhausted'); return; }
    const seed = `manual:${row.id}:${row.executionKeys.length}`, key = `testnet:${address(account.accountAddress)}:${closeCloid(seed)}`;
    if (!await this.repository.appendManualKey(row.id, row.executionKeys.length, key)) return;
    await this.closer.close({ account, coin: row.coin, seed, stillWanted });
  }
}
