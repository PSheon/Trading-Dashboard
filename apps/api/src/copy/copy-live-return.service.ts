import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { verifyTypedData } from 'viem';
import { z } from 'zod';
import { approveBuilderFeeRequest, approveBuilderFeeTypedData, approveCopyMasterActionSchema, approveCopyReturnSchema, canonicalUsdc, copyBuilderChallengeSchema, copyBuilderConsentTypedData,
  copyReturnChallengeSchema, copyReturnConsentTypedData, copyReturnInputSchema, usdSendTypedData, WALLET_NETWORKS, withdrawalUnits } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { Dec } from '../common/decimal/dec.js';
import { CopyFundingExchangeClient } from './copy-funding-exchange.client.js';
import { wire } from './copy-funding.service.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import { CopyLiveReturnRepository, RETURN_CONSENT_WINDOW_MS, type BuilderApprovalRow, type ReturnRow } from './copy-live-return.repository.js';
import { masterActionRequest, masterSignatureRefusal, type MasterActionBound, type MasterTypedData } from './live/master-action.js';
import { WORKER_MASTER_SIGNER, type WorkerMasterSigner } from './live/privy-policy-master-signer.js';

const CONSENT_WINDOW_MS = RETURN_CONSENT_WINDOW_MS;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid request');
  return structuredClone(parsed.data);
}

/**
 * USDC back from a copy's testnet account to the owner's main wallet (idle
 * funds while copying, or everything once its stop is flat), and the
 * account's builder fee approval. The account is a wallet the owner alone
 * owns, so each action carries the owner's consent (the main wallet signs
 * the exact operation) and the copy account's own signature of exactly the
 * action, made in the owner's browser; one attempt only. Without a consent
 * only an account with the automatic return: the worker signs under the
 * owner's policy. Credit is confirmed from the main
 * wallet's ledger by the funding monitor; uncertainty is never resent.
 */
@Injectable()
export class CopyLiveReturnService {
  constructor(private readonly config: AppConfig, private readonly repository: CopyLiveReturnRepository, private readonly exchange: CopyFundingExchangeClient,
    private readonly mandates: CopyLiveMandateRepository,
    @Optional() private readonly now: () => number = Date.now,
    /** Signs as an account with the automatic return (no owner consent needed). */
    @Optional() @Inject(WORKER_MASTER_SIGNER) private readonly workerSigner: WorkerMasterSigner | null = null) {}
  private assertAvailable() {
    if (this.config.value.hyperliquid.wallet.network !== 'testnet' || this.config.value.copy.mode === 'disabled') throw new ServiceUnavailableException('Account returns are available on testnet only');
  }
  private returnAction(row: ReturnRow) {
    const typed = usdSendTypedData(WALLET_NETWORKS.testnet, row.destination, row.amount, row.nonce) as unknown as MasterTypedData;
    return { typed, bound: { network: 'testnet', destination: row.destination } satisfies MasterActionBound };
  }
  /** The copy account's own UsdSend for the owner's browser to sign. */
  private returnRequest(row: ReturnRow) {
    if (row.status !== 'prepared') return null;
    const { typed, bound } = this.returnAction(row);
    return masterActionRequest(row.address, typed, bound, this.consent(row).consentExpiresAt);
  }
  private consent(row: ReturnRow) {
    return { operationId: row.id, network: 'testnet' as const, account: row.address, destination: row.destination, amount: row.amount, nonce: row.nonce,
      consentExpiresAt: row.createdAt.getTime() + CONSENT_WINDOW_MS };
  }

  async reserve(userId: number, accountId: string, body: unknown) {
    this.assertAvailable();
    const request = input(copyReturnInputSchema, body), sweep = request.amount === 'all';
    let amount = request.amount;
    if (sweep) {
      const context = await this.contextOf(userId, accountId);
      const free = Dec.from(await this.exchange.withdrawable('testnet', context.account.address!)).floor(6);
      if (!free.isPositive) throw new ConflictException({ statusCode: 409, code: 'no_free_collateral', message: 'Nothing to return' });
      amount = canonicalUsdc(withdrawalUnits(free.toString()));
    }
    const row = await this.repository.reserve(userId, accountId, { idempotencyKey: request.idempotencyKey, amount, sweep });
    return copyReturnChallengeSchema.parse({ operation: wire(row), consent: this.consent(row), masterAction: this.returnRequest(row) });
  }
  private contextOf(userId: number, accountId: string) { return this.repository.contextRead(userId, accountId); }

  async approve(userId: number, id: string, body: unknown) {
    this.assertAvailable();
    const { consentSignature, masterSignature } = input(approveCopyReturnSchema, body);
    const row = await this.repository.find(userId, id), consent = this.consent(row), now = this.now();
    if (row.status !== 'prepared') return wire(row);
    if (now >= consent.consentExpiresAt) throw new ConflictException({ statusCode: 409, code: 'consent_expired', message: 'Prepare the return again' });
    const context = await this.contextOf(userId, row.accountId);
    // Without a consent only an account with the automatic return: its worker
    // signer's policy allows nothing but this destination (Paul's decision 3).
    const account = context.account;
    const automatic = consentSignature === undefined;
    if (automatic) {
      if (!account.masterPolicyId || !account.masterSignerQuorumId || account.signerDetachedAt || !account.sweepDestination || account.sweepDestination !== context.owner.embeddedWalletAddress ||
        row.destination !== account.sweepDestination || !this.workerSigner?.available) throw new ForbiddenException({ statusCode: 403, code: 'invalid_consent', message: 'Sign the return with your main wallet' });
    } else {
      let valid = false;
      try { valid = await verifyTypedData({ address: row.destination as `0x${string}`, ...copyReturnConsentTypedData(consent), signature: consentSignature as `0x${string}` }); } catch { /* invalid */ }
      if (!valid) throw new ForbiddenException({ statusCode: 403, code: 'invalid_consent', message: 'Invalid owner consent' });
      // The main wallet is the only destination, and the copy account signed
      // exactly this UsdSend in the owner's browser.
      const { typed, bound } = this.returnAction(row);
      if (row.destination !== context.owner.embeddedWalletAddress || await masterSignatureRefusal(row.address, typed, bound, masterSignature))
        throw new ForbiddenException({ statusCode: 403, code: 'master_signature_invalid', message: "The copy account's signature is not for this return" });
    }
    if (!Dec.from(await this.exchange.withdrawable('testnet', row.address)).gte(row.amount)) throw new ConflictException({ statusCode: 409, code: 'no_free_collateral', message: 'Not enough transferable USDC' });
    const checkedAt = this.now();
    const fresh = () => { const at = this.now(); if (!Number.isSafeInteger(at) || at - checkedAt > 5000 || at >= consent.consentExpiresAt) throw new Error('stale'); };
    const attempt = await this.repository.begin(userId, id);
    if (!attempt) return wire(await this.repository.find(userId, id));
    let signature: string;
    try {
      const typed = usdSendTypedData(WALLET_NETWORKS.testnet, row.destination, row.amount, row.nonce);
      signature = automatic
        ? await this.workerSigner!.sign({ walletId: account.privyWalletId!, address: row.address, ownerQuorumId: account.ownerQuorumId!, workerQuorumId: account.masterSignerQuorumId!, policyId: account.masterPolicyId! },
          typed, { network: 'testnet', destination: account.sweepDestination! }, consent.consentExpiresAt)
        : masterSignature!;
    } catch {
      // Not signed: the exchange cannot have it. Definitely not sent.
      return wire(await this.repository.finish(userId, id, 'rejected', digest({ reason: 'master_signature_unavailable', id })));
    }
    let reply: unknown;
    try { reply = await this.exchange.send(attempt, signature, fresh); } catch { return wire(await this.repository.find(userId, id)); }
    return wire(await this.settle(userId, id, reply));
  }
  private async settle(userId: number, id: string, reply: unknown): Promise<ReturnRow> {
    if (reply && typeof reply === 'object' && 'status' in reply && 'response' in reply) {
      if (reply.status === 'ok' && reply.response && typeof reply.response === 'object' && 'type' in reply.response && reply.response.type === 'default') return this.repository.finish(userId, id, 'accepted', digest(reply));
      if (reply.status === 'err' && typeof reply.response === 'string' && reply.response && !/nonce/i.test(reply.response)) return this.repository.finish(userId, id, 'rejected', digest(reply));
    }
    return this.repository.find(userId, id);
  }

  // --- builder fee approval ---------------------------------------------------
  private builderConsent(row: BuilderApprovalRow) {
    return { operationId: row.id, network: 'testnet' as const, account: row.accountAddress, builder: row.builderAddress, maxFeeTenthsBps: row.maxFeeTenthsBps,
      nonce: row.nonce, consentExpiresAt: row.createdAt.getTime() + CONSENT_WINDOW_MS };
  }
  private builderWire(row: BuilderApprovalRow) {
    return { id: row.id, accountId: row.accountId, state: row.state, builderAddress: row.builderAddress, maxFeeTenthsBps: row.maxFeeTenthsBps,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }
  /** Prepares the approval of the platform's configured builder fee. */
  async reserveBuilder(userId: number, accountId: string, body: unknown) {
    this.assertAvailable();
    const { idempotencyKey } = input(z.object({ idempotencyKey: z.string().uuid() }).strict(), body);
    const builder = await this.mandates.builder(this.repository.reader());
    if (!builder.builderAddress || builder.builderMaxFeeTenthsOfBps <= 0) throw new ConflictException({ statusCode: 409, code: 'builder_fee_not_configured', message: 'No builder fee is configured' });
    const row = await this.repository.reserveBuilder(userId, accountId, { idempotencyKey, builderAddress: builder.builderAddress, maxFeeTenthsBps: builder.builderMaxFeeTenthsOfBps, now: this.now() });
    return copyBuilderChallengeSchema.parse({ approval: this.builderWire(row), consent: this.builderConsent(row), masterAction: this.builderRequest(row) });
  }
  private builderAction(row: BuilderApprovalRow) {
    return { typed: approveBuilderFeeTypedData(WALLET_NETWORKS.testnet, row.builderAddress, row.maxFeeTenthsBps, row.nonce) as unknown as MasterTypedData,
      bound: { network: 'testnet', builder: row.builderAddress } satisfies MasterActionBound };
  }
  /** The copy account's own approval for the owner's browser to sign. */
  private builderRequest(row: BuilderApprovalRow) {
    if (row.state !== 'prepared') return null;
    const { typed, bound } = this.builderAction(row);
    return masterActionRequest(row.accountAddress, typed, bound, this.builderConsent(row).consentExpiresAt);
  }
  async approveBuilder(userId: number, id: string, body: unknown) {
    this.assertAvailable();
    const { consentSignature, masterSignature } = input(approveCopyMasterActionSchema, body);
    const row = await this.repository.builder(userId, id), consent = this.builderConsent(row), now = this.now();
    if (row.state !== 'prepared') return this.builderWire(await this.observeBuilder(userId, row));
    if (now >= consent.consentExpiresAt) throw new ConflictException({ statusCode: 409, code: 'consent_expired', message: 'Prepare the approval again' });
    const context = await this.contextOf(userId, row.accountId);
    let valid = false;
    try { valid = await verifyTypedData({ address: context.owner.embeddedWalletAddress as `0x${string}`, ...copyBuilderConsentTypedData(consent), signature: consentSignature as `0x${string}` }); } catch { /* invalid */ }
    if (!valid) throw new ForbiddenException({ statusCode: 403, code: 'invalid_consent', message: 'Invalid owner consent' });
    const { typed, bound } = this.builderAction(row);
    if (await masterSignatureRefusal(row.accountAddress, typed, bound, masterSignature))
      throw new ForbiddenException({ statusCode: 403, code: 'master_signature_invalid', message: "The copy account's signature is not for this approval" });
    const checkedAt = this.now();
    const fresh = () => { const at = this.now(); if (!Number.isSafeInteger(at) || at - checkedAt > 5000 || at >= consent.consentExpiresAt) throw new Error('stale'); };
    const attempt = await this.repository.beginBuilder(userId, id);
    if (!attempt) return this.builderWire(await this.repository.builder(userId, id));
    const signature = masterSignature;
    let reply: unknown;
    try { reply = await this.exchange.sendAction('testnet', approveBuilderFeeRequest(WALLET_NETWORKS.testnet, row.builderAddress, row.maxFeeTenthsBps, row.nonce, signature), fresh); }
    catch { return this.builderWire(await this.repository.builder(userId, id)); }
    if (reply && typeof reply === 'object' && 'status' in reply) {
      if (reply.status === 'ok') return this.builderWire(await this.observeBuilder(userId, await this.repository.finishBuilder(userId, id, 'accepted', digest(reply))));
      if (reply.status === 'err') return this.builderWire(await this.repository.finishBuilder(userId, id, 'rejected', digest(reply)));
    }
    return this.builderWire(await this.repository.builder(userId, id));
  }
  /** Approved once the exchange reports a maximum fee covering the rate. */
  private async observeBuilder(userId: number, row: BuilderApprovalRow): Promise<BuilderApprovalRow> {
    if (!['unknown', 'accepted'].includes(row.state)) return row;
    try {
      const cap = await this.exchange.maxBuilderFee('testnet', row.accountAddress, row.builderAddress);
      if (cap >= row.maxFeeTenthsBps) return this.repository.finishBuilder(userId, row.id, 'approved', digest({ cap, checkedAt: this.now() }));
    } catch { /* stays pending */ }
    return row;
  }
  async reconcileBuilder(userId: number, id: string) { return this.builderWire(await this.observeBuilder(userId, await this.repository.builder(userId, id))); }
}
