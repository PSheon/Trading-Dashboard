import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminSettingsSchema, copyBuilderConsentTypedData, copyReturnConsentTypedData, type CopyReturnConsent } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import { CopyFundingRepository } from '../src/copy/copy-funding.repository.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveReturnRepository } from '../src/copy/copy-live-return.repository.js';
import { CopyLiveReturnService } from '../src/copy/copy-live-return.service.js';
import type { MasterActionSigner } from '../src/copy/live/privy-master-signer.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Real SQL; the Privy account signer and the exchange are doubles.
const owner = privateKeyToAccount(`0x${'0a'.repeat(32)}`), foreign = privateKeyToAccount(`0x${'0b'.repeat(32)}`);
let db: TestDb, seed: Awaited<ReturnType<typeof preparationFixture>>, service: CopyLiveReturnService, clock: number;
let exchange: { withdrawable: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; sendAction: ReturnType<typeof vi.fn>; maxBuilderFee: ReturnType<typeof vi.fn> };
let signer: MasterActionSigner & { sign: ReturnType<typeof vi.fn> };
const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = () => new AppConfig(validateEnvironment({ DATABASE_URL: process.env.TEST_DATABASE_URL, HYPERLIQUID_NETWORK: 'testnet', PRIVY_APP_ID: 'app', PRIVY_APP_SECRET: 'secret' }));
const ownerSigns = (consent: CopyReturnConsent) => owner.signTypedData(copyReturnConsentTypedData(consent));

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db); clock = Date.now();
  await db.update(schema.users).set({ embeddedWalletAddress: owner.address.toLowerCase() });
  exchange = { withdrawable: vi.fn(async () => '42.1234567'), send: vi.fn(async () => ({ status: 'ok', response: { type: 'default' } })),
    sendAction: vi.fn(async () => ({ status: 'ok', response: { type: 'default' } })), maxBuilderFee: vi.fn(async () => 10) };
  signer = { available: true, sign: vi.fn(async () => `0x${'11'.repeat(64)}1b`) } as never;
  service = new CopyLiveReturnService(config(), new CopyLiveReturnRepository(db), exchange as unknown as CopyFundingExchangeClient, new CopyLiveMandateRepository(db), signer, () => clock);
});
afterAll(async () => { await closeTestDb(); });

describe('returning USDC from a copy account to the main wallet', () => {
  it('idle funds while copying: the owner consents, the account signs the exact usdSend once, accepted', async () => {
    const challenge = await service.reserve(1, 'account', { idempotencyKey: key(1), amount: '12.5' });
    expect(challenge.operation).toMatchObject({ direction: 'to_main', status: 'prepared', amount: '12.5', address: seed.f.identity.accountAddress, destination: owner.address.toLowerCase(), stopId: null });
    expect(challenge.consent).toMatchObject({ account: seed.f.identity.accountAddress, destination: owner.address.toLowerCase(), amount: '12.5', network: 'testnet' });
    await expect(service.approve(1, challenge.operation.id, { consentSignature: await foreign.signTypedData(copyReturnConsentTypedData(challenge.consent)) }, 'jwt')).rejects.toMatchObject({ status: 403 });
    expect(signer.sign).not.toHaveBeenCalled();
    const sent = await service.approve(1, challenge.operation.id, { consentSignature: await ownerSigns(challenge.consent) }, 'owner-jwt');
    expect(sent).toMatchObject({ status: 'accepted', direction: 'to_main' });
    const [account, data, jwt] = signer.sign.mock.calls[0]!;
    expect(account).toEqual({ walletId: 'master', address: seed.f.identity.accountAddress, ownerQuorumId: 'owner' });
    expect(data).toMatchObject({ primaryType: 'HyperliquidTransaction:UsdSend', message: { destination: owner.address.toLowerCase(), amount: '12.5', time: challenge.consent.nonce } });
    expect(jwt).toBe('owner-jwt');
    // Again: the original attempt is never resent.
    expect(await service.approve(1, challenge.operation.id, { consentSignature: await ownerSigns(challenge.consent) }, 'owner-jwt')).toMatchObject({ status: 'accepted' });
    expect(exchange.send).toHaveBeenCalledOnce();
    // While it is pending, no other wallet operation of the account starts.
    await expect(service.reserve(1, 'account', { idempotencyKey: key(2), amount: '1' })).rejects.toMatchObject({ status: 409 });
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
    await expect(service.approve(1, stale.operation.id, { consentSignature: await ownerSigns(stale.consent) }, 'jwt')).resolves.toMatchObject({ status: 'cancelled' });
    expect(exchange.send).not.toHaveBeenCalled();
  });

  it('refuses more than the account can transfer, before any attempt', async () => {
    exchange.withdrawable.mockResolvedValue('3');
    const challenge = await service.reserve(1, 'account', { idempotencyKey: key(3), amount: '12.5' });
    await expect(service.approve(1, challenge.operation.id, { consentSignature: await ownerSigns(challenge.consent) }, 'jwt')).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.copyFundingOperations))[0]).toMatchObject({ status: 'prepared', attemptedAt: null });
  });
  it('an unsigned attempt is rejected (never sent); an ambiguous send stays unknown and is never resent', async () => {
    signer.sign.mockRejectedValueOnce(new Error('privy down'));
    const first = await service.reserve(1, 'account', { idempotencyKey: key(4), amount: '1' });
    expect(await service.approve(1, first.operation.id, { consentSignature: await ownerSigns(first.consent) }, 'jwt')).toMatchObject({ status: 'rejected' });
    expect(exchange.send).not.toHaveBeenCalled();
    exchange.send.mockRejectedValueOnce(new Error('timeout'));
    const second = await service.reserve(1, 'account', { idempotencyKey: key(5), amount: '1' });
    expect(await service.approve(1, second.operation.id, { consentSignature: await ownerSigns(second.consent) }, 'jwt')).toMatchObject({ status: 'unknown' });
    expect(await service.approve(1, second.operation.id, { consentSignature: await ownerSigns(second.consent) }, 'jwt')).toMatchObject({ status: 'unknown' });
    expect(exchange.send).toHaveBeenCalledOnce();
  });
  it('everything returns only once the stop is flat; the sweep belongs to the stop and its credit ends it', async () => {
    await expect(service.reserve(1, 'account', { idempotencyKey: key(6), amount: 'all' })).rejects.toMatchObject({ status: 409, response: { code: 'return_requires_flat_stop' } });
    const [mandate] = await db.select().from(schema.copyLiveMandates);
    const [stop] = await db.insert(schema.copyLiveStopOperations).values({ id: '11111111-1111-4111-8111-111111111111', userId: 1, strategyId: 9, accountId: 'account', mandateId: mandate!.id,
      idempotencyKey: 'stop-for-return-0001', originalMandateRevision: 2, network: 'testnet', accountAddress: seed.f.identity.accountAddress, ownerPrivyUserId: 'did:privy:risk-source',
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
    expect(challenge.consent).toMatchObject({ account: seed.f.identity.accountAddress, builder, maxFeeTenthsBps: 10 });
    const approved = await service.approveBuilder(1, challenge.approval.id, { consentSignature: await owner.signTypedData(copyBuilderConsentTypedData(challenge.consent)) }, 'jwt');
    expect(approved).toMatchObject({ state: 'approved' });
    expect(signer.sign.mock.calls[0]![1]).toMatchObject({ primaryType: 'HyperliquidTransaction:ApproveBuilderFee', message: { maxFeeRate: '0.01%', builder, nonce: challenge.consent.nonce } });
    expect(exchange.sendAction.mock.calls[0]![1]).toMatchObject({ action: { type: 'approveBuilderFee', maxFeeRate: '0.01%', builder } });
  });
});
