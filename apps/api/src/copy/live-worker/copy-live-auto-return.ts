import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { WALLET_NETWORKS, canonicalUsdc, usdSendTypedData, withdrawalUnits, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { Dec } from '../../common/decimal/dec.js';
import { safeErrorText } from '../../runtime/safe-error-text.js';
import type { CopyFundingExchangeClient } from '../copy-funding-exchange.client.js';
import type { CopyLiveReturnRepository } from '../copy-live-return.repository.js';
import type { WorkerMasterSigner } from '../live/privy-policy-master-signer.js';
import type { StopRow } from './copy-live-stop-worker.repository.js';

/** What the automatic return did on this pass. `legacy`: the account has no
 * master signer (the owner returns the funds); `waiting`: another wallet
 * operation goes first; `sent`: the exchange accepted the sweep (the funding
 * monitor confirms the credit, then the stop ends); `unknown`: it was sent
 * but its answer was lost, so it is confirmed from the main wallet's ledger
 * and never resent; `failed`: it was not sent (not signed, refused before
 * the POST, or refused by the exchange): the owner's return remains. */
export type AutoReturnOutcome = 'legacy' | 'waiting' | 'sent' | 'unknown' | 'failed';
export interface AutoReturn { sweep(stop: StopRow, withdrawable: string): Promise<AutoReturnOutcome> }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The automatic return after a flat stop (one-click plan §3c): a UsdSend of
 * everything withdrawable (floored to 6 decimals) from the copy account to
 * the owner's main wallet, signed by the worker quorum under the owner's
 * Privy policy, once per stop (`sweep:<stop id>`), never resent.
 */
export class CopyLiveAutoReturn implements AutoReturn {
  private readonly logger = new Logger('CopyLiveAutoReturn');
  constructor(private readonly network: HyperliquidNetwork, private readonly returns: CopyLiveReturnRepository, private readonly exchange: CopyFundingExchangeClient,
    private readonly signer: WorkerMasterSigner, private readonly now: () => number = Date.now) {}

  async sweep(stop: StopRow, withdrawable: string): Promise<AutoReturnOutcome> {
    // The system's context: an owner an admin disabled still gets the funds back.
    const { owner, account } = await this.returns.contextRead(stop.userId, stop.accountId, true);
    // A signer taken off again (account deletion) returns by hand, like a legacy account.
    if (!account.masterPolicyId || !account.masterSignerQuorumId || account.signerDetachedAt || !account.sweepDestination) return 'legacy';
    // An account of another network (a database that moved networks) is
    // history: nothing on it is signed or sent from this deployment.
    if (account.network !== this.network) return 'failed';
    // The policy allows only the main wallet it was made for: a changed main
    // wallet fails closed, and the owner returns the funds by hand.
    if (!this.signer.available || account.sweepDestination !== owner.embeddedWalletAddress) return 'failed';
    const free = Dec.from(withdrawable).floor(6);
    if (!free.isPositive) return 'waiting';
    const row = await this.returns.reserveSystem(stop, canonicalUsdc(withdrawalUnits(free.toString())));
    if (!row) return 'waiting';
    if (row.status === 'rejected' || row.status === 'cancelled') return 'failed';
    if (row.status === 'unknown') return 'unknown';
    if (row.status !== 'prepared') return 'sent';
    const attempt = await this.returns.begin(stop.userId, row.id, true);
    // Another pass holds it (claimed and in flight): its outcome is not known here.
    if (!attempt) return 'unknown';
    const checkedAt = this.now();
    let signature: string;
    try {
      signature = await this.signer.sign({ walletId: account.privyWalletId!, address: attempt.address, ownerQuorumId: account.ownerQuorumId!, workerQuorumId: account.masterSignerQuorumId, policyId: account.masterPolicyId },
        usdSendTypedData(WALLET_NETWORKS[this.network], attempt.destination, attempt.amount, attempt.nonce), { network: this.network, destination: account.sweepDestination }, checkedAt + 30_000);
    } catch (error) {
      // Not signed: the exchange cannot have it.
      this.logger.warn(`sweep ${row.id} not signed: ${safeErrorText(error)}`);
      await this.returns.finish(stop.userId, row.id, 'rejected', digest({ reason: 'worker_signature_unavailable', id: row.id }));
      return 'failed';
    }
    // The send's last check, after the quota permit (the client checks the
    // permit first): once it passed, only the POST follows, so the sweep may
    // have reached the exchange. A permit refused before it is not sent.
    let dispatched = false;
    const fresh = () => { const at = this.now(); if (!Number.isSafeInteger(at) || at - checkedAt > 30_000) throw new Error('stale'); dispatched = true; };
    let reply: unknown;
    try { reply = await this.exchange.send(attempt, signature, fresh); }
    catch (error) {
      if (!dispatched) {
        // Refused before the POST (a stale proof, the meter): nothing left this process.
        this.logger.warn(`sweep ${row.id} not sent: ${safeErrorText(error)}`);
        await this.returns.finish(stop.userId, row.id, 'rejected', digest({ reason: 'sweep_not_dispatched', id: row.id }));
        return 'failed';
      }
      // Possibly sent: confirmed from the main wallet's ledger, never resent.
      this.logger.warn(`sweep ${row.id} outcome unknown: ${safeErrorText(error)}`);
      return 'unknown';
    }
    if (reply && typeof reply === 'object' && 'status' in reply && 'response' in reply) {
      if (reply.status === 'ok' && reply.response && typeof reply.response === 'object' && 'type' in reply.response && reply.response.type === 'default') {
        await this.returns.finish(stop.userId, row.id, 'accepted', digest(reply)); return 'sent';
      }
      if (reply.status === 'err' && typeof reply.response === 'string' && reply.response && !/nonce/i.test(reply.response)) {
        await this.returns.finish(stop.userId, row.id, 'rejected', digest(reply)); return 'failed';
      }
    }
    // An answer that is neither: the outcome is not known.
    return 'unknown';
  }
}
