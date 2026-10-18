import { createHash } from 'node:crypto';
import { liveStopCancellationIntentSchema, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { Pool } from 'pg';
import { Dec } from '../../common/decimal/dec.js';
import { AppConfig } from '../../config/app-config.js';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { runAsRestOwner } from '../../hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../../hyperliquid/request-budgeter.service.js';
import { reserveLive } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { errorLogFields } from '../../runtime/safe-error-text.js';
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
import { classify, LIVE_CHARGE_UNOWNED, liveRetryDelayMs, unownedLiveChargeAlert } from '../live/error-class.js';
import { DEFAULT_LIVE_STOP_TIMINGS, type LiveStopTimings } from '../../config/live-timings.js';
import type { CopyLiveStopWorkerRepository, StopRow } from './copy-live-stop-worker.repository.js';
import { CLOSE_NEVER_SENT, closeCloid, closeRetryDelayMs, type CloseAccount, type ReduceOnlyCloser } from './reduce-only-closer.js';
import type { AutoReturn } from './copy-live-auto-return.js';
import type { CopyLiveFlatCarry } from './copy-live-flat-carry.js';
import type { SystemStopOutcome } from '../copy-live-stop-system.js';
import { FLAT_CARRY_RETRY_MS, REVOKE_DEADLINE_MS } from '../../config/constants/timings.js';
import { liveEvidenceMaxAgeMs } from '../../config/live-evidence-window.js';

// A single-position close gives up after retry.closeAttempts orders and a cancel
// after retry.cancelAttempts; a stop never gives up (it backs off).
const TERMINAL: ReadonlySet<string> = new Set(['filled', 'partial', 'cancelled', 'rejected']);
/** Below this the account holds nothing worth a transfer back (USDC). */
const SWEEP_DUST_USD = '0.01';
export interface StopperDependencies {
  readonly repository: CopyLiveStopWorkerRepository;
  readonly closer: ReduceOnlyCloser;
  /** Cancels one tracked resting order under the owner's consent. */
  readonly canceller: StopCanceller | null;
  /** True once a transfer back to the owner's main wallet has been credited. */
  readonly swept: (stop: StopRow) => Promise<boolean>;
  /** Automatic return (master-signer accounts); otherwise the owner returns funds by hand. */
  readonly autoReturn?: AutoReturn | null;
  readonly log?: (message: string) => void;
  /** AppConfig.copy.live.stop (system-stop check interval, retry limits). */
  readonly timings?: LiveStopTimings;
  /** A revoke-requested grant is revoked anyway after this long. */
  readonly revokeDeadlineMs?: number;
  /** System stops (CopyLiveSystemStops): copies whose agent is about to expire
   * (an expired agent can't sign the closes), and unfinished admin close-alls. */
  readonly systemStops?: {
    readonly agentExpiryMarginMs: number;
    stopExpiring(marginMs: number): Promise<SystemStopOutcome>;
    /** Copies whose account Hyperliquid liquidated (optional: older wiring). */
    stopLiquidated?(): Promise<SystemStopOutcome>;
    /** Quarantined reservations of closed copies, released 'closed_account' (optional: older wiring). */
    releaseClosedLiabilities?(): Promise<Array<{ key: string; accountId: string; stopId: string }>>;
    resumePendingCloseAll(): Promise<Array<{ event: string; liveStops: number; liveUnhandled: readonly { accountId: string; code: string }[] }>>;
  } | null;
}
/** Stored reason: a boundary code (live/error-class.ts), else stop_step_failed. */
const reason = (error: unknown) => { const classified = classify(error);
  return (classified.source === 'boundary' && classified.code !== null ? classified.code : 'stop_step_failed').replace(/[^a-z0-9_]/g, '_').slice(0, 80); };
/** Log form: the stored reason plus the error's safe fields (stop_step_failed hides the cause). */
const why = (error: unknown) => `${reason(error)} ${JSON.stringify(errorLogFields(error))}`;

/**
 * Executes owner stop requests; resumable because the state lives on the stop
 * row and every order has a fixed identity:
 * 1. requested: wait until no order of the account is in flight (an expired prepared one is harmless);
 * 2. cancelling: cancel tracked resting orders under the copy's setup consent;
 * 3. closing: reduce-only IOC closes of every position by the approved agent;
 * 4. flat: certified from a fresh observation (no position, no order);
 * 5. stopped: once swept back to the main wallet (or only dust remains).
 */
export class CopyLiveStopper {
  private systemCheckedAt = Number.NEGATIVE_INFINITY;
  /** A failed stop is not stepped again before this time (liveRetryDelayMs),
   * so it can't re-open sockets every pass (gate 2026-10-13). */
  private readonly retryAt = new Map<string, number>();
  constructor(private readonly deps: StopperDependencies, private readonly now: () => number = Date.now) {}

  /** A pass's charges on the shared meter are the stop's (`live:stop:`). */
  tick(): Promise<void> { return runAsRestOwner('stop', () => this.pass()); }

  private async pass(): Promise<void> {
    // System stops (every systemCheckMs): finish unstarted admin close-alls, and
    // stop copies whose agent expires within the margin while it can still sign.
    const system = this.deps.systemStops;
    if (system && this.now() - this.systemCheckedAt >= (this.deps.timings ?? DEFAULT_LIVE_STOP_TIMINGS).systemCheckMs) {
      this.systemCheckedAt = this.now();
      try {
        for (const resumed of await system.resumePendingCloseAll())
          this.deps.log?.(`close-all ${resumed.event} resumed: ${resumed.liveStops} stop(s) started, ${resumed.liveUnhandled.length} cop(ies) left unstopped`);
      } catch (error) { this.deps.log?.(`close-all resume failed: ${why(error)}`); }
      try {
        const outcome = await system.stopExpiring(system.agentExpiryMarginMs);
        for (const stopped of outcome.stopped) this.deps.log?.(`copy account ${stopped.accountId} stopped before its agent expires (stop ${stopped.stopId})`);
        for (const refused of outcome.refused) this.deps.log?.(`copy account ${refused.accountId} could not be stopped before its agent expires: ${refused.code}`);
      } catch (error) { this.deps.log?.(`agent expiry check failed: ${why(error)}`); }
      if (system.stopLiquidated) try {
        const outcome = await system.stopLiquidated();
        for (const stopped of outcome.stopped) this.deps.log?.(`copy account ${stopped.accountId} stopped after Hyperliquid liquidated it (stop ${stopped.stopId})`);
        for (const refused of outcome.refused) this.deps.log?.(`copy account ${refused.accountId} was liquidated and could not be stopped: ${refused.code}`);
      } catch (error) { this.deps.log?.(`liquidation stop check failed: ${why(error)}`); }
      if (system.releaseClosedLiabilities) try {
        for (const released of await system.releaseClosedLiabilities())
          this.deps.log?.(`reservation ${released.key} of closed copy account ${released.accountId} released (closed_account, stop ${released.stopId})`);
      } catch (error) { this.deps.log?.(`closed-copy liability check failed: ${why(error)}`); }
    }
    // A pending admin revoke is bounded: revoked once its stop is blocked or
    // gone, or flat past the deadline. A stop still closing keeps the grant.
    for (const forced of await this.deps.repository.expirePendingRevokes(this.now(), this.deps.revokeDeadlineMs ?? REVOKE_DEADLINE_MS)) {
      this.deps.log?.(`grant ${forced.id} revoked without its stop ending (${forced.reason})`);
    }
    const stops = await this.deps.repository.open();
    for (const id of this.retryAt.keys()) if (!stops.some(stop => stop.id === id)) this.retryAt.delete(id);
    for (const stop of stops) {
      if (this.now() < (this.retryAt.get(stop.id) ?? 0)) continue;
      try { await this.step(stop); this.retryAt.delete(stop.id); }
      catch (error) {
        this.retryAt.set(stop.id, this.now() + liveRetryDelayMs(error));
        this.deps.log?.(`stop ${stop.id} kept for the next pass: ${why(error)}`); await this.deps.repository.issue(stop, reason(error));
        if (reason(error) === LIVE_CHARGE_UNOWNED) this.deps.log?.(unownedLiveChargeAlert('stop', { stopId: stop.id, stage: stop.state }));
      }
    }
  }

  async step(stop: StopRow): Promise<void> {
    const account = await this.deps.repository.closeAccount(stop);
    if (!account) { await this.deps.repository.issue(stop, 'stop_agent_unavailable'); return; }
    if (stop.state === 'requested') return this.requested(stop, account);
    if (stop.state === 'cancelling') return this.cancelling(stop, account);
    if (stop.state === 'closing') return this.closing(stop, account);
    if (stop.state === 'flat') return this.flat(stop, account);
  }

  private async requested(stop: StopRow, account: CloseAccount): Promise<void> {
    const inflight = (await this.deps.repository.inflight(stop.accountAddress)).filter(row => !this.expiredPrepared(row.record));
    // An owner single-position close from before the stop (no intent, reduce-only)
    // is no longer worked by its closer, so the stop settles it.
    for (const row of inflight.filter(row => !row.intent && row.record.action.orders[0]?.r === true && row.record.state !== 'resting'))
      await this.deps.closer.settle(account, row.record.key);
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
    // The stop's issue after this pass: null only when every close went out.
    let shown: string | null = null;
    for (const position of open) {
      // One order per coin per pass; attempt n has a fixed cloid. A remainder
      // moves to attempt n+1 after a back-off, at a wider price, without limit.
      const next = await this.nextAttempt(stop.id, account, position.coin);
      if (next.attempt > 0) shown ??= 'stop_close_retrying';
      if (!next.inFlight && next.previousEndedAt !== null && this.now() - next.previousEndedAt < closeRetryDelayMs(next.attempt)) continue;
      const record = await this.deps.closer.close({ account, coin: position.coin, seed: next.seed, attempt: next.attempt,
        stillWanted: async () => (await this.deps.repository.get(stop.id))?.state === 'closing' });
      // Unsent or rejected: a fresh order next pass.
      if (record?.state === 'rejected') shown = record.errorCode === CLOSE_NEVER_SENT ? 'stop_close_not_sent' : 'stop_close_rejected';
    }
    await this.deps.repository.issue(stop, shown);
  }

  /** The first non-terminal close attempt for `coin` (in flight or unmade), 64 keys per query. */
  private async nextAttempt(stopId: string, account: CloseAccount, coin: string): Promise<{ attempt: number; seed: string; inFlight: boolean; previousEndedAt: number | null }> {
    let previousEndedAt: number | null = null;
    for (let start = 0; ; start += 64) {
      const seeds = Array.from({ length: 64 }, (_, i) => `stop:${stopId}:${coin}:${start + i}`);
      const keyOf = (seed: string) => `${this.deps.closer.network}:${address(account.accountAddress)}:${closeCloid(seed)}`;
      const states = await this.deps.repository.journalStates(seeds.map(keyOf));
      for (const [i, seed] of seeds.entries()) {
        const row = states.get(keyOf(seed));
        if (!row || !TERMINAL.has(row.state)) return { attempt: start + i, seed, inFlight: Boolean(row), previousEndedAt };
        previousEndedAt = row.updatedAt;
      }
    }
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
    // Only dust: end without a transfer.
    if (Dec.from(snapshot.withdrawable).lt(SWEEP_DUST_USD) && Dec.from(snapshot.perpEquity).lt(SWEEP_DUST_USD)) { await this.deps.repository.finish(stop, this.now()); return; }
    const outcome = this.deps.autoReturn ? await this.deps.autoReturn.sweep(stop, snapshot.withdrawable) : 'legacy';
    if (outcome === 'sent') { await this.deps.repository.issue(stop, 'stop_returning_to_main_wallet'); return; }
    // Answer lost: the main wallet's ledger confirms it; never resent.
    if (outcome === 'unknown') { await this.deps.repository.issue(stop, 'stop_return_unconfirmed'); return; }
    if (outcome === 'waiting') { await this.deps.repository.issue(stop, 'stop_return_waiting'); return; }
    // Legacy account, or sweep unsigned/refused: the owner returns the funds.
    await this.deps.repository.issue(stop, 'stop_awaiting_return_to_main_wallet');
  }

  private expiredPrepared(record: LiveExecutionRecord): boolean {
    return record.state === 'prepared' && record.expiresAfter <= this.now();
  }
}

/**
 * Cancels one tracked resting order by its cloid, signed by the approved agent
 * under the placing generation's setup consent (or a legacy owner cancel
 * consent, still honoured), while the stop is cancelling and the grant and
 * exchange approval are current. One attempt per claim; an unknown outcome is
 * reconciled before another.
 */
export class StopCanceller {
  constructor(private readonly network: HyperliquidNetwork, private readonly pool: Pool, private readonly db: DrizzleDb, private readonly config: AppConfig, private readonly global: HyperliquidGlobalTransport,
    private readonly budget: RequestBudgeterService, private readonly repository: CopyLiveStopWorkerRepository,
    private readonly reconcile: (account: CloseAccount, key: string) => Promise<LiveExecutionRecord>, private readonly now = Date.now) {}
  private acquire = (weight: number) => reserveLive(this.budget, weight, { maxWaitMs: 5000 });

  async cancel(stop: StopRow, account: CloseAccount, target: { record: LiveExecutionRecord; intent: LiveOrderIntent | null }): Promise<string> {
    if (!target.intent) return 'stop_cancel_target_unproven';
    const consentRow = await this.repository.consent(stop.id), now = this.now();
    const parsed = consentRow ? liveStopCancellationIntentSchema.safeParse(consentRow.intent) : null;
    // A legacy owner consent for this stop, else the placing generation's setup
    // consent; never a new one (without either: authority missing).
    let intent: { agentWalletId: string; agentOwnerQuorumId: string; agentAddress: string; accountAddress: string; workerQuorumId: string; nonce: number; expiresAt: number };
    let consentDigest: string, currentDigest: () => Promise<string | null>, revision: number | null;
    if (consentRow?.consentDigest && parsed?.success && liveStopCancellationIntentDigest(parsed.data) === consentRow.intentDigest) {
      intent = parsed.data; consentDigest = consentRow.consentDigest; revision = parsed.data.capturedStopRevision;
      currentDigest = async () => (await this.repository.consent(stop.id))?.consentDigest ?? null;
      if (parsed.data.stopId !== stop.id || parsed.data.capturedStopRevision !== stop.revision || parsed.data.targetDigest !== stop.targetDigest) return 'stop_cancellation_authority_missing';
    } else {
      const mandate = await this.repository.setupConsent(stop, target.record.key);
      if (!mandate) return 'stop_cancellation_authority_missing';
      intent = { agentWalletId: mandate.agentWalletId, agentOwnerQuorumId: target.record.authorization.privyOwnerId, agentAddress: mandate.agentAddress, accountAddress: mandate.accountAddress,
        workerQuorumId: mandate.workerQuorumId, nonce: mandate.nonce, expiresAt: Math.min(mandate.expiresAt.getTime(), target.record.authorization.expiresAt) };
      consentDigest = mandate.consentDigest!; revision = null;
      currentDigest = () => this.repository.mandateConsentDigest(mandate.id);
      if (target.record.authorization.walletId !== mandate.agentWalletId) return 'stop_cancellation_authority_missing';
    }
    if (intent.expiresAt <= now + 5000 || intent.accountAddress !== stop.accountAddress || intent.agentAddress !== address(target.record.authorization.signerAddress)) return 'stop_cancellation_authority_missing';
    const attempts = await this.repository.attempts(stop.id, target.record.key);
    const last = attempts.at(-1);
    if (last && last.expiresAfter > now) return 'waiting';
    if (last) { const reconciled = await this.reconcile(account, target.record.key); if (reconciled.state !== 'resting') return 'waiting'; }
    if (attempts.length >= (this.config.value.copy.live?.stop ?? DEFAULT_LIVE_STOP_TIMINGS).retry.cancelAttempts) return 'stop_cancel_attempts_exhausted';
    const authorization: CancellationAuthorization = { id: `stop-cancel:${stop.id}`.slice(0, 200), version: 1, userId: stop.userId, strategyId: stop.strategyId,
      walletId: intent.agentWalletId, privyOwnerId: intent.agentOwnerQuorumId, signerAddress: address(intent.agentAddress), accountAddress: address(intent.accountAddress),
      network: this.network, scope: 'copy:cancel', validFrom: intent.nonce, expiresAt: intent.expiresAt, revokedAt: null };
    const claim = await this.repository.claim({ stopId: stop.id, executionKey: target.record.key, attempt: attempts.length + 1, signerAddress: authorization.signerAddress,
      consentDigest, now });
    if (!claim) return 'waiting';
    const base = { operationId: claim.id, stopId: stop.id, claimToken: claim.claimToken, state: 'claimed' as const, createdAt: now,
      target: { record: target.record, intent: target.intent }, authorization, ownerConsentDigest: consentDigest, nonce: claim.nonce,
      expiresAfter: Math.min(claim.expiresAfter, intent.expiresAt), action: trackedCancellationAction({ record: target.record, intent: target.intent }) };
    const operation: PreparedTrackedCancellation = { ...base, fingerprint: trackedCancellationFingerprint({ ...base, fingerprint: '' }) };
    const verifier = new HyperliquidAgentApprovalVerifier(this.network, this.acquire, this.global.fetchInfo, this.now);
    const authority: TrackedCancellationAuthority = { authorize: async (op, phase) => {
      const current = await this.repository.get(stop.id), digestNow = await currentDigest(), grant = await findCurrentWalletAuthorization(this.db, account.authorizationId, 'stop');
      // A disabled owner's stop still cancels: disabling blocks new risk, not unwinding.
      if (current?.state !== 'cancelling' || (revision !== null && current.revision !== revision) || digestNow !== consentDigest || !await this.repository.ownerExists(stop.userId) ||
        !grant || grant.revokedAt !== null || grant.expiresAt <= this.now() || address(grant.signerAddress) !== authorization.signerAddress) throw new LiveBoundaryError('cancel_current_authority_invalid');
      const exchangeApproval = await verifier.verify(grant), checkedAt = this.now();
      return { phase, operationId: op.operationId, operationFingerprint: op.fingerprint, claimToken: op.claimToken, targetExecutionKey: op.target.record.key,
        targetFingerprint: op.target.record.fingerprint, authorization: op.authorization, ownerConsentDigest: op.ownerConsentDigest, ownerEnabled: true as const, checkedAt, exchangeApproval,
        assertFresh: () => { if (this.now() - checkedAt > liveEvidenceMaxAgeMs()) throw new LiveBoundaryError('cancel_current_authority_stale'); } };
    } };
    const { auth, copy } = this.config.value;
    if (!auth.appId || !auth.appSecret || !copy.agent || copy.agent.workerQuorumId !== intent.workerQuorumId) return 'stop_cancellation_signing_unavailable';
    const key = copy.agent.authorizationPrivateKey;
    const signer = new PrivyTrackedCancellationSigner(new BoundaryPrivyOrderSigningClient(this.network, { appId: auth.appId, appSecret: auth.appSecret }, fetch, this.now), authority,
      async () => ({ authorization_context: { authorization_private_keys: [key] } }), this.now);
    const transport = new HyperliquidTrackedCancellationTransport(signer, this.global, fetch, this.now);
    const evidence = await new PostgresLiveRiskScope(this.pool, this.now, undefined, { kind: 'stop', id: String(stop.id) }).run({ userId: stop.userId, network: this.network, accountAddress: stop.accountAddress },
      async (_scope, session) => this.global.runOwned('stop', () => this.global.runOriginal(session, () => transport.attempt(operation, () => undefined))));
    await this.repository.attempted(claim.id, evidence.state, { ...evidence, response: undefined, responseDigest: createHash('sha256').update(JSON.stringify(evidence.response ?? null)).digest('hex') });
    return 'attempted';
  }
}

/**
 * Owner single-position closes on running copies: reduce-only IOC orders until
 * the market shows no position. Each attempt's key is recorded before its
 * order (fixed cloid); an unfinished order is only reconciled. A stop takes over.
 */
export class CopyLiveManualCloser {
  constructor(private readonly repository: CopyLiveStopWorkerRepository, private readonly closer: ReduceOnlyCloser,
    /** Books the account's fills now, so the copy's next order sees the close. */
    private readonly scanner: { runFor(accountId: string): Promise<void> },
    /** Resets what earlier closes still owed of the coin once it is flat. */
    private readonly carry: Pick<CopyLiveFlatCarry, 'owed' | 'reset'>, private readonly log?: (message: string) => void, private readonly now: () => number = Date.now,
    private readonly closeAttempts = DEFAULT_LIVE_STOP_TIMINGS.retry.closeAttempts) {}
  /** Flat closes whose carry reset waits: not observed again before this time. */
  private readonly carryRetryAt = new Map<string, number>();
  /** A failed close is not stepped again before this time (liveRetryDelayMs). */
  private readonly retryAt = new Map<string, number>();
  /** A pass's charges on the shared meter are the close's (`live:close:`). */
  tick(): Promise<void> { return runAsRestOwner('close', () => this.pass()); }

  private async pass(): Promise<void> {
    const rows = await this.repository.manualCloses();
    for (const id of this.carryRetryAt.keys()) if (!rows.some(row => row.id === id)) this.carryRetryAt.delete(id);
    for (const id of this.retryAt.keys()) if (!rows.some(row => row.id === id)) this.retryAt.delete(id);
    for (const row of rows) {
      if (this.now() < (this.retryAt.get(row.id) ?? 0)) continue;
      try { await this.step(row); this.retryAt.delete(row.id); }
      catch (error) {
        this.retryAt.set(row.id, this.now() + liveRetryDelayMs(error));
        this.log?.(`close ${row.id} kept for the next pass: ${why(error)}`);
        if (reason(error) === LIVE_CHARGE_UNOWNED) this.log?.(unownedLiveChargeAlert('manual_close', { closeId: row.id, stage: 'close' }));
      }
    }
  }
  private async step(row: Awaited<ReturnType<CopyLiveStopWorkerRepository['manualCloses']>>[number]): Promise<void> {
    const status = await this.repository.strategyStatus(row.strategyId);
    if (status === 'stopping' || status === 'stopped') { await this.repository.finishManual(row.id, 'refused', 'copy_stopping'); return; }
    const account = await this.repository.closeAccountOf(row);
    if (!account) { await this.repository.finishManual(row.id, 'refused', 'agent_unavailable'); return; }
    // A leader-flat close ends once the copy journaled a new open of the coin
    // (the position may now include it); an unjournaled open waits for this close.
    const stillWanted = async () => (await this.repository.manualClose(row.id))?.state === 'requested' && !['stopping', 'stopped'].includes(await this.repository.strategyStatus(row.strategyId) ?? 'stopped') &&
      !await this.repository.leaderReopened(row.idempotencyKey);
    const last = row.executionKeys.at(-1);
    if (last) {
      const state = await this.repository.journalState(last);
      if (state !== null && !TERMINAL.has(state)) {
        await this.closer.close({ account, coin: row.coin, seed: `manual:${row.id}:${row.executionKeys.length - 1}`, attempt: row.executionKeys.length - 1, stillWanted }); return;
      }
    }
    if (await this.repository.leaderReopened(row.idempotencyKey)) {
      this.log?.(`close ${row.id} of ${row.coin} cancelled: the copy already opened it again`);
      if (row.executionKeys.length) await this.scanner.runFor(row.accountId);
      await this.repository.finishManual(row.id, 'refused', 'leader_reopened'); return;
    }
    if (this.now() < (this.carryRetryAt.get(row.id) ?? 0)) return;
    // Read the carry before the observation that finds the position closed.
    const owed = await this.carry.owed(row);
    const snapshot = await this.closer.observe(account.accountAddress);
    const position = snapshot.positions.find(p => p.coin === row.coin && !Dec.from(p.size).isZero);
    if (!position) {
      // The close's own fills must be booked before the copy trades again.
      if (row.executionKeys.length) await this.scanner.runFor(row.accountId);
      // Flat: reset the coin's carry. With a leg in flight the reset fails and
      // the close stays requested (holding opens) until a later pass.
      if (!await this.carry.reset(row, account.accountAddress, owed)) {
        this.carryRetryAt.set(row.id, this.now() + FLAT_CARRY_RETRY_MS);
        this.log?.(`close ${row.id} of ${row.coin}: flat, its reduction carry is reset on a later pass`); return;
      }
      this.carryRetryAt.delete(row.id);
      await this.repository.finishManual(row.id, 'done', null); return;
    }
    if (row.executionKeys.length >= this.closeAttempts) { await this.repository.finishManual(row.id, 'refused', 'close_attempts_exhausted'); return; }
    const attempt = row.executionKeys.length;
    // A retry backs off after the previous attempt ended (and goes at a wider price).
    const previous = last ? (await this.repository.journalStates([last])).get(last) : undefined;
    if (previous && this.now() - previous.updatedAt < closeRetryDelayMs(attempt)) return;
    const seed = `manual:${row.id}:${attempt}`, key = `${this.closer.network}:${address(account.accountAddress)}:${closeCloid(seed)}`;
    if (!await this.repository.appendManualKey(row.id, attempt, key)) return;
    await this.closer.close({ account, coin: row.coin, seed, attempt, stillWanted });
  }
}
