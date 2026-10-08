import { expect, it, vi } from 'vitest';
import { orderApproval } from '../src/copy/live/live-order-approval.js';
import { assertVerifiedAuthorizationFresh, WalletAuthorizationService, type WalletAuthorization } from '../src/copy/live/wallet-authorization.js';

const start = 1_790_000_000_000, account = `0x${'ab'.repeat(20)}` as const, signer = `0x${'cd'.repeat(20)}` as const;
const grant: WalletAuthorization = { id: 'grant', version: 1, userId: 1, strategyId: 2, walletId: 'wallet', privyOwnerId: 'quorum',
  signerAddress: signer, accountAddress: account, network: 'testnet', scopes: ['copy:trade', 'copy:reduce'],
  validFrom: start - 1, expiresAt: start + 100000, revokedAt: null, exchangeApprovedAt: start - 1 };
function fixture() {
  let clock = start, expiresAt: number | null = start + 100000;
  const verify = vi.fn(async (value: WalletAuthorization) => ({ network: value.network, accountAddress: value.accountAddress,
    signerAddress: value.signerAddress, checkedAt: clock, expiresAt }));
  return { verify, approval: orderApproval({ verify }, () => clock), at: (time: number) => { clock = time; },
    expireAt: (time: number) => { expiresAt = time; }, now: () => clock };
}
it('reuses one original observation through the existing five-second limit without refreshing its timestamp', async () => {
  const f = fixture(); const first = await f.approval.verify(grant);
  f.at(start + 3500); expect(await f.approval.verify(grant)).toEqual(first);
  f.at(start + 5000); expect((await f.approval.verify(grant)).checkedAt).toBe(start);
  expect(f.verify).toHaveBeenCalledOnce();
  f.at(start + 5001); expect((await f.approval.verify(grant)).checkedAt).toBe(start + 5001);
  expect(f.verify).toHaveBeenCalledTimes(2);
});
it('refuses an expired agent even inside the observation window', async () => {
  const f = fixture(); f.expireAt(start + 2000); await f.approval.verify(grant); f.at(start + 2000);
  await expect(f.approval.verify(grant)).rejects.toMatchObject({ code: 'exchange_agent_expired' });
  expect(f.verify).toHaveBeenCalledOnce();
});
it.each(['version', 'id', 'network', 'accountAddress', 'signerAddress'] as const)('never shares proof across changed %s', async field => {
  const f = fixture(); await f.approval.verify(grant); f.at(start + 1500);
  const changed = { ...grant, [field]: field === 'version' ? 2 : field === 'network' ? 'mainnet' : 'different' } as WalletAuthorization;
  await f.approval.verify(changed); expect(f.verify).toHaveBeenCalledTimes(2);
});
it('keeps different executions isolated and returned observations immutable', async () => {
  const f = fixture(); const other = orderApproval({ verify: f.verify }, f.now);
  const first = await f.approval.verify(grant); first.checkedAt = 0;
  f.at(start + 1500); expect((await f.approval.verify(grant)).checkedAt).toBe(start); await other.verify(grant);
  expect(f.verify).toHaveBeenCalledTimes(2);
});
it('local revocation is re-read at every use of the same exchange proof', async () => {
  const f = fixture(); let current = { ...grant };
  const source = { find: vi.fn(async () => current) };
  const service = new WalletAuthorizationService(source, f.approval, f.now);
  const request = { authorizationId: grant.id, userId: 1, strategyId: 2, walletId: 'wallet', network: 'testnet' as const, accountAddress: account, reduceOnly: false };
  await service.authorizeWithEvidence(request); f.at(start + 1500); current = { ...grant, revokedAt: start + 1500 };
  await expect(service.authorizeWithEvidence(request)).rejects.toBeDefined();
  expect(f.verify).toHaveBeenCalledOnce(); expect(source.find).toHaveBeenCalledTimes(3);
});

it('a delayed actual POST still refuses the originally observed proof instead of receiving a refreshed clock', async () => {
  const f = fixture(); const service = new WalletAuthorizationService({ find: async () => grant }, f.approval, f.now);
  const request = { authorizationId: grant.id, userId: 1, strategyId: 2, walletId: 'wallet', network: 'testnet' as const, accountAddress: account, reduceOnly: false };
  await service.authorizeWithEvidence(request); f.at(start + 4000);
  const verified = await service.authorizeWithEvidence(request); expect(verified.evidence.checkedAt).toBe(start);
  f.at(start + 5001); expect(() => assertVerifiedAuthorizationFresh(verified, request, f.now())).toThrow();
  expect(f.verify).toHaveBeenCalledOnce();
});
