import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { liveCopySetupAbortSchema, requestLiveCopySetupAbortSchema, usdSendTypedData, WALLET_NETWORKS, type LiveCopySetupAbort } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { BackgroundJobs } from '../runtime/background-jobs.service.js';
import { errorLogFields } from '../runtime/safe-error-text.js';
import { CopyLiveSetupAbortRepository, type SetupAbortRow } from './copy-live-setup-abort.repository.js';
import { CopyLiveSetupAbortReturnRepository } from './copy-live-setup-abort-return.repository.js';
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
import type { DbTransaction } from '../db/unit-of-work.js';

export const SETUP_ABORT_OBSERVER = Symbol('SETUP_ABORT_OBSERVER');
export interface SetupAbortObserver { observeSetupAbortFlat(address: string): Promise<SetupAbortFlatObservation> }
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const issue = (value: string | null) => value && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : null;
/** A flat proof older than this when the refund is signed is taken again. */
const REPROVE_AFTER_MS = 2_500;
/** A refund that never left is tried again no sooner than this. */
const NOT_DISPATCHED_RETRY_MS = 120_000;
const states = { requested: 'requested', draining: 'reconciling', waiting_credit: 'reconciling', proving: 'reconciling', returning: 'refunding',
  delegated: 'delegated', blocked: 'blocked', done: 'completed' } as const;

/** Requests establish durable authority only. Provider reads/signing run in
 * tracked worker jobs; restart resumes the same original children and refund. */
@Injectable()
export class CopyLiveSetupAbortService {
  private readonly logger = new Logger(CopyLiveSetupAbortService.name);
  private readonly running = new Set<string>();
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
  /** The owner's cancel of a confirmed setup still awaiting its deposit's
   * credit (CopyLiveSetupService.cancel): the same durable authority as
   * request, admitted inside the caller's transaction. */
  async requestIn(tx: DbTransaction, userId: number, setupId: string, key: string): Promise<SetupAbortRow> {
    if (!this.available) throw new ServiceUnavailableException({ statusCode: 503, code: 'setup_abort_unavailable', message: 'Cancelling a confirmed setup is not available right now' });
    return this.repository.admit(tx, userId, setupId, key, this.now);
  }
  async get(userId: number, setupId: string) { await this.setups.owner(userId); return this.wire(await this.repository.forSetup(userId, setupId)); }
  async wire(row: SetupAbortRow): Promise<LiveCopySetupAbort> {
    const children = await this.repository.children(row), deposit = children.funding.find(op => op.id === row.fundingOperationId),
      refund = children.funding.find(op => op.id === row.returnOperationId || row.stopId !== null && op.stopId === row.stopId && op.direction === 'to_main' && !sweepSuperseded(op, children.funding));
    // Old parents may have finished when the stop accepted its sweep. Preserve
    // the original funding outcome instead of presenting acceptance as credit.
    const pendingRefund = row.state === 'done' && refund && refund.status !== 'credited';
    const rejectedRefund = pendingRefund && ['rejected', 'cancelled'].includes(refund.status);
    return liveCopySetupAbortSchema.parse({ id: row.id, setupId: row.setupId, strategyId: row.strategyId, accountId: row.accountId, kind: row.kind, network: row.network,
      state: pendingRefund ? rejectedRefund ? 'blocked' : 'delegated' : states[row.state],
      issue: pendingRefund ? rejectedRefund ? 'setup_abort_refund_not_completed' : 'setup_abort_refund_pending' : issue(row.issue), deposit: deposit ? { ...fundingWire(deposit), direction: deposit.direction } : null,
      refund: refund ? { ...fundingWire(refund), direction: refund.direction } : null,
      stop: children.stop ? { id: children.stop.id, state: children.stop.state, issue: issue(children.stop.issue) } : null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
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
  /** A child's reconcile that failed is looked at again on the next pass:
   * the log says why (it used to be dropped). */
  private kept(abortId: string, child: string, childId: string) {
    return (error: unknown) => { this.logger.warn(`setup abort ${abortId} ${child} ${childId} reconcile kept for the next pass ${JSON.stringify(errorLogFields(error))}`); };
  }
  /** Worker pass only; never called from an HTTP mutation. */
  async process(id: string) {
    let row = await this.repository.lease(id); if (!row) return;
    const originalLease = row;
    const wait = async (state: SetupAbortRow['state'], reason: string | null, delayMs = 30_000) => {
      const next = await this.repository.transition(row!, { state, issue: reason, nextAttemptAt: new Date(this.now() + delayMs) });
      if (next) row = next;
    };
    try {
      let children = await this.repository.children(row);
      if (row.stopId) {
        if (!children.stop || children.stop.mandateId !== row.mandateId || children.stop.accountId !== row.accountId || children.stop.network !== row.network) {
          await wait('blocked', 'setup_abort_generation_conflict'); return;
        }
        const deposit = children.funding.find(op => op.id === row!.fundingOperationId);
        // An automatic return never sent is superseded by its next attempt, or retried.
        const returns = children.funding.filter(op => op.stopId === row!.stopId && op.direction === 'to_main' && !sweepSuperseded(op, children.funding));
        if (returns.some(op => ['rejected', 'cancelled'].includes(op.status) && !sweepRetrying(op))) { await wait('blocked', 'setup_abort_refund_not_completed'); return; }
        if (returns.some(op => op.status !== 'credited')) { await wait('delegated', 'setup_abort_refund_pending'); return; }
        if (children.stop.state === 'stopped' && (!deposit || !['prepared','unknown','accepted'].includes(deposit.status))) await wait('done', null);
        else await wait('delegated', issue(children.stop.issue));
        return;
      }
      // Cancel only children that provably never crossed their attempt
      // boundary. An attempted original deposit/return is ledger-read only.
      for (const op of children.funding) {
        if (op.setupAbortId === row.id) continue;
        if (op.direction !== 'to_account' || op.network !== row.network || op.strategyId !== row.strategyId) { await wait('blocked', 'setup_abort_binding_unknown'); return; }
        if (!op.attemptedAt && ['prepared','unknown'].includes(op.status)) await this.fundingRows.cancel(row.userId, op.id);
        else if (op.attemptedAt && ['unknown','accepted'].includes(op.status)) await this.funding.reconcile(row.userId, op.id).catch(this.kept(row.id, 'funding', op.id));
      }
      // Seal only ordinary reservations that never crossed the SDK boundary;
      // attempted transfers retain their original receipt and reconcile only.
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
      if (deposit && ['prepared','unknown','accepted'].includes(deposit.status)) { await wait('waiting_credit', 'setup_abort_deposit_pending'); return; }
      if (!row.accountId || !row.accountAddress || !deposit) { await wait('blocked', 'setup_abort_binding_unknown'); return; }
      let refund: ReturnRow | null | undefined = children.funding.find(op => op.id === row!.returnOperationId);
      if (refund && ['unknown','accepted'].includes(refund.status)) {
        await this.funding.reconcile(row.userId, refund.id).catch(this.kept(row.id, 'refund', refund.id));
        refund = await this.returns.find(row.userId, refund.id);
        if (['unknown','accepted'].includes(refund.status)) { await wait('returning', 'setup_abort_refund_pending'); return; }
      }
      if (refund && ['rejected','cancelled'].includes(refund.status)) { await wait('blocked', 'setup_abort_refund_not_completed'); return; }
      // Pay local attempt weight before the evidence clock. The global
      // transport still rechecks its own quota and this <=5s proof at POST.
      await this.exchange.acquire();
      const originalPrepared = refund?.status === 'prepared' && refund.attemptedAt === null;
      if (!originalPrepared) {
        const reservationProof = await this.observer.observeSetupAbortFlat(row.accountAddress);
        if (await this.refunds.complete(row, reservationProof, this.now)) return;
        if (refund?.status === 'credited') { await wait('blocked', 'setup_abort_residual_balance'); return; }
        if (!this.available) { await wait('blocked', 'setup_abort_unavailable'); return; }
        refund = await this.refunds.reserve(row, reservationProof, this.now);
      } else if (!this.available) { await wait('blocked', 'setup_abort_unavailable'); return; }
      if (!refund) { await wait('draining', 'setup_abort_child_pending'); return; }
      row = await this.repository.find(row.userId, row.id);
      if (refund.status !== 'prepared') { await wait('returning', 'setup_abort_refund_pending'); return; }
      // A stored unattempted original refund cannot complete yet, and reserve
      // would return that same child. Read once for its locked begin instead
      // of spending another full proof on every retry. A new reservation still
      // gets this independent post-lock proof; no earlier clock is reused.
      const proof = await this.observer.observeSetupAbortFlat(row.accountAddress!);
      const attempt = await this.refunds.begin(row, refund.id, proof, this.now);
      if (!attempt) { await wait('draining', 'setup_abort_child_pending'); return; }
      const context = await this.returns.contextRead(row.userId, row.accountId!, true), account = context.account;
      // The flat observation the POST relies on: at most 5 s old when it leaves.
      let proven = proof;
      const fresh = () => { const at = this.now(), observedAt = proven.snapshot.observedAt; if (!Number.isSafeInteger(at) || at < observedAt || at >= observedAt + 5000) throw new Error('stale'); };
      let dispatched = false, retryMs = 30_000;
      try {
        const signature = await this.signer.sign({ walletId: account.privyWalletId!, address: attempt.address, ownerQuorumId: account.ownerQuorumId!,
          workerQuorumId: account.masterSignerQuorumId!, policyId: account.masterPolicyId! }, usdSendTypedData(WALLET_NETWORKS[row.network], attempt.destination, attempt.amount, attempt.nonce),
          { network: row.network, destination: row.destination }, this.now() + 30_000);
        // Privy's signing time is not taken from the observation's 5 s: a
        // proof past half its window is observed again and checked under the
        // lease (as begin checked the first) before the POST.
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
        // Never handed to the exchange (not signed, a stale or refused proof,
        // the meter): the same refund and nonce go back to prepared and are
        // tried again after a back-off. Possibly sent: retained, reconciled.
        const restored = !dispatched && await this.refunds.restoreNotDispatched(row, attempt);
        if (restored) retryMs = NOT_DISPATCHED_RETRY_MS;
        this.logger.warn(`setup abort ${row.id} original refund ${restored ? 'not sent, kept prepared' : 'retained'} ${JSON.stringify(errorLogFields(error))}`);
      }
      row = await this.repository.find(row.userId, row.id);
      await wait('returning', 'setup_abort_refund_pending', retryMs);
    } catch (error) {
      const code = error instanceof ConflictException ? error.getResponse() : null;
      const reason = code && typeof code === 'object' && 'code' in code && typeof code.code === 'string' ? issue(code.code) : null;
      await wait('blocked', reason ?? 'setup_abort_evidence_unavailable');
      this.logger.warn(`setup abort ${row.id} kept for recovery ${JSON.stringify(errorLogFields(error))}`);
    } finally { await this.repository.release(originalLease); }
  }
}
