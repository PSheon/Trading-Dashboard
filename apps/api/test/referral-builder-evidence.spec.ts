import { describe, expect, it, vi } from 'vitest';
import { BuilderEvidenceCollector, parseBuilderCsv, correlateBuilderFill, type BuilderFillBinding } from '../src/referral/referral-builder-evidence.js';
import { followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';

const builder = `0x${'a'.repeat(40)}`, account = `0x${'b'.repeat(40)}`;
const day = '20260908', epoch = Date.parse('2026-09-08T00:00:15Z');
// Header/time precision/side spelling verified against the official public
// builder export on 2026-10-04. Addresses and values below are test fixtures.
const header = 'time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee';
const line = `2026-09-08T00:00:15Z,${account},AVAX,Bid,8.0741,1.71,true,Na,Ioc,false,${builder},0,0,0.013806`;
const csv = `${header}\n${line}\n`;
function frame(text: string): Uint8Array {
  const body = Buffer.from(text), block = Buffer.alloc(4); block.writeUInt32LE((body.length | 0x80000000) >>> 0);
  return Buffer.concat([Buffer.from([4,34,77,24,96,112,0]), block, body, Buffer.alloc(4)]);
}
function binding(): BuilderFillBinding {
  const raw = { coin: 'AVAX', side: 'B', time: epoch + 567, px: '8.0741', sz: '1.71', closedPnl: '0', fee: '0.02', builderFee: '0.013806', feeToken: 'USDC', oid: 91, tid: 72 };
  return { userId: 7, network: 'mainnet', accountAddress: account,
    receipt: { key: `mainnet:${account}:72`, digest: followerReceiptDigestV1(raw), raw },
    journal: { key: 'order-1', userId: 7, network: 'mainnet', accountAddress: account, exchangeOrderId: '91', action: { type: 'order', builder: { b: builder, f: 100 } } } };
}
function fakeFetch(archive = frame(csv)) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/builder_fills/')) return new Response(Buffer.from(archive));
    const body = JSON.parse(String(init?.body));
    if (body.type === 'referral') return Response.json({ builderRewards: '10.000001', claimedRewards: '9', unclaimedRewards: '1.000001' });
    return Response.json([{ time: epoch, hash: `0x${'c'.repeat(64)}`, delta: { type: 'rewardsClaim', amount: '9', token: 'USDC' } }]);
  }) as unknown as typeof fetch;
}
describe('official builder export parsing and correlation', () => {
  it('preserves exact fees and flags missing canonical identifiers instead of inventing them', () => {
    const a = parseBuilderCsv(csv, { builder, day });
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ user: account, builderFee: '0.013806', time: epoch, side: 'B' });
    expect(a).toMatchObject({ timeResolutionMs: 1000, feeAsset: 'unspecified', canonicalFillIds: false });
    const result = correlateBuilderFill(a, binding());
    expect(result).toMatchObject({ kind: 'single_candidate', candidateRows: [1], receiptKey: `mainnet:${account}:72`, chargedBuilderFeeUnits: '13806', creditable: false });
  });
  it('does not deduplicate indistinguishable fills into a false exact match', () => {
    expect(correlateBuilderFill(parseBuilderCsv(csv + line + '\n', { builder, day }), binding())).toMatchObject({ kind: 'ambiguous', candidateRows: [1, 2], creditable: false });
  });
  it.each(['header', 'unknown-column', 'wrong-day', 'missing-fee', 'negative-fee', 'bad-quote', 'bad-date', 'path'])('rejects %s', reason => {
    let source = csv, chosenDay = day;
    if (reason === 'header') source = csv.replace('builder_fee', 'builderFee');
    if (reason === 'unknown-column') source = csv.replace(header, header + ',tid');
    if (reason === 'wrong-day') source = csv.replace('2026-09-08T', '2026-09-09T');
    if (reason === 'missing-fee') source = csv.replace('0.013806', '');
    if (reason === 'negative-fee') source = csv.replace('0.013806', '-0.01');
    if (reason === 'bad-quote') source += '"unfinished';
    if (reason === 'bad-date') chosenDay = '20260230';
    if (reason === 'path') chosenDay = '../20260908';
    expect(() => parseBuilderCsv(source, { builder, day: chosenDay })).toThrow();
  });
  it('supports CSV quotes and CRLF without trusting quoted numeric expressions', () => {
    expect(parseBuilderCsv(csv.replace('AVAX', '"AVAX"').replaceAll('\n', '\r\n'), { builder, day }).rows[0]!.coin).toBe('AVAX');
    expect(() => parseBuilderCsv(csv.replace('0.013806', '"=SUM(1,2)"'), { builder, day })).toThrow();
  });
  it.each(['testnet', 'owner', 'builder', 'oid', 'key', 'digest', 'amount', 'fee-cap'])('rejects mismatched %s binding', reason => {
    const b = binding();
    if (reason === 'testnet') b.network = 'testnet';
    if (reason === 'owner') b.journal.userId = 8;
    if (reason === 'builder') b.journal.action.builder.b = account;
    if (reason === 'oid') b.journal.exchangeOrderId = '92';
    if (reason === 'key') b.receipt.key = `mainnet:${account}:73`;
    if (reason === 'digest') b.receipt.digest = '0'.repeat(64);
    if (reason === 'amount') b.receipt.raw.builderFee = '0.03';
    if (reason === 'fee-cap') b.journal.action.builder.f = 10;
    expect(() => correlateBuilderFill(parseBuilderCsv(csv, { builder, day }), b)).toThrow();
  });
});

describe('bounded read-only builder evidence collector', () => {
  it('uses only fixed archive/info hosts, budgeted reads, and never converts aggregate reward claims into credit', async () => {
    const fetcher = fakeFetch(), acquire = vi.fn(async () => undefined);
    const result = await new BuilderEvidenceCollector(acquire, fetcher, () => epoch + 86400000).read({ builder, day });
    expect(result).toMatchObject({ creditable: false, collectionStatus: 'unproven', referral: { builderRewards: '10.000001' }, rewardsClaims: [{ amount: '9', token: 'USDC' }], ledgerCoverage: 'unproven' });
    expect(acquire).toHaveBeenCalledTimes(3);
    for (const [url, init] of vi.mocked(fetcher).mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/(stats-data\.hyperliquid\.xyz\/Mainnet\/builder_fills\/|api\.hyperliquid\.xyz\/info$)/);
      expect(init?.redirect).toBe('error');
      if (init?.method === 'POST') expect(['referral', 'userNonFundingLedgerUpdates']).toContain(JSON.parse(String(init.body)).type);
    }
  });
  it('treats missing archive as missing evidence, not zero revenue', async () => {
    const base = fakeFetch();
    const fetcher = vi.fn((url, init) => String(url).includes('/builder_fills/') ? Promise.resolve(new Response(null, { status: 404 })) : base(url, init)) as typeof fetch;
    const result = await new BuilderEvidenceCollector(async () => undefined, fetcher, () => epoch + 86400000).read({ builder, day });
    expect(result.archive.status).toBe('missing'); expect(result.creditable).toBe(false);
  });
  it('fails closed on compressed/decompressed/row/body limits', async () => {
    for (const limits of [{ maxCompressedBytes: 10 }, { maxDecodedBytes: 20 }, { maxRows: 1 }, { maxInfoBytes: 5 }]) {
      await expect(new BuilderEvidenceCollector(async () => undefined, fakeFetch(frame(csv + line + '\n')), () => epoch + 86400000, limits).read({ builder, day })).rejects.toThrow();
    }
  });
  it('rejects provider redirects, invalid reward shapes, and unsafe caller path before network use', async () => {
    const redirected = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } })) as typeof fetch;
    await expect(new BuilderEvidenceCollector(async () => undefined, redirected, () => epoch + 86400000).read({ builder, day })).rejects.toThrow();
    const f = fakeFetch();
    await expect(new BuilderEvidenceCollector(async () => undefined, f).read({ builder: '../bad', day })).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
    const bad = vi.fn(async (url) => String(url).includes('/builder_fills/') ? new Response(Buffer.from(frame(csv))) : Response.json({ builderRewards: 100 })) as typeof fetch;
    await expect(new BuilderEvidenceCollector(async () => undefined, bad, () => epoch + 86400000).read({ builder, day })).rejects.toThrow();
  });
  it('bounds budget waits and rejects concurrent reads through the same collector', async () => {
    const collector = new BuilderEvidenceCollector(() => new Promise(() => {}), fakeFetch(), () => epoch + 86400000, { timeoutMs: 10 });
    const first = collector.read({ builder, day });
    await expect(collector.read({ builder, day })).rejects.toThrow();
    await expect(first).rejects.toThrow();
  });
});
