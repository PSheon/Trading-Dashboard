import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyTypedData } from 'viem';
import { accountModeIntentSchema, accountModeOwnerConsentTypedData, copyAccountModeOperationSchema, prepareCopyAccountModeSchema,
  type CopyAccountModeOperation, type AccountModeIntent } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { currentRequestSignal } from '../runtime/request-context.js';
import { CopyAccountModeRepository, accountModeDigest, type AccountModeRow } from './copy-account-mode.repository.js';
import { USER_WALLET_PROVISIONER, type UserWalletProvisioner } from './live/privy-wallet-provisioner.js';
import { ACCOUNT_MODE_OBSERVE_WEIGHT, accountModeTypedData, type AccountModeObservation, type AccountModeObserveOptions, type AccountModeOwnedMaster } from './live/privy-account-mode-client.js';
import { ACCOUNT_MODE_ABSENCE_WEIGHT } from './copy-account-mode-evidence.js';
import { HyperliquidBudgetWait, type LiveReserveOptions } from '../hyperliquid/hyperliquid-budget-wait.js';
import { LiveBoundaryError } from './live/wallet-authorization.js';

export const ACCOUNT_MODE_CLIENT = Symbol('ACCOUNT_MODE_CLIENT');
export const ACCOUNT_MODE_ABSENCE_READER = Symbol('ACCOUNT_MODE_ABSENCE_READER');
export interface AccountModeClient {
  readonly available: boolean; acquire(): Promise<void>;
  /** Takes Hyperliquid weight before any evidence clock starts; throws
   * `HyperliquidBudgetWait` when it isn't available soon. (Test doubles
   * without a budget may omit it.) */
  reserve?(weight: number, options?: LiveReserveOptions): Promise<void>;
  signMaster(master: AccountModeOwnedMaster, intent: AccountModeIntent, userJwt: string, assertFreshProof: () => void): Promise<string>;
  send(intent: AccountModeIntent, signature: string, assertFreshProof: () => void): Promise<unknown>;
  observe(intent: AccountModeIntent, options?: AccountModeObserveOptions): Promise<Readonly<AccountModeObservation>>;
}
export interface AccountModeAbsenceProof {
  readonly network: 'testnet'; readonly accountAddress: string; readonly observedAt: number; readonly completedAt: number;
  readonly dexes: readonly string[]; readonly sourceDigest: string; readonly complete: true; readonly empty: true;
}
/** This process's all-venue source, held for one proof (see `turn`). */
export interface AccountModeAbsenceTurn { release(): void }
export interface AccountModeAbsenceOptions {
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
/** Who authorises one mode change: the owner's own consent for this exact
 * operation with their fresh session (Settings), or a one-click setup whose
 * consent (verified at its confirm) bound the account to "disabled", with the
 * setup's signer (the owner's session or the worker under the owner's policy). */
export type AccountModeAuthority =
  | { readonly kind: 'owner'; readonly consentSignature: string; readonly userJwt: string }
  | { readonly kind: 'setup'; readonly consentDigest: string; sign(master: AccountModeOwnedMaster, intent: AccountModeIntent, assertFresh: () => void): Promise<string> };
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
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now || now - timestamp > 5000) throw new ConflictException('account_mode_evidence_expired');
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
/** One preflight's weight: an observation, an absence proof, an observation. */
export const PREFLIGHT_WEIGHT = 2 * ACCOUNT_MODE_OBSERVE_WEIGHT + ACCOUNT_MODE_ABSENCE_WEIGHT;
/** One attempt's weight: the preflight before signing, the one before the
 * POST, and the POST (the reconcile after it pays for itself). */
export const ATTEMPT_WEIGHT = 2 * PREFLIGHT_WEIGHT + 1;
/** Longest wait for room in the shared per-IP meter once a 5 s clock runs. */
const IN_WINDOW_METER_WAIT_MS = 1_000;
/** A setup's nonce keeps this much of its five-minute window to sign and send. */
const SETUP_NONCE_MIN_REMAINING_MS = 60_000;
function baseline(proof: AccountModeObservation): 'default' | 'supported' {
  if (proof.role !== 'user' || proof.portfolioMarginEnabled || !(proof.abstraction === 'default' && proof.dexAbstraction === null || proof.abstraction === 'disabled' && proof.dexAbstraction === false))
    throw new ConflictException('account_mode_baseline_unsupported');
  return proof.abstraction === 'disabled' ? 'supported' : 'default';
}
@Injectable()
export class CopyAccountModeService {
  constructor(private readonly repository: CopyAccountModeRepository, private readonly uow: UnitOfWork, private readonly config: AppConfig,
    @Inject(USER_WALLET_PROVISIONER) private readonly wallets: UserWalletProvisioner,
    @Inject(ACCOUNT_MODE_CLIENT) private readonly exchange: AccountModeClient,
    @Inject(ACCOUNT_MODE_ABSENCE_READER) private readonly absence: AccountModeAbsenceReader) {}
  get available() { return this.config.value.hyperliquid.wallet.network === 'testnet' && this.config.value.copy.mode !== 'disabled' && this.wallets.available && this.exchange.available; }
  private enabled() { if (!this.available) throw new ServiceUnavailableException('account_mode_setup_unavailable'); }
  async overview(userId: number) { await this.repository.owner(userId); return { available: this.available, network: 'testnet' as const, operations: (await this.repository.list(userId)).map(wire) }; }
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
  private async identity(userId: number, row: AccountModeRow, mutation = false) {
    const checkedAt = Date.now(), current = await this.repository.assertCurrent(userId, row, undefined, mutation);
    const master = await this.wallets.findOwned(current.owner.privyUserId, current.account.externalId,
      current.account.masterPolicyId && current.account.masterSignerQuorumId ? { workerQuorumId: current.account.masterSignerQuorumId, policyId: current.account.masterPolicyId } : null);
    if (!master || master.id !== row.accountWalletId || master.address !== row.accountAddress || master.externalId !== current.account.externalId || master.ownerQuorumId !== row.accountOwnerQuorumId)
      throw new ConflictException('account_mode_identity_changed');
    await this.repository.assertCurrent(userId, row, undefined, mutation); fresh(checkedAt); return { ...current, checkedAt };
  }
  private assertObservation(row: AccountModeRow, proof: AccountModeObservation) {
    if (proof.network !== 'testnet' || proof.accountAddress !== row.accountAddress || proof.source !== 'https://api.hyperliquid-testnet.xyz/info' ||
        !/^0x[0-9a-f]{64}$/.test(proof.sourceDigest) || proof.completedAt < proof.earliestObservedAt) throw new ConflictException('account_mode_evidence_changed');
    fresh(proof.earliestObservedAt); fresh(proof.completedAt);
  }
  /**
   * Fresh evidence for one decision: identity, mode and all-venue absence in
   * parallel, then the mode again. Every read's weight is paid and the shared
   * all-venue source is ours before `started`: waiting for either never ages
   * the evidence (before, the 5 s clock ran through the budget queue and a
   * drained bucket turned every attempt into stale evidence). When one read
   * fails the others are abandoned (nothing more reserved or subscribed).
   */
  private async preflight(userId: number, row: AccountModeRow, { prepaid = false }: { prepaid?: boolean } = {}) {
    const readable = readIntent(row);
    if (!prepaid) await this.exchange.reserve?.(PREFLIGHT_WEIGHT);
    const turn = await this.absence.turn?.();
    const abandon = new AbortController();
    const settle = <T>(work: Promise<T>) => work.catch((error: unknown) => { abandon.abort(); throw error; });
    const started = Date.now();
    const proving = settle(this.absence.prove(row.accountAddress, { prepaid: true, turn, signal: abandon.signal }));
    const [identity, observation, absence] = await Promise.all([settle(this.identity(userId, row, true)),
      settle(this.exchange.observe(readable, { prepaid: true, signal: abandon.signal, meterWaitMs: IN_WINDOW_METER_WAIT_MS })), proving]);
    this.assertObservation(row, observation); baseline(observation);
    if (absence.network !== 'testnet' || absence.accountAddress !== row.accountAddress || absence.complete !== true || absence.empty !== true ||
        !/^[0-9a-f]{64}$/.test(absence.sourceDigest) || !Array.isArray(absence.dexes) || !absence.dexes.includes('') || new Set(absence.dexes).size !== absence.dexes.length || absence.completedAt < absence.observedAt)
      throw new ConflictException('account_mode_absence_unproven');
    fresh(absence.observedAt); fresh(absence.completedAt); fresh(identity.checkedAt); fresh(started);
    const finalMode = await this.exchange.observe(readIntent(row), { prepaid: true, meterWaitMs: IN_WINDOW_METER_WAIT_MS }); this.assertObservation(row, finalMode); baseline(finalMode);
    const oldestObservedAt = Math.min(started, identity.checkedAt, absence.observedAt, finalMode.earliestObservedAt);
    const assertCompletion = (now: number) => fresh(oldestObservedAt, now);
    const assertFresh = () => {
      fresh(started); fresh(identity.checkedAt); fresh(absence.observedAt); this.assertObservation(row, finalMode);
      // Earlier sources must still be fresh when all validation completes.
      fresh(oldestObservedAt);
    };
    assertFresh(); return { identity, observation: finalMode, absence, started, assertFresh, assertCompletion };
  }
  async challenge(userId: number, id: string) {
    this.enabled(); const row = await this.repository.find(userId, id);
    if (row.submissionState !== 'prepared' || row.attemptedAt || row.targetState === 'supported') throw new ConflictException('account_mode_not_signable');
    const proof = await this.preflight(userId, row);
    if (baseline(proof.observation) !== 'default') throw new ConflictException('account_mode_already_supported');
    const challenged = await this.uow.run(tx => this.repository.challenge(tx, userId, row, proof.assertFresh));
    return { operation: wire(challenged), intent: intent(challenged) };
  }
  /** Observes the account's mode. Its weight is paid first: when the budget
   * is busy nothing is read and the row is left as it is (`busy: 'throw'`:
   * the `HyperliquidBudgetWait` is passed on, for a driver to come back). */
  async reconcile(userId: number, id: string, { busy = 'keep' }: { busy?: 'keep' | 'throw' } = {}): Promise<CopyAccountModeOperation> {
    let row = await this.repository.find(userId, id);
    try {
      await this.exchange.reserve?.(ACCOUNT_MODE_OBSERVE_WEIGHT);
      const [identity, proof] = await Promise.all([this.identity(userId, row), this.exchange.observe(readIntent(row), { prepaid: true, meterWaitMs: IN_WINDOW_METER_WAIT_MS })]);
      this.assertObservation(row, proof); fresh(identity.checkedAt);
      const supported = proof.role === 'user' && proof.abstraction === 'disabled' && proof.dexAbstraction === false && proof.portfolioMarginEnabled === false;
      const unsupported = proof.role !== 'user' || proof.portfolioMarginEnabled || proof.abstraction === 'unifiedAccount' || proof.abstraction === 'portfolioMargin' || proof.dexAbstraction === true;
      const targetState = supported ? 'supported' as const : unsupported ? 'unsupported' as const : 'unproven' as const;
      const updated = await this.uow.run(async tx => {
        await this.repository.assertCurrent(userId, row, tx); fresh(identity.checkedAt); this.assertObservation(row, proof);
        const current = await this.repository.find(userId, row.id, tx, true);
        const recovery = current.submissionState === 'signing' && !current.attemptedAt && current.signingStartedAt && Date.now() - current.signingStartedAt.getTime() > 30000
          ? { submissionState: 'prepared' as const, claimToken: null, signingStartedAt: null, consentDigest: null } : {};
        const next = await this.repository.transition(current, { ...recovery, targetState, observation: { ...proof }, observedAt: new Date(proof.earliestObservedAt),
          issue: targetState === 'supported' ? null : proof.abstraction === 'disabled' && proof.dexAbstraction === null ? 'account_mode_legacy_state_unproven' : unsupported ? 'account_mode_unsupported' : 'account_mode_standard_unproven' }, tx);
        fresh(identity.checkedAt); this.assertObservation(row, proof); return next;
      });
      row = updated ?? await this.repository.find(userId, id);
    } catch (error) {
      if (error instanceof HyperliquidBudgetWait) { if (busy === 'throw') throw error; return wire(row); }
      row = (await this.repository.transition(row, { targetState: 'unknown', issue: 'account_mode_observation_pending' })) ?? await this.repository.find(userId, id);
    }
    return wire(row);
  }
  async approve(userId: number, id: string, consentSignature: string, userJwt: string): Promise<CopyAccountModeOperation> {
    return this.submit(userId, id, { kind: 'owner', consentSignature, userJwt });
  }
  /** One attempt of the exact prepared operation; the attempt is durable
   * before the POST, and an attempted operation is only reconciled. */
  async submit(userId: number, id: string, authority: AccountModeAuthority): Promise<CopyAccountModeOperation> {
    this.enabled(); let row = await this.repository.find(userId, id);
    // An HTTP caller (Settings) is answered 504 at its deadline: past that,
    // nothing is attempted or sent for it (a setup's drive runs outside any
    // request and has no such signal).
    const requestSignal = currentRequestSignal();
    const answered = () => { if (requestSignal?.aborted) throw new ConflictException('account_mode_request_expired'); };
    // A duplicate request observes the existing claim without revising it.
    if (row.submissionState === 'signing' && !row.attemptedAt) return wire(row);
    if (row.submissionState !== 'prepared' || row.attemptedAt || row.targetState === 'supported') return this.reconcile(userId, id);
    // The owner's consent signed this operation's allocated nonce.
    if (authority.kind === 'owner') liveConsent(intent(row));
    // The whole attempt is paid before its first clock starts: the preflight
    // before signing, the one before the POST, and the POST.
    await this.exchange.reserve?.(ATTEMPT_WEIGHT);
    const first = await this.preflight(userId, row, { prepaid: true });
    if (baseline(first.observation) === 'supported') return this.reconcile(userId, id);
    // A setup's consent bound the account to "disabled", not a nonce: the
    // nonce is allocated here, under this preflight (no separate challenge
    // preflight), with time left in its window to sign and send.
    if (authority.kind === 'setup') row = await this.uow.run(tx => this.repository.challenge(tx, userId, row, first.assertFresh, SETUP_NONCE_MIN_REMAINING_MS));
    const original = intent(row); liveConsent(original);
    if (authority.kind === 'owner' ? !authority.userJwt || !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(authority.consentSignature) ||
        !await verifyTypedData({ address: row.ownerAddress as `0x${string}`, ...accountModeOwnerConsentTypedData(original), signature: authority.consentSignature as `0x${string}` })
      : !/^[0-9a-f]{64}$/.test(authority.consentDigest) || typeof authority.sign !== 'function')
      throw new BadRequestException('invalid_account_mode_consent');
    const consentDigest = authority.kind === 'owner' ? accountModeDigest(authority.consentSignature) : authority.consentDigest;
    const claimed = await this.uow.run(async tx => {
      await this.repository.assertCurrent(userId, row, tx, true); first.assertFresh(); liveConsent(original);
      const next = await this.repository.transition(row, { submissionState: 'signing', claimToken: randomUUID(), signingStartedAt: new Date(), consentDigest, issue: null }, tx);
      first.assertFresh(); liveConsent(original); return next;
    });
    if (!claimed) return this.reconcile(userId, id); row = claimed;
    let signature: string, final: Awaited<ReturnType<CopyAccountModeService['preflight']>>;
    try {
      first.assertFresh(); liveConsent(original);
      const master = { walletId: row.accountWalletId, address: row.accountAddress, ownerQuorumId: row.accountOwnerQuorumId };
      signature = authority.kind === 'owner' ? await this.exchange.signMaster(master, original, authority.userJwt, completionGuard(original, first))
        : await authority.sign(master, original, completionGuard(original, first));
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !await verifyTypedData({ address: row.accountAddress as `0x${string}`, ...accountModeTypedData(original), signature: signature as `0x${string}` }))
        throw new BadRequestException('account_mode_master_signature_invalid');
      final = await this.preflight(userId, row, { prepaid: true });
      if (baseline(final.observation) === 'supported') {
        await this.repository.transition(row, { submissionState: 'prepared', claimToken: null, signingStartedAt: null, consentDigest: null });
        return this.reconcile(userId, id);
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
      const response = await this.exchange.send(original, signature, () => { answered(); guard(); });
      if (response && typeof response === 'object' && 'status' in response && 'response' in response &&
          (response.status === 'ok' && response.response && typeof response.response === 'object' && 'type' in response.response && response.response.type === 'default' || response.status === 'err' && typeof response.response === 'string' && !/nonce/i.test(response.response))) {
        row = (await this.repository.transition(row, { submissionState: response.status === 'ok' ? 'accepted' : 'rejected', acknowledgmentDigest: accountModeDigest(response), issue: response.status === 'ok' ? null : 'account_mode_submission_rejected' })) ?? await this.repository.find(userId, id);
      }
    } catch (error) {
      if (error instanceof LiveBoundaryError && error.code === 'account_mode_not_dispatched') return this.notDispatched(userId, row);
      return wire(row);
    }
    // Paid for separately (the attempt's own weight is spent): when the
    // budget is busy the operation is left for the next reconcile.
    return this.reconcile(userId, row.id);
  }
  /** The attempt was persisted but the POST was never handed to the
   * transport (a refused meter permit, a stale final proof, the clock): no
   * signature left this process, so the operation goes back to prepared
   * with its nonce, instead of staying unknown with nothing to observe. A
   * crash between persisting and sending still stays unknown. */
  private async notDispatched(userId: number, row: AccountModeRow): Promise<CopyAccountModeOperation> {
    const reverted = await this.repository.transition(row, { submissionState: 'prepared', attemptedAt: null, attemptProof: null, claimToken: null,
      signingStartedAt: null, consentDigest: null, issue: 'account_mode_not_submitted' });
    return wire(reverted ?? await this.repository.find(userId, row.id));
  }
}
