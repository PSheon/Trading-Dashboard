import { expect, it } from 'vitest';
import { CopyFollowerActivityService } from '../src/copy/copy-follower-activity.service.js';
import type { CopyFollowerActivityRepository } from '../src/copy/copy-follower-activity.repository.js';
import { followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
const address = `0x${'11'.repeat(20)}`, time = new Date(Date.now() - 1000);
function data() { const value = { account: { id: 'account', strategyId: 9, network: 'testnet' as const, address }, state: null, scan: null, hasMore: false,
  receipts: [{ key: `testnet:${address}:1`, accountId: 'account', network: 'testnet', accountAddress: address, kind: 'fill', sourceId: '1', coin: 'BTC', providerTime: time,
    attribution: 'execution', executionKey: 'execution', record: { raw: { coin: 'BTC', tid: 1, oid: 7, side: 'B', time: time.getTime(), px: '100', sz: '0.01', closedPnl: '2', fee: '0.06', builderFee: '0.02', feeToken: 'USDC', secret: 'never-public' } } }],
  components: [{ receiptKey: `testnet:${address}:1`, component: 'realized_pnl', amount: '2', token: 'USDC' }, { receiptKey: `testnet:${address}:1`, component: 'exchange_fee', amount: '-0.04', token: 'USDC' }, { receiptKey: `testnet:${address}:1`, component: 'builder_fee', amount: '-0.02', token: 'USDC' }] }; return { ...value, receipts: value.receipts.map(r => ({ ...r, digest: followerReceiptDigestV1(r.record.raw) })) }; }
function service(value = data()) { return new CopyFollowerActivityService({ getOwnedPage: async () => value } as unknown as CopyFollowerActivityRepository); }
it('projects exactly booked fees once and exposes no raw JSON or unknown ROI', async () => {
  const page = await service().get(1, 'account', {});
  expect(page).toMatchObject({ mode: 'actual', network: 'testnet', accountId: 'account', token: 'USDC', hasMore: false,
    items: [{ kind: 'fill', oid: '7', tid: '1', size: '0.01', price: '100', realizedPnl: '2', exchangeFee: '-0.04', builderFee: '-0.02', tradingCashDelta: '1.94' }], coverage: { historicalCompleteness: 'unproven', scannedThrough: null, unresolvedWindows: null } });
  expect(JSON.stringify(page)).not.toMatch(/never-public|raw|record|totalFee|equity|roi/);
});
it.each(['realized_pnl', 'exchange_fee', 'builder_fee'])('accepts absent zero %s only from the exact digest-verified receipt', async component => {
  const zero = data(); Object.assign(zero.receipts[0].record.raw, { closedPnl: '0', fee: '0', builderFee: '0' });
  zero.receipts[0].digest = followerReceiptDigestV1(zero.receipts[0].record.raw); zero.components.forEach(c => { c.amount = '0'; });
  expect((await service(zero).get(1, 'account', {})).items[0]).toMatchObject({ realizedPnl: '0', exchangeFee: '0', builderFee: '0', tradingCashDelta: '0' });
  zero.components = zero.components.filter(c => c.component !== component);
  expect((await service(zero).get(1, 'account', {})).items[0]).toMatchObject({ tradingCashDelta: '0' });
  zero.receipts[0].record.raw.secret = 'changed-digest'; await expect(service(zero).get(1, 'account', {})).rejects.toThrow('Follower activity unavailable');
});
it('accepts absent zero funding only from the exact digest-verified receipt', async () => {
  const value = data(), hash = `0x${'44'.repeat(32)}`, raw = { hash, time: time.getTime(), delta: { type: 'funding', coin: 'BTC', usdc: '0' } };
  const funding = { ...value, receipts: [{ ...value.receipts[0], key: `testnet:${address}:${hash}:BTC:${time.getTime()}`, kind: 'funding', sourceId: hash, attribution: 'account', executionKey: null, record: { raw }, digest: followerReceiptDigestV1(raw) }], components: [{ receiptKey: `testnet:${address}:${hash}:BTC:${time.getTime()}`, component: 'funding', amount: '0', token: 'USDC' }] };
  expect((await service(funding as unknown as ReturnType<typeof data>).get(1, 'account', {})).items[0]).toMatchObject({ funding: '0' });
  funding.components = []; expect((await service(funding as unknown as ReturnType<typeof data>).get(1, 'account', {})).items[0]).toMatchObject({ funding: '0', tradingCashDelta: '0' });
  funding.receipts[0].record.raw.delta.usdc = '1'; await expect(service(funding as unknown as ReturnType<typeof data>).get(1, 'account', {})).rejects.toThrow('Follower activity unavailable');
});
it.each(['realized_pnl', 'exchange_fee', 'builder_fee'])('rejects an absent nonzero %s booking', async component => {
  const value = data(); value.components = value.components.filter(c => c.component !== component);
  await expect(service(value).get(1, 'account', {})).rejects.toThrow('Follower activity unavailable');
});
it('refuses changed raw evidence even when the booked money fields still agree', async () => {
  const value = data(); value.receipts[0].record.raw.secret = 'changed-proof';
  await expect(service(value).get(1, 'account', {})).rejects.toThrow('Follower activity unavailable');
});
it.each([
  ['changed booked amount', (v: any) => { v.components[0].amount = '3'; }],
  ['wrong identity', (v: any) => { v.receipts[0].accountAddress = `0x${'22'.repeat(20)}`; }],
  ['wrong source identity', (v: any) => { v.receipts[0].sourceId = '2'; }],
  ['wrong coin', (v: any) => { v.receipts[0].coin = 'ETH'; }],
  ['wrong time', (v: any) => { v.receipts[0].providerTime = new Date(0); }],
  ['unbound execution attribution', (v: any) => { v.receipts[0].executionKey = null; }],
  ['malformed amount', (v: any) => { v.receipts[0].record.raw.fee = null; }],
] as const)('refuses %s at the safe public projection boundary', async (_name, change) => { const value = data(); change(value); await expect(service(value).get(1, 'account', {})).rejects.toThrow('Follower activity unavailable'); });
it.each([{ limit: 51 }, { after: '0' }, { before: 'x'.repeat(2049) }])('refuses unbounded or forward-replay query %j', query => expect(service().get(1, 'account', query)).rejects.toThrow());
