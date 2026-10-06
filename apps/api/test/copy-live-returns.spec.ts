import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import { CopyFundingRepository } from '../src/copy/copy-funding.repository.js';
import { CopyLiveReturnRepository } from '../src/copy/copy-live-return.repository.js';
import { CopyLiveReturnService } from '../src/copy/copy-live-return.service.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Real SQL; the exchange and the worker's Privy signer are doubles. Every
// return is signed by the worker under the owner's policy (one signing model).
const owner = privateKeyToAccount(`0x${'0a'.repeat(32)}`), foreign = privateKeyToAccount(`0x${'0b'.repeat(32)}`), copyAccount = privateKeyToAccount(`0x${'0c'.repeat(32)}`);
const accountAddress = copyAccount.address.toLowerCase();
let db: TestDb, service: CopyLiveReturnService, clock: number;
let worker: { available: boolean; sign: ReturnType<typeof vi.fn> };
let exchange: { withdrawable: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; sendAction: ReturnType<typeof vi.fn>; maxBuilderFee: ReturnType<typeof vi.fn> };
const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = () => new AppConfig(validateEnvironment({ DATABASE_URL: process.env.TEST_DATABASE_URL, HYPERLIQUID_NETWORK: 'testnet', PRIVY_APP_ID: 'app', PRIVY_APP_SECRET: 'secret' }));
/** The account's worker signer under the owner's policy (the automatic return). */
const withSigner = () => db.update(schema.copyExecutionAccounts).set({ masterPolicyId: 'policy-1', masterPolicyFingerprint: 'c'.repeat(64), masterSignerQuorumId: 'worker',
  sweepDestination: owner.address.toLowerCase(), signerAttachedAt: new Date(clock) });

beforeEach(async () => {
  db = getTestDb(); await preparationFixture(db); clock = Date.now();
  await db.update(schema.users).set({ embeddedWalletAddress: owner.address.toLowerCase() });
  await db.update(schema.copyExecutionAccounts).set({ address: accountAddress }); await withSigner();
  exchange = { withdrawable: vi.fn(async () => '42.1234567'), send: vi.fn(async () => ({ status: 'ok', response: { type: 'default' } })),
    sendAction: vi.fn(async () => ({ status: 'ok', response: { type: 'default' } })), maxBuilderFee: vi.fn(async () => 10) };
  worker = { available: true, sign: vi.fn(async () => `0x${'22'.repeat(64)}1b`) };
  service = new CopyLiveReturnService(config(), new CopyLiveReturnRepository(db, testConfig()), exchange as unknown as CopyFundingExchangeClient, () => clock, worker as never);
});
afterAll(async () => { await closeTestDb(); });

describe('returning USDC from a copy account to the main wallet', () => {
  it("idle funds while copying: the worker signs the exact usdSend to the main wallet, sent once, accepted", async () => {
    const challenge = await service.reserve(1, 'account', { idempotencyKey: key(1), amount: '12.5' });
    expect(challenge.operation).toMatchObject({ direction: 'to_main', status: 'prepared', amount: '12.5', address: accountAddress, destination: owner.address.toLowerCase(), stopId: null });
    const sent = await service.approve(1, challenge.operation.id, {});
    expect(sent).toMatchObject({ status: 'accepted', direction: 'to_main' });
    const [target, data, bound] = worker.sign.mock.calls[0]! as unknown as [object, object, object];
    expect(target).toEqual({ walletId: 'master', address: accountAddress, ownerQuorumId: 'owner', workerQuorumId: 'worker', policyId: 'policy-1' });
    expect(data).toMatchObject({ primaryType: 'HyperliquidTransaction:UsdSend', message: { hyperliquidChain: 'Testnet', destination: owner.address.toLowerCase(), amount: '12.5' } });
    expect(bound).toEqual({ network: 'testnet', destination: owner.address.toLowerCase() });
    // Again: the original attempt is never resent.
    expect(await service.approve(1, challenge.operation.id, {})).toMatchObject({ status: 'accepted' });
    expect(exchange.send).toHaveBeenCalledOnce(); expect(worker.sign).toHaveBeenCalledOnce();
    // While it is pending, no other wallet operation of the account starts.
    await expect(service.reserve(1, 'account', { idempotencyKey: key(2), amount: '1' })).rejects.toMatchObject({ status: 409 });
  });
  it("a main wallet that changed since the policy was made: no return (the policy allows only the old one)", async () => {
    await db.update(schema.users).set({ embeddedWalletAddress: foreign.address.toLowerCase() });
    const moved = await service.reserve(1, 'account', { idempotencyKey: key(32), amount: '1' });
    await expect(service.approve(1, moved.operation.id, {})).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'setup_wallet_conflict' }) });
    expect(worker.sign).not.toHaveBeenCalled();
  });
  it('a return the worker could not sign is refused, never sent', async () => {
    worker.sign.mockRejectedValueOnce(new Error('privy down'));
    const challenge = await service.reserve(1, 'account', { idempotencyKey: key(33), amount: '2' });
    expect(await service.approve(1, challenge.operation.id, {})).toMatchObject({ status: 'rejected' });
    expect(exchange.send).not.toHaveBeenCalled();
  });
  it('a return is signed by the worker only: nothing for the browser to sign, a body with signatures is refused 400, an account without the signer 409 worker_signer_missing', async () => {
    await db.update(schema.copyExecutionAccounts).set({ masterPolicyId: null, masterPolicyFingerprint: null, masterSignerQuorumId: null, sweepDestination: null, signerAttachedAt: null });
    const returns = service;
    const legacy = await returns.reserve(1, 'account', { idempotencyKey: key(40), amount: '3' });
    expect(Object.keys(legacy)).toEqual(['operation']);
    await expect(returns.approve(1, legacy.operation.id, {})).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'worker_signer_missing' }) });
    await db.update(schema.copyFundingOperations).set({ status: 'cancelled' });
    await db.update(schema.copyExecutionAccounts).set({ masterPolicyId: 'policy-1', masterPolicyFingerprint: 'c'.repeat(64), masterSignerQuorumId: 'worker',
      sweepDestination: owner.address.toLowerCase(), signerAttachedAt: new Date(clock) });
    const challenge = await returns.reserve(1, 'account', { idempotencyKey: key(41), amount: '12.5' });
    await expect(returns.approve(1, challenge.operation.id, { consentSignature: `0x${'ab'.repeat(65)}`, masterSignature: `0x${'cd'.repeat(65)}` })).rejects.toMatchObject({ status: 400 });
    expect(worker.sign).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
    expect(await returns.approve(1, challenge.operation.id, {})).toMatchObject({ status: 'accepted' });
    expect(worker.sign).toHaveBeenCalledOnce();
    expect(exchange.send.mock.calls[0]![1]).toBe(`0x${'22'.repeat(64)}1b`);
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
    await expect(service.approve(1, stale.operation.id, {})).resolves.toMatchObject({ status: 'cancelled' });
    expect(exchange.send).not.toHaveBeenCalled();
  });

  it('refuses more than the account can transfer, before any attempt', async () => {
    exchange.withdrawable.mockResolvedValue('3');
    const challenge = await service.reserve(1, 'account', { idempotencyKey: key(3), amount: '12.5' });
    await expect(service.approve(1, challenge.operation.id, {})).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.copyFundingOperations))[0]).toMatchObject({ status: 'prepared', attemptedAt: null });
  });
  it('an ambiguous send stays unknown and is never resent', async () => {
    exchange.send.mockRejectedValueOnce(new Error('timeout'));
    const second = await service.reserve(1, 'account', { idempotencyKey: key(5), amount: '1' });
    expect(await service.approve(1, second.operation.id, {})).toMatchObject({ status: 'unknown' });
    expect(await service.approve(1, second.operation.id, {})).toMatchObject({ status: 'unknown' });
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
    const repository = new CopyLiveReturnRepository(db, testConfig());
    expect(await repository.swept(stop!.id)).toBe(false);
    await db.update(schema.copyFundingOperations).set({ status: 'credited', attemptedAt: new Date(clock), claimedAt: new Date(clock), evidenceHash: 'e'.repeat(64),
      transactionHash: `0x${'f'.repeat(64)}`, creditedAmount: '41.123456', fee: '1' }).where(eq(schema.copyFundingOperations.id, sweep.operation.id));
    expect(await repository.swept(stop!.id)).toBe(true);
  });
});
