import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminSettingsSchema, copyBuilderConsentTypedData, copyReturnConsentTypedData, type CopyMasterActionRequest, type CopyReturnConsent } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import { CopyFundingRepository } from '../src/copy/copy-funding.repository.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveReturnRepository } from '../src/copy/copy-live-return.repository.js';
import { CopyLiveReturnService } from '../src/copy/copy-live-return.service.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Real SQL; the exchange is a double. The copy account signs in the owner's browser (a key here).
const owner = privateKeyToAccount(`0x${'0a'.repeat(32)}`), foreign = privateKeyToAccount(`0x${'0b'.repeat(32)}`), copyAccount = privateKeyToAccount(`0x${'0c'.repeat(32)}`);
const accountAddress = copyAccount.address.toLowerCase();
let db: TestDb, service: CopyLiveReturnService, clock: number;
let exchange: { withdrawable: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; sendAction: ReturnType<typeof vi.fn>; maxBuilderFee: ReturnType<typeof vi.fn> };
const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = () => new AppConfig(validateEnvironment({ DATABASE_URL: process.env.TEST_DATABASE_URL, HYPERLIQUID_NETWORK: 'testnet', PRIVY_APP_ID: 'app', PRIVY_APP_SECRET: 'secret' }));
const ownerSigns = (consent: CopyReturnConsent) => owner.signTypedData(copyReturnConsentTypedData(consent));
/** The main wallet's consent and the copy account's own signature of the challenge's action. */
const approval = async (challenge: { consent: CopyReturnConsent; masterAction: CopyMasterActionRequest | null }, signer = copyAccount) =>
  ({ consentSignature: await ownerSigns(challenge.consent), masterSignature: await signer.signTypedData(challenge.masterAction!.typedData as never) });

beforeEach(async () => {
  db = getTestDb(); await preparationFixture(db); clock = Date.now();
  await db.update(schema.users).set({ embeddedWalletAddress: owner.address.toLowerCase() });
  await db.update(schema.copyExecutionAccounts).set({ address: accountAddress });
  exchange = { withdrawable: vi.fn(async () => '42.1234567'), send: vi.fn(async () => ({ status: 'ok', response: { type: 'default' } })),
    sendAction: vi.fn(async () => ({ status: 'ok', response: { type: 'default' } })), maxBuilderFee: vi.fn(async () => 10) };
  service = new CopyLiveReturnService(config(), new CopyLiveReturnRepository(db), exchange as unknown as CopyFundingExchangeClient, new CopyLiveMandateRepository(db), () => clock);
});
afterAll(async () => { await closeTestDb(); });

describe('returning USDC from a copy account to the main wallet', () => {
  it("idle funds while copying: the owner consents, the copy account signs the exact usdSend in the owner's browser, sent once, accepted", async () => {
    const challenge = await service.reserve(1, 'account', { idempotencyKey: key(1), amount: '12.5' });
    expect(challenge.operation).toMatchObject({ direction: 'to_main', status: 'prepared', amount: '12.5', address: accountAddress, destination: owner.address.toLowerCase(), stopId: null });
    expect(challenge.consent).toMatchObject({ account: accountAddress, destination: owner.address.toLowerCase(), amount: '12.5', network: 'testnet' });
    // The action for the browser: the copy account's usdSend to the main wallet, until the consent ends.
    expect(challenge.masterAction).toMatchObject({ kind: 'usd_send', account: accountAddress, expiresAt: challenge.consent.consentExpiresAt,
      typedData: { primaryType: 'HyperliquidTransaction:UsdSend', message: { hyperliquidChain: 'Testnet', destination: owner.address.toLowerCase(), amount: '12.5', time: challenge.consent.nonce } } });
    const signed = await approval(challenge);
    await expect(service.approve(1, challenge.operation.id, { ...signed, consentSignature: await foreign.signTypedData(copyReturnConsentTypedData(challenge.consent)) })).rejects.toMatchObject({ status: 403, response: { code: 'invalid_consent' } });
    // The consent with the main wallet's (or any other key's) signature of the transfer, or without one.
    await expect(service.approve(1, challenge.operation.id, await approval(challenge, owner))).rejects.toMatchObject({ status: 403, response: { code: 'master_signature_invalid' } });
    await expect(service.approve(1, challenge.operation.id, { consentSignature: signed.consentSignature })).rejects.toMatchObject({ status: 400 });
    expect(exchange.send).not.toHaveBeenCalled();
    const sent = await service.approve(1, challenge.operation.id, signed);
    expect(sent).toMatchObject({ status: 'accepted', direction: 'to_main' });
    expect(exchange.send.mock.calls[0]![1]).toBe(signed.masterSignature);
    // Again: the original attempt is never resent.
    expect(await service.approve(1, challenge.operation.id, signed)).toMatchObject({ status: 'accepted' });
    expect(exchange.send).toHaveBeenCalledOnce();
    // While it is pending, no other wallet operation of the account starts.
    await expect(service.reserve(1, 'account', { idempotencyKey: key(2), amount: '1' })).rejects.toMatchObject({ status: 409 });
  });
  it('idle funds without a signature: only an account with the automatic return, signed by the worker under its policy (Paul\'s decision 3)', async () => {
    const worker = { available: true, sign: vi.fn(async () => `0x${'22'.repeat(64)}1b`) };
    const automatic = new CopyLiveReturnService(config(), new CopyLiveReturnRepository(db), exchange as unknown as CopyFundingExchangeClient, new CopyLiveMandateRepository(db), () => clock, worker as never);
    const legacy = await automatic.reserve(1, 'account', { idempotencyKey: key(30), amount: '3' });
    await expect(automatic.approve(1, legacy.operation.id, {})).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'invalid_consent' }) });
    expect(worker.sign).not.toHaveBeenCalled();
    await db.update(schema.copyFundingOperations).set({ status: 'cancelled' });
    await db.update(schema.copyExecutionAccounts).set({ masterPolicyId: 'policy-1', masterPolicyFingerprint: 'c'.repeat(64), masterSignerQuorumId: 'worker',
      sweepDestination: owner.address.toLowerCase(), signerAttachedAt: new Date(clock) });
    const challenge = await automatic.reserve(1, 'account', { idempotencyKey: key(31), amount: '12.5' });
    expect(await automatic.approve(1, challenge.operation.id, {})).toMatchObject({ status: 'accepted' });
    const [target, data, bound] = worker.sign.mock.calls[0]! as unknown as [object, object, object];
    expect(target).toEqual({ walletId: 'master', address: accountAddress, ownerQuorumId: 'owner', workerQuorumId: 'worker', policyId: 'policy-1' });
    expect(data).toMatchObject({ primaryType: 'HyperliquidTransaction:UsdSend', message: { destination: owner.address.toLowerCase(), amount: '12.5' } });
    expect(bound).toEqual({ network: 'testnet', destination: owner.address.toLowerCase() });
    // A main wallet that changed since the policy was made: no unsigned return.
    await db.update(schema.copyFundingOperations).set({ status: 'cancelled' });
    await db.update(schema.users).set({ embeddedWalletAddress: foreign.address.toLowerCase() });
    const moved = await automatic.reserve(1, 'account', { idempotencyKey: key(32), amount: '1' });
    await expect(automatic.approve(1, moved.operation.id, {})).rejects.toMatchObject({ status: 403 });
  });
  it('a return in flight excludes a new deposit to the same copy account, as a deposit excludes a return', async () => {
    await service.reserve(1, 'account', { idempotencyKey: key(7), amount: '5' });
    await expect(new CopyFundingRepository(db).reserve(1, 'account', 'testnet', { idempotencyKey: key(8), amount: '10' })).rejects.toMatchObject({ status: 409 });
  });

  it('a prepared return whose consent window passed is cancelled, not left holding the account (the browser lost its key on reload)', async () => {
    const stale = await service.reserve(1, 'account', { idempotencyKey: key(9), amount: '5' });
    await db.update(schema.copyFundingOperations).set({ createdAt: new Date(Date.now() - 6 * 60_000) }).where(eq(schema.copyFundingOperations.id, stale.operation.id));
    const fresh = await service.reserve(1, 'account', { idempotencyKey: key(10), amount: '6' });
    expect(fresh.operation).toMatchObject({ status: 'prepared', amount: '6' });
    expect((await db.select().from(schema.copyFundingOperations).where(eq(schema.copyFundingOperations.id, stale.operation.id)))[0]).toMatchObject({ status: 'cancelled' });
    // Its approval is refused as expired, never sent.
    clock = Date.now();
    await expect(service.approve(1, stale.operation.id, await approval(stale))).resolves.toMatchObject({ status: 'cancelled' });
    expect(exchange.send).not.toHaveBeenCalled();
  });

  it('refuses more than the account can transfer, before any attempt', async () => {
    exchange.withdrawable.mockResolvedValue('3');
    const challenge = await service.reserve(1, 'account', { idempotencyKey: key(3), amount: '12.5' });
    await expect(service.approve(1, challenge.operation.id, await approval(challenge))).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.copyFundingOperations))[0]).toMatchObject({ status: 'prepared', attemptedAt: null });
  });
  it('an ambiguous send stays unknown and is never resent', async () => {
    exchange.send.mockRejectedValueOnce(new Error('timeout'));
    const second = await service.reserve(1, 'account', { idempotencyKey: key(5), amount: '1' });
    const signed = await approval(second);
    expect(await service.approve(1, second.operation.id, signed)).toMatchObject({ status: 'unknown' });
    expect(await service.approve(1, second.operation.id, signed)).toMatchObject({ status: 'unknown' });
    expect(exchange.send).toHaveBeenCalledOnce();
  });
  it('everything returns only once the stop is flat; the sweep belongs to the stop and its credit ends it', async () => {
    await expect(service.reserve(1, 'account', { idempotencyKey: key(6), amount: 'all' })).rejects.toMatchObject({ status: 409, response: { code: 'return_requires_flat_stop' } });
    const [mandate] = await db.select().from(schema.copyLiveMandates);
    const [stop] = await db.insert(schema.copyLiveStopOperations).values({ id: '11111111-1111-4111-8111-111111111111', userId: 1, strategyId: 9, accountId: 'account', mandateId: mandate!.id,
      idempotencyKey: 'stop-for-return-0001', originalMandateRevision: 2, network: 'testnet', accountAddress: accountAddress, ownerPrivyUserId: 'did:privy:risk-source',
      ownerAddress: owner.address.toLowerCase(), accountWalletId: 'master', accountOwnerQuorumId: 'owner', originalIntentDigest: 'a'.repeat(64), originalConsentDigest: 'b'.repeat(64),
      state: 'flat', targetManifest: {}, targetDigest: 'c'.repeat(64), trackedExecutionCount: 0, trackingComplete: true, flatCertificate: {}, flatDigest: 'd'.repeat(64),
      flatVerifiedAt: new Date(clock), createdAt: new Date(clock - 1000), updatedAt: new Date(clock) }).returning();
    await expect(service.reserve(1, 'account', { idempotencyKey: key(7), amount: '5' })).rejects.toMatchObject({ status: 409, response: { code: 'return_use_sweep' } });
    const sweep = await service.reserve(1, 'account', { idempotencyKey: key(8), amount: 'all' });
    expect(sweep.operation).toMatchObject({ amount: '42.123456', stopId: stop!.id, direction: 'to_main' });
    const repository = new CopyLiveReturnRepository(db);
    expect(await repository.swept(stop!.id)).toBe(false);
    await db.update(schema.copyFundingOperations).set({ status: 'credited', attemptedAt: new Date(clock), claimedAt: new Date(clock), evidenceHash: 'e'.repeat(64),
      transactionHash: `0x${'f'.repeat(64)}`, creditedAmount: '41.123456', fee: '1' }).where(eq(schema.copyFundingOperations.id, sweep.operation.id));
    expect(await repository.swept(stop!.id)).toBe(true);
  });
});

describe('builder fee approval by the copy account', () => {
  it('only when a fee is configured; the owner consents, the account signs approveBuilderFee, approved once the exchange reports it', async () => {
    await expect(service.reserveBuilder(1, 'account', { idempotencyKey: key(9) })).rejects.toMatchObject({ status: 409, response: { code: 'builder_fee_not_configured' } });
    const builder = `0x${'77'.repeat(20)}`;
    await db.insert(schema.appSettings).values({ key: 'revenue', value: { ...adminSettingsSchema.shape.revenue.parse({}), builderAddress: builder, builderFeeTenthsBps: 10 } })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: { ...adminSettingsSchema.shape.revenue.parse({}), builderAddress: builder, builderFeeTenthsBps: 10 } } });
    const challenge = await service.reserveBuilder(1, 'account', { idempotencyKey: key(10) });
    expect(challenge.consent).toMatchObject({ account: accountAddress, builder, maxFeeTenthsBps: 10 });
    expect(challenge.masterAction).toMatchObject({ kind: 'builder_fee', account: accountAddress, typedData: { primaryType: 'HyperliquidTransaction:ApproveBuilderFee', message: { maxFeeRate: '0.01%', builder, nonce: challenge.consent.nonce } } });
    const consentSignature = await owner.signTypedData(copyBuilderConsentTypedData(challenge.consent)), masterSignature = await copyAccount.signTypedData(challenge.masterAction!.typedData as never);
    await expect(service.approveBuilder(1, challenge.approval.id, { consentSignature, masterSignature: await owner.signTypedData(challenge.masterAction!.typedData as never) }))
      .rejects.toMatchObject({ status: 403, response: { code: 'master_signature_invalid' } });
    expect(exchange.sendAction).not.toHaveBeenCalled();
    const approved = await service.approveBuilder(1, challenge.approval.id, { consentSignature, masterSignature });
    expect(approved).toMatchObject({ state: 'approved' });
    expect(exchange.sendAction.mock.calls[0]![1]).toMatchObject({ action: { type: 'approveBuilderFee', maxFeeRate: '0.01%', builder } });
  });
});
