import { Logger } from '@nestjs/common';
import { WALLET_NETWORKS, canonicalUsdc, usdSendTypedData, withdrawalUnits, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { Dec } from '../../common/decimal/dec.js';
import { safeErrorText } from '../../runtime/safe-error-text.js';
import type { CopyFundingExchangeClient } from '../copy-funding-exchange.client.js';
import { sweepNotSentEvidence, sweepRetrying, type CopyLiveReturnRepository } from '../copy-live-return.repository.js';
import type { WorkerMasterSigner } from '../live/privy-policy-master-signer.js';
import type { StopRow } from './copy-live-stop-worker.repository.js';
import { jsonDigest as digest } from '../../common/crypto/digest.js';

/** `legacy`: no master signer (owner returns funds). `waiting`: nothing to send
 * yet, another operation first, or an unsent attempt with attempts left.
 * `sent`: accepted (funding monitor confirms). `unknown`: answer lost; confirmed
 * from the ledger, never resent. `failed`: refused, or unsent on the last
 * attempt (SYSTEM_SWEEP_ATTEMPTS); the owner returns funds. */
type AutoReturnOutcome = 'legacy' | 'waiting' | 'sent' | 'unknown' | 'failed';
export interface AutoReturn { sweep(stop: StopRow, withdrawable: string): Promise<AutoReturnOutcome> }

/**
 * Automatic return after a flat stop: UsdSend of all withdrawable (floored to 6
 * dp) to the owner's main wallet, signed by the worker quorum under the owner's
 * Privy policy. Once per stop, never resent; a new nonce only after an attempt
 * that provably never left.
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
    // Another network's account is history: nothing is signed or sent.
    if (account.network !== this.network) return 'failed';
    // The policy allows only its original main wallet: a changed one fails closed.
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
      // Not signed: the exchange cannot have it (another attempt follows its back-off).
      this.logger.warn(`sweep ${row.id} not signed: ${safeErrorText(error)}`);
      return sweepRetrying(await this.returns.finish(stop.userId, row.id, 'rejected', sweepNotSentEvidence('worker_signature_unavailable', row.id))) ? 'waiting' : 'failed';
    }
    // `dispatched` flips right before the POST: from then on the sweep may have
    // reached the exchange; a refusal before it was not sent.
    let dispatched = false;
    const fresh = () => { const at = this.now(); if (!Number.isSafeInteger(at) || at - checkedAt > 30_000) throw new Error('stale'); };
    let reply: unknown;
    try { reply = await this.exchange.send(attempt, signature, fresh, () => { dispatched = true; }); }
    catch (error) {
      if (!dispatched) {
        // Refused before the POST (a stale proof, the meter): nothing left this process.
        this.logger.warn(`sweep ${row.id} not sent: ${safeErrorText(error)}`);
        return sweepRetrying(await this.returns.finish(stop.userId, row.id, 'rejected', sweepNotSentEvidence('sweep_not_dispatched', row.id))) ? 'waiting' : 'failed';
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
