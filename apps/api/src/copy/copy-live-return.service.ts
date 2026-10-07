import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { approveCopyReturnSchema, canonicalUsdc, copyReturnChallengeSchema, copyReturnInputSchema, usdSendTypedData, WALLET_NETWORKS, withdrawalUnits } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { Dec } from '../common/decimal/dec.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import { CopyFundingExchangeClient } from './copy-funding-exchange.client.js';
import { wire } from './copy-funding.service.js';
import { builderOutcome, CopyLiveReturnRepository, RETURN_CONSENT_WINDOW_MS, type BuilderApprovalRow } from './copy-live-return.repository.js';
import { WORKER_MASTER_SIGNER, type WorkerMasterSigner } from './live/privy-policy-master-signer.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid request');
  return structuredClone(parsed.data);
}

/**
 * USDC back from a copy's account (on the deployment's network) to the owner's main wallet (idle
 * funds while copying, or everything once its stop is flat). The account is
 * a wallet the owner alone owns; every return is signed by the worker under
 * the owner's Privy policy, which allows a UsdSend to the owner's main
 * wallet only (the one signing model, 2026-10-07): the browser signs
 * nothing. An account without the worker signer (a legacy account) turns on
 * the automatic return first (its browser adds the signer). One attempt
 * only; credit is confirmed from the main wallet's ledger by the funding
 * monitor; uncertainty is never resent.
 */
@Injectable()
export class CopyLiveReturnService {
  private readonly logger = new Logger(CopyLiveReturnService.name);
  constructor(private readonly config: AppConfig, private readonly repository: CopyLiveReturnRepository, private readonly exchange: CopyFundingExchangeClient,
    @Optional() private readonly now: () => number = Date.now,
    @Optional() @Inject(WORKER_MASTER_SIGNER) private readonly workerSigner: WorkerMasterSigner | null = null) {}
  private assertAvailable() {
    // The account itself must be of the deployment's network (the repository's context).
    if (this.config.value.copy.mode === 'disabled') throw new ServiceUnavailableException('Account returns are unavailable on this deployment');
  }

  async reserve(userId: number, accountId: string, body: unknown) {
    this.assertAvailable();
    const request = input(copyReturnInputSchema, body), sweep = request.amount === 'all';
    let amount = request.amount;
    if (sweep) {
      const context = await this.contextOf(userId, accountId);
      const free = Dec.from(await this.exchange.withdrawable(context.account.network, context.account.address!)).floor(6);
      if (!free.isPositive) throw new ConflictException({ statusCode: 409, code: 'no_free_collateral', message: 'Nothing to return' });
      amount = canonicalUsdc(withdrawalUnits(free.toString()));
    }
    const row = await this.repository.reserve(userId, accountId, { idempotencyKey: request.idempotencyKey, amount, sweep });
    return copyReturnChallengeSchema.parse({ operation: wire(row) });
  }
  private contextOf(userId: number, accountId: string) { return this.repository.contextRead(userId, accountId); }

  /** Sends the prepared return, signed by the worker (no body). */
  async approve(userId: number, id: string, body: unknown) {
    this.assertAvailable();
    input(approveCopyReturnSchema, body ?? {});
    const row = await this.repository.find(userId, id), now = this.now(), consentExpiresAt = row.createdAt.getTime() + RETURN_CONSENT_WINDOW_MS;
    if (row.status !== 'prepared') return wire(row);
    if (now >= consentExpiresAt) throw new ConflictException({ statusCode: 409, code: 'consent_expired', message: 'Prepare the return again' });
    const context = await this.contextOf(userId, row.accountId), account = context.account;
    // The worker's policy allows nothing but the main wallet it was made for.
    if (!account.masterPolicyId || !account.masterSignerQuorumId || account.signerDetachedAt || !account.sweepDestination || !this.workerSigner?.available)
      throw new ConflictException({ statusCode: 409, code: 'worker_signer_missing', message: 'Turn on the automatic return for this copy first: Orbie needs to add its signer to return the funds.' });
    if (account.sweepDestination !== context.owner.embeddedWalletAddress || row.destination !== account.sweepDestination)
      throw new ConflictException({ statusCode: 409, code: 'setup_wallet_conflict', message: 'Your main wallet changed since this copy started' });
    if (!Dec.from(await this.exchange.withdrawable(row.network, row.address)).gte(row.amount)) throw new ConflictException({ statusCode: 409, code: 'no_free_collateral', message: 'Not enough transferable USDC' });
    const checkedAt = this.now();
    const fresh = () => { const at = this.now(); if (!Number.isSafeInteger(at) || at - checkedAt > 5000 || at >= consentExpiresAt) throw new Error('stale'); };
    const attempt = await this.repository.begin(userId, id);
    if (!attempt) return wire(await this.repository.find(userId, id));
    let signature: string;
    try {
      signature = await this.workerSigner.sign({ walletId: account.privyWalletId!, address: row.address, ownerQuorumId: account.ownerQuorumId!, workerQuorumId: account.masterSignerQuorumId, policyId: account.masterPolicyId },
        usdSendTypedData(WALLET_NETWORKS[row.network], row.destination, row.amount, row.nonce), { network: row.network, destination: account.sweepDestination }, consentExpiresAt);
    } catch (error) {
      // Not signed: the exchange cannot have it. Definitely not sent.
      this.logger.warn(`return ${id} not signed: ${safeErrorText(error)}`);
      return wire(await this.repository.finish(userId, id, 'rejected', digest({ reason: 'master_signature_unavailable', id })));
    }
    let reply: unknown;
    try { reply = await this.exchange.send(attempt, signature, fresh); }
    catch (error) {
      // Its outcome is unknown: confirmed from the main wallet's ledger, never resent.
      this.logger.warn(`return ${id} outcome unknown: ${safeErrorText(error)}`);
      return wire(await this.repository.find(userId, id));
    }
    return wire(await this.settle(userId, id, reply));
  }
  private async settle(userId: number, id: string, reply: unknown) {
    if (reply && typeof reply === 'object' && 'status' in reply && 'response' in reply) {
      if (reply.status === 'ok' && reply.response && typeof reply.response === 'object' && 'type' in reply.response && reply.response.type === 'default') return this.repository.finish(userId, id, 'accepted', digest(reply));
      if (reply.status === 'err' && typeof reply.response === 'string' && reply.response && !/nonce/i.test(reply.response)) return this.repository.finish(userId, id, 'rejected', digest(reply));
    }
    return this.repository.find(userId, id);
  }

  // --- builder fee approval (signed by the setup driver's worker) -------------
  private builderWire(row: BuilderApprovalRow) {
    return { id: row.id, accountId: row.accountId, state: row.state, builderAddress: row.builderAddress, maxFeeTenthsBps: row.maxFeeTenthsBps,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
  /** Approved once the exchange reports a maximum fee covering the rate;
   * rejected once its nonce has expired with no such fee (builderOutcome). */
  private async observeBuilder(userId: number, row: BuilderApprovalRow): Promise<BuilderApprovalRow> {
    if (!['unknown', 'accepted'].includes(row.state)) return row;
    try {
      const readAt = this.now();
      const cap = await this.exchange.maxBuilderFee(row.network, row.accountAddress, row.builderAddress);
      const outcome = builderOutcome(row, cap, readAt);
      if (outcome === 'approved') return this.repository.finishBuilder(userId, row.id, 'approved', digest({ cap, checkedAt: this.now() }));
      if (outcome === 'rejected') return this.repository.finishBuilder(userId, row.id, 'rejected', digest({ reason: 'not_executed', cap, checkedAt: readAt }));
    } catch (error) { this.logger.warn(`builder approval ${row.id} not read (stays pending): ${safeErrorText(error)}`); }
    return row;
  }
  async reconcileBuilder(userId: number, id: string) { return this.builderWire(await this.observeBuilder(userId, await this.repository.builder(userId, id))); }
}
