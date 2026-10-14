import { BadRequestException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { liveCopySetupAbortSchema, requestLiveCopySetupAbortSchema, usdSendTypedData, WALLET_NETWORKS, type LiveCopySetupAbort } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { BackgroundJobs } from '../runtime/background-jobs.service.js';
import { errorLogFields } from '../runtime/safe-error-text.js';
import { CopyLiveSetupAbortRepository, type SetupAbortRow } from './copy-live-setup-abort.repository.js';
import { CopyLiveSetupAbortReturnRepository, SETUP_ABORT_RESIDUAL_RETURNS, setupAbortRefundAttempt, setupAbortRefundLeft } from './copy-live-setup-abort-return.repository.js';
import { CopyLiveSetupRepository } from './copy-live-setup.repository.js';
import { CopyFundingRepository } from './copy-funding.repository.js';
import { CopyFundingService, wire as fundingWire } from './copy-funding.service.js';
import { CopyAgentService } from './copy-agent.service.js';
import { CopyAccountModeService } from './copy-account-mode.service.js';
import { CopyLiveReturnService } from './copy-live-return.service.js';
import { CopyLiveReturnRepository, sweepRetrying, sweepSuperseded, type ReturnRow } from './copy-live-return.repository.js';
import { CopyFundingExchangeClient } from './copy-funding-exchange.client.js';
import { WORKER_MASTER_SIGNER, type WorkerMasterSigner } from './live/privy-policy-master-signer.js';
import type { SetupAbortFlatObservation } from './live/live-account-observer.js';
import { deploymentNetwork, liveExecutionEnabled } from './live-deployment.js';
import { abortDepositSettled } from './copy-live-setup-abort-deposit.js';
import { backoffMs, classify, FUNDING_RETRY_POLICY, type ErrorClassification } from './live/error-class.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import { ALERT_EVERY_MS } from '../config/constants/alerts.js';
import { NOT_DISPATCHED_RETRY_MS, REPROVE_AFTER_MS, SETUP_ABORT_BLOCKED_RECHECK_MS, SETUP_ABORT_NOT_FLAT_ESCALATE_MS } from '../config/constants/timings.js';
import { jsonDigest as digest } from '../common/crypto/digest.js';

export const SETUP_ABORT_OBSERVER = Symbol('SETUP_ABORT_OBSERVER');
interface SetupAbortObserver { observeSetupAbortFlat(address: string): Promise<SetupAbortFlatObservation> }
const issue = (value: string | null) => value && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : null;
/** A failed pass whose error names no code of its own (a read that failed,
 * a stale or missing row): a wait, never a block (error-class: transient). */
const EVIDENCE_UNAVAILABLE = 'setup_abort_evidence_unavailable';
/** Only these classes block an abort (the owner reads `blocked` as "act"):
 * transient and budget waits are shown as the step still going. */
const blocks = (classified: ErrorClassification) => classified.class === 'permanent' || classified.class === 'needs_owner';
/** Whether an abort's stored issue blocks it (error-class over its code). */
const setupAbortIssueBlocks = (code: string | null) => code !== null && blocks(classify(new Error(code)));
const NOT_FLAT = 'setup_abort_proof_not_flat', NOT_FLAT_PERSISTENT = 'setup_abort_not_flat_persistent';
const states = { requested: 'requested', draining: 'reconciling', waiting_credit: 'reconciling', proving: 'reconciling', returning: 'refunding',
  delegated: 'delegated', blocked: 'blocked', done: 'completed' } as const;

/** Requests establish durable authority only. Provider reads/signing run in
 * tracked worker jobs; restart resumes the same original children and refund. */
@Injectable()
export class CopyLiveSetupAbortService {
  private readonly logger = new Logger(CopyLiveSetupAbortService.name);
  private readonly running = new Set<string>();
  private readonly alerted = new Map<string, number>();
  constructor(private readonly config: AppConfig, private readonly repository: CopyLiveSetupAbortRepository,
    private readonly refunds: CopyLiveSetupAbortReturnRepository, private readonly setups: CopyLiveSetupRepository,
    private readonly fundingRows: CopyFundingRepository, private readonly funding: CopyFundingService,
    private readonly agents: CopyAgentService, private readonly modes: CopyAccountModeService,
    private readonly returnService: CopyLiveReturnService, private readonly returns: CopyLiveReturnRepository, private readonly exchange: CopyFundingExchangeClient,
    @Inject(WORKER_MASTER_SIGNER) private readonly signer: WorkerMasterSigner,
    @Inject(SETUP_ABORT_OBSERVER) private readonly observer: SetupAbortObserver, private readonly jobs: BackgroundJobs,
    @Optional() private readonly now: () => number = Date.now) {}

  get available() { return liveExecutionEnabled(this.config) && this.config.value.copy.live?.network === deploymentNetwork(this.config) && this.signer.available; }
  async request(userId: number, setupId: string, body: unknown): Promise<LiveCopySetupAbort> {
    if (!this.available) throw new ServiceUnavailableException({ statusCode: 503, code: 'setup_abort_unavailable', message: 'Check the saved setup progress on its original network' });
    const parsed = requestLiveCopySetupAbortSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid setup abort request');
    return this.wire(await this.repository.request(userId, setupId, parsed.data.idempotencyKey, this.now));
  }
  /** CopyLiveSetupService.cancel's abort: same authority as request, inside the caller's transaction. */
  async requestIn(tx: DbTransaction, userId: number, setupId: string, key: string): Promise<SetupAbortRow> {
    if (!this.available) throw new ServiceUnavailableException({ statusCode: 503, code: 'setup_abort_unavailable', message: 'Cancelling a confirmed setup is not available right now' });
    return this.repository.admit(tx, userId, setupId, key, this.now);
  }
  async get(userId: number, setupId: string) { await this.setups.owner(userId); return this.wire(await this.repository.forSetup(userId, setupId)); }
  async wire(row: SetupAbortRow): Promise<LiveCopySetupAbort> {
    const children = await this.repository.children(row), deposit = children.funding.find(op => op.id === row.fundingOperationId),
      refund = children.funding.find(op => op.id === row.returnOperationId || row.stopId !== null && op.stopId === row.stopId && op.direction === 'to_main' && !sweepSuperseded(op, children.funding));
    // A parent may be done once its sweep was accepted: don't present acceptance as credit.
    const pendingRefund = row.state === 'done' && refund && refund.status !== 'credited';
    const rejectedRefund = pendingRefund && ['rejected', 'cancelled'].includes(refund.status);
    // Done on the account's state while the deposit's explorer confirmation lags: not yet `completed`.
    const pendingDeposit = row.state === 'done' && !pendingRefund && deposit && ['prepared', 'unknown', 'accepted'].includes(deposit.status);
    return liveCopySetupAbortSchema.parse({ id: row.id, setupId: row.setupId, strategyId: row.strategyId, accountId: row.accountId, kind: row.kind, network: row.network,
      state: pendingRefund ? rejectedRefund ? 'blocked' : row.stopId ? 'delegated' : 'refunding' : pendingDeposit ? 'reconciling' : CopyLiveSetupAbortService.waitingWire(row) ?? states[row.state],
      issue: pendingRefund ? rejectedRefund ? 'setup_abort_refund_not_completed' : 'setup_abort_refund_pending' : pendingDeposit ? 'setup_abort_deposit_pending' : issue(row.issue), deposit: deposit ? { ...fundingWire(deposit), direction: deposit.direction } : null,
      refund: refund ? { ...fundingWire(refund), direction: refund.direction } : null,
      stop: children.stop ? { id: children.stop.id, state: children.stop.state, issue: issue(children.stop.issue) } : null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  }
  /** A row `blocked` on an issue that only waits (pre-classifier rows): shown as the step it waits in. */
  private static waitingWire(row: SetupAbortRow) {
    if (row.state !== 'blocked' || !issue(row.issue) || setupAbortIssueBlocks(row.issue)) return null;
    return row.stopId ? 'delegated' as const : row.returnOperationId ? 'refunding' as const : 'reconciling' as const;
  }
  async tick() {
    if (this.jobs.stopping) return 0;
    let admitted = 0;
    for (const row of await this.repository.open()) {
      if (this.running.has(row.id)) continue;
      this.running.add(row.id); admitted++;
      void this.jobs.run(() => this.process(row.id)).catch(error => this.logger.warn(`setup abort ${row.id} kept for recovery ${JSON.stringify(errorLogFields(error))}`))
        .finally(() => this.running.delete(row.id));
    }
    return admitted;
  }
  /** A failed child reconcile is logged and retried on the next pass. */
  private kept(abortId: string, child: string, childId: string) {
    return (error: unknown) => { this.logger.warn(`setup abort ${abortId} ${child} ${childId} reconcile kept for the next pass ${JSON.stringify(errorLogFields(error))}`); };
  }
  /** `ALERT setup_abort <kind>`, rate-limited (ALERT_EVERY_MS). */
  private alert(row: SetupAbortRow, kind: 'residual_return' | 'residual_cap' | 'not_flat', fields: Record<string, unknown>) {
    const key = `${row.id}:${kind}`, at = this.now(), last = this.alerted.get(key);
    if (last !== undefined && at - last < ALERT_EVERY_MS) return;
    this.alerted.set(key, at);
    this.logger.error(`ALERT setup_abort ${kind} ${JSON.stringify({ abortId: row.id, setupId: row.setupId, accountId: row.accountId, network: row.network, ...fields })}`);
  }
  /** A balance read that failed proves nothing: the refund waits. */
  private unread(abortId: string) {
    return (error: unknown) => { this.logger.warn(`setup abort ${abortId} balance not read ${JSON.stringify(errorLogFields(error))}`); return null; };
  }
  /** Worker pass only; never called from an HTTP mutation. */
  async process(id: string) {
    let row = await this.repository.lease(id); if (!row) return;
    const originalLease = row;
    // A flat proof this pass restarts the not-flat clock (backoff.notFlatSince).
    let flat = false;
    const notFlatSince = () => flat ? null : row!.backoff?.notFlatSince ?? null;
    const wait = async (state: SetupAbortRow['state'], reason: string | null, delayMs = 30_000) => {
      const at = this.now(), since = notFlatSince();
      const backoff = since === null ? null : { failures: 0, nextAt: at + delayMs, notFlatSince: since };
      const next = await this.repository.transition(row!, { state, issue: reason, nextAttemptAt: new Date(at + delayMs), ...(row!.backoff || backoff ? { backoff } : {}) });
      if (next) row = next;
    };
    /** Blocked on `code`, looked at again after SETUP_ABORT_BLOCKED_RECHECK_MS;
     * the same block again is bookkeeping only (defer: no revision). */
    const block = async (code: string) => {
      const current = row!, at = this.now(), since = notFlatSince();
      const backoff = since === null ? null : { failures: 0, nextAt: at + SETUP_ABORT_BLOCKED_RECHECK_MS, notFlatSince: since };
      const changes = { nextAttemptAt: new Date(at + SETUP_ABORT_BLOCKED_RECHECK_MS), ...(current.backoff || backoff ? { backoff } : {}) };
      const next = current.state === 'blocked' && current.issue === code ? await this.repository.defer(current, changes)
        : await this.repository.transition(current, { state: 'blocked', issue: code, ...changes });
      if (next) row = next;
    };
    /** Only permanent and needs_owner block (live/error-class). Transient and budget wait in their
     * step on the row's backoff (FUNDING_RETRY_POLICY, or the error's later retry time); a repeated
     * wait is bookkeeping only (no revision). */
    const settle = async (classified: ErrorClassification, reason: string) => {
      const current = row!, at = this.now();
      // Not flat waits until SETUP_ABORT_NOT_FLAT_ESCALATE_MS without a flat proof, then blocks.
      const since = reason === NOT_FLAT ? notFlatSince() ?? at : notFlatSince();
      if (reason === NOT_FLAT && (current.issue === NOT_FLAT_PERSISTENT || at - since! > SETUP_ABORT_NOT_FLAT_ESCALATE_MS)) {
        this.alert(current, 'not_flat', { notFlatSince: new Date(since!).toISOString(), minutes: Math.floor((at - since!) / 60_000) });
        await block(NOT_FLAT_PERSISTENT); return;
      }
      if (blocks(classified)) { await block(reason); return; }
      const failures = (current.backoff?.failures ?? 0) + 1;
      const delayMs = Math.max(backoffMs(failures - 1, FUNDING_RETRY_POLICY), classified.retryAfterMs ?? 0);
      // The step it waits in: the stop it delegated to, its refund, else its proof.
      const state: SetupAbortRow['state'] = current.stopId ? 'delegated' : current.returnOperationId ? 'returning' : 'proving';
      const changes = { nextAttemptAt: new Date(at + delayMs), backoff: { failures, nextAt: at + delayMs, ...(since === null ? {} : { notFlatSince: since }) } };
      const next = state === current.state && reason === current.issue ? await this.repository.defer(current, changes)
        : await this.repository.transition(current, { state, issue: reason, ...changes });
      if (next) row = next;
    };
    const stop = (code: string) => settle(classify(new Error(code)), code);
    try {
      let children = await this.repository.children(row);
      if (row.stopId) {
        if (!children.stop || children.stop.mandateId !== row.mandateId || children.stop.accountId !== row.accountId || children.stop.network !== row.network) {
          await stop('setup_abort_generation_conflict'); return;
        }
        const deposit = children.funding.find(op => op.id === row!.fundingOperationId);
        // An automatic return never sent is superseded by its next attempt, or retried.
        const returns = children.funding.filter(op => op.stopId === row!.stopId && op.direction === 'to_main' && !sweepSuperseded(op, children.funding));
        if (returns.some(op => ['rejected', 'cancelled'].includes(op.status) && !sweepRetrying(op))) { await stop('setup_abort_refund_not_completed'); return; }
        if (returns.some(op => op.status !== 'credited')) { await wait('delegated', 'setup_abort_refund_pending'); return; }
        if (children.stop.state === 'stopped' && (!deposit || !['prepared','unknown','accepted'].includes(deposit.status))) await wait('done', null);
        else await wait('delegated', issue(children.stop.issue));
        return;
      }
      // Cancel only children that provably never crossed their attempt boundary; attempted ones are only reconciled.
      for (const op of children.funding) {
        if (op.setupAbortId === row.id) continue;
        if (op.direction !== 'to_account' || op.network !== row.network || op.strategyId !== row.strategyId) { await stop('setup_abort_binding_unknown'); return; }
        if (!op.attemptedAt && ['prepared','unknown'].includes(op.status)) await this.fundingRows.cancel(row.userId, op.id);
        else if (op.attemptedAt && ['unknown','accepted'].includes(op.status)) await this.funding.reconcile(row.userId, op.id).catch(this.kept(row.id, 'funding', op.id));
      }
      // Same for ordinary reservations: seal the unattempted, reconcile the attempted.
      for (const op of children.otherFunding) {
        if (!op.attemptedAt && ['prepared','unknown'].includes(op.status)) await this.repository.sealOrdinaryFunding(row, op);
        else if (op.attemptedAt && ['unknown','accepted'].includes(op.status)) await this.funding.reconcile(row.userId, op.id).catch(this.kept(row.id, 'funding', op.id));
      }
      for (const op of children.modes) if (op.submissionState === 'signing' || (op.attemptedAt && op.targetState !== 'supported' && op.submissionState !== 'rejected'))
        await this.modes.reconcile(row.userId, op.id).catch(this.kept(row.id, 'mode', op.id));
      for (const op of children.agents) if (['approval_signing','approval_unknown'].includes(op.state)) await this.agents.reconcile(row.userId, op.id).catch(this.kept(row.id, 'agent', op.id));
      for (const op of children.builders) if (['unknown','accepted'].includes(op.state)) await this.returnService.reconcileBuilder(row.userId, op.id).catch(this.kept(row.id, 'builder', op.id));
      children = await this.repository.children(row);
      if (row.kind !== 'start') {
        if (!await this.repository.finishPending(row)) await wait('draining', 'setup_abort_child_pending');
        return;
      }
      if (children.otherFunding.length) { await wait('draining', 'setup_abort_child_pending'); return; }
      const deposit = children.funding.find(op => op.id === row!.fundingOperationId);
      if (!row.accountId || !row.accountAddress || !deposit) { await stop('setup_abort_binding_unknown'); return; }
      // An unconfirmed deposit is settled once the account's ledger or balance shows it, or its nonce
      // can no longer execute; until then the refund waits. A reserved refund stays settled.
      if (!row.returnOperationId && !abortDepositSettled(deposit, this.now(), null) &&
        !abortDepositSettled(deposit, this.now(), await this.exchange.withdrawable(row.network, row.accountAddress).catch(this.unread(row.id)))) {
        await wait('waiting_credit', 'setup_abort_deposit_pending'); return;
      }
      let refund: ReturnRow | null | undefined = children.funding.find(op => op.id === row!.returnOperationId);
      if (refund && ['unknown','accepted'].includes(refund.status)) {
        await this.funding.reconcile(row.userId, refund.id).catch(this.kept(row.id, 'refund', refund.id));
        refund = await this.returns.find(row.userId, refund.id);
        // Accepted means executed; completion below needs only a flat zero account. Unknown waits.
        if (refund.status === 'unknown' || refund.status === 'prepared') { await wait('returning', 'setup_abort_refund_pending'); return; }
      }
      if (refund && ['rejected','cancelled'].includes(refund.status)) { await stop('setup_abort_refund_not_completed'); return; }
      // Pay local attempt weight before the evidence clock. The global
      // transport still rechecks its own quota and this <=5s proof at POST.
      await this.exchange.acquire();
      const originalPrepared = refund?.status === 'prepared' && refund.attemptedAt === null;
      if (!originalPrepared) {
        const reservationProof = await this.observer.observeSetupAbortFlat(row.accountAddress);
        if (await this.refunds.complete(row, reservationProof, this.now)) return;
        flat = true;
        // Money left after the refund is returned again by a follow-up, at most
        // SETUP_ABORT_RESIDUAL_RETURNS times; then the abort blocks for its owner.
        const left = refund && setupAbortRefundLeft(refund, reservationProof) ? refund : null;
        if (left && (setupAbortRefundAttempt(left) ?? SETUP_ABORT_RESIDUAL_RETURNS) >= SETUP_ABORT_RESIDUAL_RETURNS) {
          this.alert(row, 'residual_cap', { refunds: (setupAbortRefundAttempt(left) ?? 0) + 1, withdrawable: reservationProof.snapshot.withdrawable });
          await stop('setup_abort_residual_balance'); return;
        }
        if (!this.available) { await stop('setup_abort_unavailable'); return; }
        refund = await this.refunds.reserve(row, reservationProof, this.now);
        if (left && refund && refund.id !== left.id)
          this.alert(row, 'residual_return', { followUp: setupAbortRefundAttempt(refund), of: SETUP_ABORT_RESIDUAL_RETURNS, amount: refund.amount,
            previousRefundId: left.id, previousStatus: left.status });
      } else if (!this.available) { await stop('setup_abort_unavailable'); return; }
      if (!refund) { await wait('draining', 'setup_abort_child_pending'); return; }
      row = await this.repository.find(row.userId, row.id);
      if (refund.status !== 'prepared') { await wait('returning', 'setup_abort_refund_pending'); return; }
      // A fresh proof for the locked begin; no earlier proof's clock is reused.
      const proof = await this.observer.observeSetupAbortFlat(row.accountAddress!);
      const attempt = await this.refunds.begin(row, refund.id, proof, this.now);
      if (!attempt) { await wait('draining', 'setup_abort_child_pending'); return; }
      flat = true;
      const context = await this.returns.contextRead(row.userId, row.accountId!, true), account = context.account;
      // The flat observation the POST relies on: at most 5 s old when it leaves.
      let proven = proof;
      const fresh = () => { const at = this.now(), observedAt = proven.snapshot.observedAt; if (!Number.isSafeInteger(at) || at < observedAt || at >= observedAt + 5000) throw new Error('stale'); };
      let dispatched = false, retryMs = 30_000;
      try {
        const signature = await this.signer.sign({ walletId: account.privyWalletId!, address: attempt.address, ownerQuorumId: account.ownerQuorumId!,
          workerQuorumId: account.masterSignerQuorumId!, policyId: account.masterPolicyId! }, usdSendTypedData(WALLET_NETWORKS[row.network], attempt.destination, attempt.amount, attempt.nonce),
          { network: row.network, destination: row.destination }, this.now() + 30_000);
        // A proof aged past REPROVE_AFTER_MS by Privy's signing is observed again and rechecked under the lease.
        if (this.now() - proven.snapshot.observedAt > REPROVE_AFTER_MS) {
          proven = await this.observer.observeSetupAbortFlat(row.accountAddress!);
          if (!await this.refunds.reprove(row, attempt, proven, this.now)) throw new Error('setup_abort_reproof_refused');
        }
        fresh();
        const reply = await this.exchange.send(attempt, signature, fresh, () => { dispatched = true; });
        if (reply && typeof reply === 'object' && 'status' in reply && 'response' in reply) {
          if (reply.status === 'ok' && reply.response && typeof reply.response === 'object' && 'type' in reply.response && reply.response.type === 'default')
            await this.returns.finish(row.userId, attempt.id, 'accepted', digest(reply));
          else if (reply.status === 'err' && typeof reply.response === 'string' && reply.response && !/nonce/i.test(reply.response))
            await this.returns.finish(row.userId, attempt.id, 'rejected', digest(reply));
        }
      } catch (error) {
        // Never dispatched: same refund and nonce back to prepared, retried after a back-off.
        // Possibly sent: retained and reconciled.
        const restored = !dispatched && await this.refunds.restoreNotDispatched(row, attempt);
        if (restored) retryMs = NOT_DISPATCHED_RETRY_MS;
        this.logger.warn(`setup abort ${row.id} original refund ${restored ? 'not sent, kept prepared' : 'retained'} ${JSON.stringify(errorLogFields(error))}`);
      }
      row = await this.repository.find(row.userId, row.id);
      await wait('returning', 'setup_abort_refund_pending', retryMs);
    } catch (error) {
      // The error's own code, else EVIDENCE_UNAVAILABLE; classified so only permanent/needs_owner block.
      const classified = classify(error);
      await settle(classified, (classified.source === 'unknown' || classified.source === 'message' ? null : issue(classified.code)) ?? EVIDENCE_UNAVAILABLE);
      this.logger.warn(`setup abort ${row.id} kept for recovery ${JSON.stringify(errorLogFields(error))}`);
    } finally { await this.repository.release(originalLease); }
  }
}
