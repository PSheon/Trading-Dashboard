import { createHash } from 'node:crypto';
import { WALLET_NETWORKS, canonicalUsdc, usdSendTypedData, withdrawalUnits } from '@trading-dashboard/shared/contracts';
import { Dec } from '../../common/decimal/dec.js';
import type { CopyFundingExchangeClient } from '../copy-funding-exchange.client.js';
import type { CopyLiveReturnRepository } from '../copy-live-return.repository.js';
import type { WorkerMasterSigner } from '../live/privy-policy-master-signer.js';
import type { StopRow } from './copy-live-stop-worker.repository.js';

/** What the automatic return did on this pass. `legacy`: the account has no
 * master signer (the owner returns the funds); `waiting`: another wallet
 * operation goes first; `sent`: the sweep is attempted or in flight (the
 * funding monitor confirms the credit, then the stop ends); `failed`: it
 * could not be signed or the exchange refused it (the owner's manual return
 * remains). */
export type AutoReturnOutcome = 'legacy' | 'waiting' | 'sent' | 'failed';
export interface AutoReturn { sweep(stop: StopRow, withdrawable: string): Promise<AutoReturnOutcome> }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The automatic return after a flat stop (one-click plan §3c): a UsdSend of
 * everything withdrawable (floored to 6 decimals) from the copy account to
 * the owner's main wallet, signed by the worker quorum under the owner's
 * Privy policy, once per stop (`sweep:<stop id>`), never resent.
 */
export class CopyLiveAutoReturn implements AutoReturn {
  constructor(private readonly returns: CopyLiveReturnRepository, private readonly exchange: CopyFundingExchangeClient,
    private readonly signer: WorkerMasterSigner, private readonly now: () => number = Date.now) {}

  async sweep(stop: StopRow, withdrawable: string): Promise<AutoReturnOutcome> {
    const { owner, account } = await this.returns.contextRead(stop.userId, stop.accountId);
    if (!account.masterPolicyId || !account.masterSignerQuorumId || !account.sweepDestination) return 'legacy';
    // The policy allows only the main wallet it was made for: a changed main
    // wallet fails closed, and the owner returns the funds by hand.
    if (!this.signer.available || account.sweepDestination !== owner.embeddedWalletAddress) return 'failed';
    const free = Dec.from(withdrawable).floor(6);
    if (!free.isPositive) return 'waiting';
    const row = await this.returns.reserveSystem(stop, canonicalUsdc(withdrawalUnits(free.toString())));
    if (!row) return 'waiting';
    if (row.status === 'rejected' || row.status === 'cancelled') return 'failed';
    if (row.status !== 'prepared') return 'sent';
    const attempt = await this.returns.begin(stop.userId, row.id);
    if (!attempt) return 'sent';
    const checkedAt = this.now();
    let signature: string;
    try {
      signature = await this.signer.sign({ walletId: account.privyWalletId!, address: attempt.address, ownerQuorumId: account.ownerQuorumId!, workerQuorumId: account.masterSignerQuorumId, policyId: account.masterPolicyId },
        usdSendTypedData(WALLET_NETWORKS.testnet, attempt.destination, attempt.amount, attempt.nonce), { network: 'testnet', destination: account.sweepDestination }, checkedAt + 30_000);
    } catch {
      // Not signed: the exchange cannot have it.
      await this.returns.finish(stop.userId, row.id, 'rejected', digest({ reason: 'worker_signature_unavailable', id: row.id }));
      return 'failed';
    }
    const fresh = () => { const at = this.now(); if (!Number.isSafeInteger(at) || at - checkedAt > 30_000) throw new Error('stale'); };
    let reply: unknown;
    try { reply = await this.exchange.send(attempt, signature, fresh); } catch { return 'sent'; }
    if (reply && typeof reply === 'object' && 'status' in reply && 'response' in reply) {
      if (reply.status === 'ok' && reply.response && typeof reply.response === 'object' && 'type' in reply.response && reply.response.type === 'default') {
        await this.returns.finish(stop.userId, row.id, 'accepted', digest(reply)); return 'sent';
      }
      if (reply.status === 'err' && typeof reply.response === 'string' && reply.response && !/nonce/i.test(reply.response)) {
        await this.returns.finish(stop.userId, row.id, 'rejected', digest(reply)); return 'failed';
      }
    }
    return 'sent';
  }
}
