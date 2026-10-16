import { BadRequestException, ConflictException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyTypedData } from 'viem';
import { WALLET_NETWORKS, accountModeIntentSchema, isHyperliquidNetwork, copyAccountModeOperationSchema, prepareCopyAccountModeSchema, type CopyAccountModeOperation, type AccountModeIntent, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { currentRequestSignal } from '../runtime/request-context.js';
import { CopyAccountModeRepository, accountModeDigest, type AccountModeRow } from './copy-account-mode.repository.js';
import { USER_WALLET_PROVISIONER, type UserWalletProvisioner } from './live/privy-wallet-provisioner.js';
import { accountModeTypedData, type AccountModeObservation, type AccountModeObserveOptions, type AccountModeOwnedMaster } from './live/privy-account-mode-client.js';

import { HyperliquidBudgetWait, type LiveReserveOptions, type LiveBudgetReservation } from '../hyperliquid/hyperliquid-budget-wait.js';
import { LiveBoundaryError } from './live/wallet-authorization.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import { deploymentNetwork } from './live-deployment.js';
import { liveReadCache } from './live/live-read-cache.js';
import { IdentitySpans, privyIdentityFresh } from './live/privy-identity-freshness.js';
import { IN_WINDOW_METER_WAIT_MS, SETUP_NONCE_MIN_REMAINING_MS, SLOW_IDENTITY_PROOF_MS } from '../config/constants/timings.js';
import { liveEvidenceMaxAgeMs } from '../config/live-evidence-window.js';
import { ACCOUNT_MODE_OBSERVE_WEIGHT, ATTEMPT_WEIGHT, PREFLIGHT_WEIGHT } from '../config/constants/weights.js';

export const ACCOUNT_MODE_CLIENT = Symbol('ACCOUNT_MODE_CLIENT');
export const ACCOUNT_MODE_ABSENCE_READER = Symbol('ACCOUNT_MODE_ABSENCE_READER');
export interface AccountModeClient {
  readonly available: boolean; acquire(): Promise<void>;
  /** Takes weight before any evidence clock starts; throws `HyperliquidBudgetWait` if not soon. */
  reserve?(weight: number, options?: LiveReserveOptions): Promise<LiveBudgetReservation | void>;
  send(intent: AccountModeIntent, signature: string, assertFreshProof: () => void, consume?: (weight: number) => void): Promise<unknown>;
  observe(intent: AccountModeIntent, options?: AccountModeObserveOptions): Promise<Readonly<AccountModeObservation>>;
}
export interface AccountModeAbsenceProof {
  readonly network: HyperliquidNetwork; readonly accountAddress: string; readonly observedAt: number; readonly completedAt: number;
  readonly dexes: readonly string[]; readonly sourceDigest: string; readonly complete: true; readonly empty: true;
}
/** This process's all-venue source, held for one proof (see `turn`). */
export interface AccountModeAbsenceTurn { release(): void }
export interface AccountModeAbsenceOptions {
  readonly consume?: (weight: number) => void;
  /** The caller already took the proof's weight from the budget. */
  readonly prepaid?: boolean;
  /** A turn the caller waited for before its clock started. */
  readonly turn?: AccountModeAbsenceTurn;
  /** Abandoned (a sibling read failed): no socket reserved, nothing subscribed. */
  readonly signal?: AbortSignal;
}
export interface AccountModeAbsenceReader {
  prove(accountAddress: string, options?: AccountModeAbsenceOptions): Promise<Readonly<AccountModeAbsenceProof>>;
  /** Waits for the shared all-venue source before a clock starts. */
  turn?(options?: LiveReserveOptions): Promise<AccountModeAbsenceTurn>;
}
/** Who authorises one mode change: a one-click setup whose consent
 * (verified at its confirm) bound the account to "disabled", signed by the
 * worker under the owner's policy (the only signing model, 2026-10-07). */
type AccountModeAuthority =
  { readonly kind: 'setup'; readonly consentDigest: string; sign(master: AccountModeOwnedMaster, intent: AccountModeIntent, assertFresh: () => void): Promise<string> };
function wire(row: AccountModeRow): CopyAccountModeOperation {
  return copyAccountModeOperationSchema.parse({ id: row.id, accountId: row.accountId, strategyId: row.strategyId, network: row.network,
    accountAddress: row.accountAddress, target: row.target, revision: row.revision, submissionState: row.submissionState, targetState: row.targetState,
    issue: row.issue, observedAt: row.observedAt?.toISOString() ?? null, attemptedAt: row.attemptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
function intent(row: AccountModeRow): AccountModeIntent {
  if (!row.intent || !row.nonce || !row.consentExpiresAt) throw new ConflictException('account_mode_consent_not_prepared');
  const parsed = accountModeIntentSchema.parse(row.intent);
  if (parsed.operationId !== row.id || parsed.accountId !== row.accountId || parsed.strategyId !== row.strategyId || parsed.network !== row.network ||
      parsed.accountAddress !== row.accountAddress || parsed.nonce !== row.nonce || parsed.consentExpiresAt !== row.consentExpiresAt.getTime() || accountModeDigest(parsed) !== row.intentDigest)
    throw new ConflictException('account_mode_intent_changed');
  return Object.freeze(parsed);
}
function readIntent(row: AccountModeRow): AccountModeIntent {
  if (row.intent) return intent(row);
  // Unallocated read envelope is used only to scope real mode queries. It is
  // never persisted as a challenge, signed or sent to the exchange.
  const nonce = Date.now(); return accountModeIntentSchema.parse({ operationId: row.id, accountId: row.accountId, strategyId: row.strategyId,
    network: row.network, accountAddress: row.accountAddress, nonce, consentExpiresAt: nonce + 300000 });
}
function fresh(timestamp: number, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now || now - timestamp > liveEvidenceMaxAgeMs()) throw new ConflictException('account_mode_evidence_expired');
}
/** The Privy identity proof's own bound (PRIVY_IDENTITY_MAX_AGE_MS). */
function identityFresh(checkedAt: number, now = Date.now()) {
  if (!privyIdentityFresh(checkedAt, now)) throw new ConflictException('account_mode_identity_evidence_expired');
}
function liveConsent(value: AccountModeIntent, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < value.nonce || now >= value.consentExpiresAt) throw new ConflictException('account_mode_consent_expired');
}
function completionGuard(value: AccountModeIntent, proof: { assertFresh(): void; assertCompletion(now: number): void }) {
  return () => {
    proof.assertFresh();
    const now = Date.now(); liveConsent(value, now); proof.assertCompletion(now);
  };
}
function baseline(proof: AccountModeObservation): 'default' | 'supported' {
  if (proof.role !== 'user' || proof.portfolioMarginEnabled || !(proof.abstraction === 'default' && proof.dexAbstraction === null || proof.abstraction === 'disabled' && proof.dexAbstraction === false))
    throw new ConflictException('account_mode_baseline_unsupported');
  return proof.abstraction === 'disabled' ? 'supported' : 'default';
}
@Injectable()
export class CopyAccountModeService {
  private readonly logger = new Logger(CopyAccountModeService.name);
  constructor(private readonly repository: CopyAccountModeRepository, private readonly uow: UnitOfWork, private readonly config: AppConfig,
    @Inject(USER_WALLET_PROVISIONER) private readonly wallets: UserWalletProvisioner,
    @Inject(ACCOUNT_MODE_CLIENT) private readonly exchange: AccountModeClient,
    @Inject(ACCOUNT_MODE_ABSENCE_READER) private readonly absence: AccountModeAbsenceReader) {}
  get available() { return this.config.value.copy.mode !== 'disabled' && this.wallets.available && this.exchange.available; }
  private enabled() { if (!this.available) throw new ServiceUnavailableException('account_mode_setup_unavailable'); }
  async overview(userId: number) { await this.repository.owner(userId); return { available: this.available, network: deploymentNetwork(this.config), operations: (await this.repository.list(userId)).map(wire) }; }
  async byKey(userId: number, key: string) { return wire(await this.repository.byKey(userId, key)); }
  async prepare(userId: number, accountId: string, input: unknown) {
    this.enabled(); const parsed = prepareCopyAccountModeSchema.safeParse(input); if (!parsed.success) throw new BadRequestException('invalid_account_mode_setup');
    const row = await this.uow.run(tx => this.repository.ensure(tx, userId, accountId, parsed.data.idempotencyKey));
    return this.reconcile(userId, row.id);
  }
  /** The setup's mode operation for its account (one per account): the
   * existing one when Settings already made it. Prepare only; no exchange call. */
  async ensureForSetup(userId: number, accountId: string, idempotencyKey: string, liveSetupId: string): Promise<AccountModeRow> {
    this.enabled();
    return this.uow.run(async tx => {
      const [existing] = await this.repository.forAccount(tx, accountId);
      if (existing) { if (existing.userId !== userId) throw new ConflictException('account_mode_identity_changed'); return existing; }
      return this.repository.ensure(tx, userId, accountId, idempotencyKey, liveSetupId);
    });
  }
  async row(userId: number, id: string) { return this.repository.find(userId, id); }
  /** A setup's step weight from this process's bucket, taken before its
   * shared-meter claim (`key`: the setup's; its place in the bucket's queue
   * is kept across passes, LiveReserveOptions.holdKey). Undefined: the
   * client has no budget (test doubles). */
  async reserveForSetup(weight: number, key: string): Promise<LiveBudgetReservation | void> {
    return this.exchange.reserve?.(weight, { holdKey: key });
  }
  /** The account's Privy identity between two DB checks; ages by PRIVY_IDENTITY_MAX_AGE_MS, not
   * the exchange's 5 s, so slow Privy neither expires it nor ages later exchange evidence. */
  private async identity(userId: number, row: AccountModeRow, mutation = false) {
    const timing = new IdentitySpans(), checkedAt = timing.startedAt;
    const current = await timing.time('db_current', () => this.repository.assertCurrent(userId, row, undefined, mutation));
    const master = await timing.time('privy_master_account', () => this.wallets.findOwned(current.owner.privyUserId, current.account.externalId,
      current.account.masterPolicyId && current.account.masterSignerQuorumId ? { workerQuorumId: current.account.masterSignerQuorumId, policyId: current.account.masterPolicyId } : null));
    if (!master || master.id !== row.accountWalletId || master.address !== row.accountAddress || master.externalId !== current.account.externalId || master.ownerQuorumId !== row.accountOwnerQuorumId)
      throw new ConflictException('account_mode_identity_changed');
    await timing.time('db_current_after', () => this.repository.assertCurrent(userId, row, undefined, mutation));
    if (timing.elapsed() > SLOW_IDENTITY_PROOF_MS) this.logger.warn(`account mode ${row.id} identity proof slow ${JSON.stringify(timing)}`);
    identityFresh(checkedAt); return { ...current, checkedAt };
  }
  private assertObservation(row: AccountModeRow, proof: AccountModeObservation) {
    if (proof.network !== row.network || proof.accountAddress !== row.accountAddress || proof.source !== WALLET_NETWORKS[row.network].infoUrl ||
        !/^0x[0-9a-f]{64}$/.test(proof.sourceDigest) || proof.completedAt < proof.earliestObservedAt) throw new ConflictException('account_mode_evidence_changed');
    fresh(proof.earliestObservedAt); fresh(proof.completedAt);
  }
  /**
   * Fresh evidence for one decision: Privy identity, then mode and all-venue absence in parallel,
   * then mode again. Weight and the all-venue source are secured before `started`, so queueing
   * never ages the 5 s evidence; identity runs before that clock with its own bound
   * (PRIVY_IDENTITY_MAX_AGE_MS). One failed exchange read abandons the others.
   */
  private async preflight(userId: number, row: AccountModeRow, { prepaid = false, consume }: { prepaid?: boolean; consume?: (weight: number) => void } = {}) {
    const readable = readIntent(row);
    if (!prepaid) await this.exchange.reserve?.(PREFLIGHT_WEIGHT);
    const identity = await this.identity(userId, row, true);
    const turn = await this.absence.turn?.();
    const abandon = new AbortController();
    const settle = <T>(work: Promise<T>) => work.catch((error: unknown) => { abandon.abort(); throw error; });
    const started = Date.now();
    const proving = settle(this.absence.prove(row.accountAddress, { prepaid: true, turn, signal: abandon.signal, consume }));
    const work = [settle(this.exchange.observe(readable, { prepaid: true, signal: abandon.signal, meterWaitMs: IN_WINDOW_METER_WAIT_MS, consume })), proving] as const;
    // A failed sibling aborts further dispatch. Wait for their bounded readers
    // to finish before the caller releases prepaid weight.
    const [observation, absence] = await Promise.all(work).catch(async error => { await Promise.allSettled(work); throw error; });
    this.assertObservation(row, observation); baseline(observation);
    if (absence.network !== row.network || absence.accountAddress !== row.accountAddress || absence.complete !== true || absence.empty !== true ||
        !/^[0-9a-f]{64}$/.test(absence.sourceDigest) || !Array.isArray(absence.dexes) || !absence.dexes.includes('') || new Set(absence.dexes).size !== absence.dexes.length || absence.completedAt < absence.observedAt)
      throw new ConflictException('account_mode_absence_unproven');
    fresh(absence.observedAt); fresh(absence.completedAt); identityFresh(identity.checkedAt); fresh(started);
    const finalMode = await this.exchange.observe(readIntent(row), { prepaid: true, meterWaitMs: IN_WINDOW_METER_WAIT_MS, consume }); this.assertObservation(row, finalMode); baseline(finalMode);
    // The exchange's evidence: 5 s from its oldest read. The identity: its own bound.
    const oldestObservedAt = Math.min(started, absence.observedAt, finalMode.earliestObservedAt);
    const assertCompletion = (now: number) => { fresh(oldestObservedAt, now); identityFresh(identity.checkedAt, now); };
    const assertFresh = () => {
      fresh(started); identityFresh(identity.checkedAt); fresh(absence.observedAt); this.assertObservation(row, finalMode);
      // Earlier sources must still be fresh when all validation completes.
      fresh(oldestObservedAt);
    };
    assertFresh(); return { identity, observation: finalMode, absence, started, assertFresh, assertCompletion };
  }
  /** Observes the account's mode, weight paid first; when busy the row is left as is
   * (`busy: 'throw'` rethrows the `HyperliquidBudgetWait`). */
  async reconcile(userId: number, id: string, { busy = 'keep', reservation: prepaid }: { busy?: 'keep' | 'throw'; reservation?: LiveBudgetReservation | void } = {}): Promise<CopyAccountModeOperation> {
    let row = await this.repository.find(userId, id);
    // A caller's reservation (a setup's step: taken before its shared claim) pays for it; it releases it.
    let reservation: LiveBudgetReservation | void = undefined;
    try {
      if (!prepaid) reservation = await this.exchange.reserve?.(ACCOUNT_MODE_OBSERVE_WEIGHT);
      const paid = prepaid ?? reservation;
      const consume = paid ? (weight: number) => paid.consume(weight) : undefined;
      // The identity first: its Privy calls never age the exchange's evidence.
      const identity = await this.identity(userId, row);
      const proof = await this.exchange.observe(readIntent(row), { prepaid: true, meterWaitMs: IN_WINDOW_METER_WAIT_MS, consume });
      this.assertObservation(row, proof); identityFresh(identity.checkedAt);
      const supported = proof.role === 'user' && proof.abstraction === 'disabled' && proof.dexAbstraction === false && proof.portfolioMarginEnabled === false;
      const unsupported = proof.role !== 'user' || proof.portfolioMarginEnabled || proof.abstraction === 'unifiedAccount' || proof.abstraction === 'portfolioMargin' || proof.dexAbstraction === true;
      const targetState = supported ? 'supported' as const : unsupported ? 'unsupported' as const : 'unproven' as const;
      // Seed the cross-order cache so the first order doesn't pay 200 weight again (2026-10-12).
      if (supported && isHyperliquidNetwork(row.network)) {
        const cache = liveReadCache(row.network), user = row.accountAddress;
        cache.put({ type: 'userRole', user }, { role: 'user' });
        cache.put({ type: 'userAbstraction', user }, 'disabled');
        cache.put({ type: 'userDexAbstraction', user }, false);
      }
      const updated = await this.uow.run(async tx => {
        await this.repository.assertCurrent(userId, row, tx); identityFresh(identity.checkedAt); this.assertObservation(row, proof);
        const current = await this.repository.find(userId, row.id, tx, true);
        const recovery = current.submissionState === 'signing' && !current.attemptedAt && current.signingStartedAt && Date.now() - current.signingStartedAt.getTime() > 30000
          ? { submissionState: 'prepared' as const, claimToken: null, signingStartedAt: null, consentDigest: null } : {};
        const next = await this.repository.transition(current, { ...recovery, targetState, observation: { ...proof }, observedAt: new Date(proof.earliestObservedAt),
          issue: targetState === 'supported' ? null : proof.abstraction === 'disabled' && proof.dexAbstraction === null ? 'account_mode_legacy_state_unproven' : unsupported ? 'account_mode_unsupported' : 'account_mode_standard_unproven' }, tx);
        identityFresh(identity.checkedAt); this.assertObservation(row, proof); return next;
      });
      row = updated ?? await this.repository.find(userId, id);
    } catch (error) {
      if (error instanceof HyperliquidBudgetWait) { if (busy === 'throw') throw error; return wire(row); }
      this.logger.warn(`account mode ${row.id} not observed: ${safeErrorText(error)}`);
      // A repeat changes nothing (no new revision every pass).
      if (row.targetState !== 'unknown' || row.issue !== 'account_mode_observation_pending')
        row = (await this.repository.transition(row, { targetState: 'unknown', issue: 'account_mode_observation_pending' })) ?? await this.repository.find(userId, id);
    } finally { reservation?.release(); }
    return wire(row);
  }
  /** One attempt of the exact prepared operation; the attempt is durable
   * before the POST, and an attempted operation is only reconciled. */
  async submit(userId: number, id: string, authority: AccountModeAuthority, { reservation: prepaid }: { reservation?: LiveBudgetReservation | void } = {}): Promise<CopyAccountModeOperation> {
    this.enabled(); let row = await this.repository.find(userId, id);
    // Past an HTTP caller's 504 deadline nothing is attempted or sent (setup drives have no signal).
    const requestSignal = currentRequestSignal();
    const answered = () => { if (requestSignal?.aborted) throw new ConflictException('account_mode_request_expired'); };
    // A duplicate request observes the existing claim without revising it.
    if (row.submissionState === 'signing' && !row.attemptedAt) return wire(row);
    if (row.submissionState !== 'prepared' || row.attemptedAt || row.targetState === 'supported') return this.reconcile(userId, id, { reservation: prepaid });
    // The whole attempt (two preflights and the POST) is paid before its first clock starts.
    const reservation = prepaid ?? await this.exchange.reserve?.(ATTEMPT_WEIGHT);
    const consume = reservation ? (weight: number) => reservation.consume(weight) : undefined;
    const followUp = () => (prepaid ? { reservation: prepaid } : {});
    try {
      const first = await this.preflight(userId, row, { prepaid: true, consume });
      if (baseline(first.observation) === 'supported') return this.reconcile(userId, id, followUp());
      // Consent bound the target, not a nonce: the nonce is allocated here, with time left to sign and send.
      row = await this.uow.run(tx => this.repository.challenge(tx, userId, row, first.assertFresh, SETUP_NONCE_MIN_REMAINING_MS));
      const original = intent(row); liveConsent(original);
      if (!/^[0-9a-f]{64}$/.test(authority.consentDigest) || typeof authority.sign !== 'function') throw new BadRequestException('invalid_account_mode_consent');
      const consentDigest = authority.consentDigest;
      const claimed = await this.uow.run(async tx => {
        await this.repository.assertCurrent(userId, row, tx, true); first.assertFresh(); liveConsent(original);
        const next = await this.repository.transition(row, { submissionState: 'signing', claimToken: randomUUID(), signingStartedAt: new Date(), consentDigest, issue: null }, tx);
        first.assertFresh(); liveConsent(original); return next;
      });
      if (!claimed) return this.reconcile(userId, id, followUp()); row = claimed;
      let signature: string, final: Awaited<ReturnType<CopyAccountModeService['preflight']>>;
      try {
        first.assertFresh(); liveConsent(original);
        const master = { walletId: row.accountWalletId, address: row.accountAddress, ownerQuorumId: row.accountOwnerQuorumId };
        signature = await authority.sign(master, original, completionGuard(original, first));
        if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !await verifyTypedData({ address: row.accountAddress as `0x${string}`, ...accountModeTypedData(original), signature: signature as `0x${string}` }))
          throw new BadRequestException('account_mode_master_signature_invalid');
        final = await this.preflight(userId, row, { prepaid: true, consume });
        if (baseline(final.observation) === 'supported') {
          await this.repository.transition(row, { submissionState: 'prepared', claimToken: null, signingStartedAt: null, consentDigest: null });
          return this.reconcile(userId, id, followUp());
        }
        row = await this.uow.run(async tx => {
          await this.repository.assertCurrent(userId, row, tx, true); final.assertFresh(); liveConsent(original); answered();
          const locked = await this.repository.find(userId, row.id, tx, true); final.assertFresh(); liveConsent(original);
          if (locked.revision !== row.revision || locked.claimToken !== row.claimToken || locked.submissionState !== 'signing' || locked.attemptedAt || accountModeDigest(intent(locked)) !== accountModeDigest(original))
            throw new ConflictException('account_mode_attempt_changed');
          const next = await this.repository.transition(locked, { submissionState: 'unknown', attemptedAt: new Date(),
            attemptProof: { identityCheckedAt: final.identity.checkedAt, observation: { ...final.observation }, absence: { ...final.absence } }, issue: 'account_mode_submission_unknown' }, tx);
          final.assertFresh(); liveConsent(original); if (!next) throw new ConflictException('account_mode_attempt_changed'); return next;
        });
      } catch (error) {
        if (!row.attemptedAt) await this.repository.transition(row, { submissionState: 'prepared', claimToken: null, signingStartedAt: null, consentDigest: null, issue: 'account_mode_not_submitted' });
        throw error;
      }
      // No await follows these pure checks before initiating the one POST.
      try { final.assertFresh(); liveConsent(original); } catch { return this.notDispatched(userId, row); }
      try {
        const guard = completionGuard(original, final);
        const response = await this.exchange.send(original, signature, () => { answered(); guard(); }, consume);
        if (response && typeof response === 'object' && 'status' in response && 'response' in response &&
            (response.status === 'ok' && response.response && typeof response.response === 'object' && 'type' in response.response && response.response.type === 'default' || response.status === 'err' && typeof response.response === 'string' && !/nonce/i.test(response.response))) {
          row = (await this.repository.transition(row, { submissionState: response.status === 'ok' ? 'accepted' : 'rejected', acknowledgmentDigest: accountModeDigest(response), issue: response.status === 'ok' ? null : 'account_mode_submission_rejected' })) ?? await this.repository.find(userId, id);
        }
      } catch (error) {
        if (error instanceof LiveBoundaryError && error.code === 'account_mode_not_dispatched') return this.notDispatched(userId, row);
        // Sent, its answer lost: reconciled from the exchange, never resent.
        this.logger.warn(`account mode ${row.id} outcome unknown: ${safeErrorText(error)}`);
        return wire(row);
      }
      // When the budget is busy the operation is left for the next reconcile.
      return this.reconcile(userId, row.id, followUp());
    } finally { if (!prepaid) reservation?.release(); }
  }
  /** Persisted attempt whose POST never reached the transport: no signature left the process, so
   * back to prepared. A crash between persisting and sending still stays unknown. */
  private async notDispatched(userId: number, row: AccountModeRow): Promise<CopyAccountModeOperation> {
    const reverted = await this.repository.transition(row, { submissionState: 'prepared', attemptedAt: null, attemptProof: null, claimToken: null,
      signingStartedAt: null, consentDigest: null, issue: 'account_mode_not_submitted' });
    return wire(reverted ?? await this.repository.find(userId, row.id));
  }
}
