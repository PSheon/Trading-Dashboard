import { describe, expect, it } from 'vitest';
import { Dec } from '../src/common/decimal/dec.js';
import { validateInfoResponse } from '../src/hyperliquid/response-validation.js';
import type { HlInfoRequestBody } from '../src/hyperliquid/types.js';
import { HyperliquidLiveSourceClient } from '../src/copy/copy-live-source.client.js';
import { parseLiveSourceFill, presumedTwapSlice, canonicalLiveSourceLegs } from '../src/copy/live/copy-live-source-evidence.js';
import { HyperliquidLiveAccountObserver, LiveObservationUnavailable } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidFollowerReceiptReader } from '../src/copy/live/follower-receipt-reader.js';
import { parseFollowerFill, parseFollowerFunding } from '../src/copy/live/actual-fill-accounting.js';
import { parseLiveOrderEvidence } from '../src/copy/live/live-order-evidence.js';
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from '../src/copy/live/live-order.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import { latestRecording, recordedHyperliquidInfo, UnrecordedInfoRequest } from './support/recorded-hyperliquid-info.js';

/**
 * The live copy path's decoders over what Hyperliquid mainnet really answered
 * (test/fixtures/hyperliquid, recorded by scripts/ops/hl-record.mjs; its README
 * says how to re-record). Five real-money incidents of Oct 18–22 2026 were
 * provider shapes no hand-written fixture had: a position size printed through
 * a float ("5725926.4000000004"), maker fills with a zero hash and no twapId,
 * a status read answering unknownOid. The recording holds every one of them.
 */
const info = recordedHyperliquidInfo(latestRecording('mainnet'));
const acquire = async () => undefined;
/** A leader with float-printed sizes and zero-hash maker fills; a TWAP-only leader; a follower-shaped account
 * (role user, abstraction disabled) with spot resting orders; an account with perp resting orders. */
const [leader, twapLeader, follower, restingAccount] = info.index.addresses as [string, string, string, string];
const ZERO_HASH = /^0x0{64}$/, HASH = /^0x[0-9a-f]{64}$/, grid = (size: string, decimals: number) => Dec.from(size).eq(Dec.from(size).round(decimals));
type Fill = { tid: number; oid: number; hash: string; crossed: boolean; twapId: number | null; coin: string; time: number; sz: string; startPosition: string; feeToken?: string };
type Slice = { fill: Fill; twapId: number };
type State = { time: number; assetPositions: { position: { coin: string; szi: string } }[] };
type Meta = { universe: { name: string; szDecimals: number }[] };
const sizeDecimals = (coin: string) => { const m = info.raw<Meta>({ type: 'meta' }).universe.find(u => u.name === coin); if (!m) throw new Error(`${coin} not in meta`); return m.szDecimals; };
/** The window both of an address's recorded lists answer for. */
const windowOf = (user: string, ...types: string[]) => {
  const coverages = types.map(type => info.entry({ type, user }).coverage!);
  return { from: Math.max(...coverages.map(c => c.from)), to: Math.min(...coverages.map(c => c.to)) };
};
const fillsOf = (user: string) => info.raw<Fill[]>({ type: 'userFillsByTime', user }), slicesOf = (user: string) => info.raw<Slice[]>({ type: 'userTwapSliceFillsByTime', user });
const observer = (now: number, source: ReturnType<typeof info.accountSource>) => new HyperliquidLiveAccountObserver('mainnet', acquire, info.fetcher, () => now, undefined, source);
/** A deterministic generator for the property tests (mulberry32). */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)), pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]! };
}
/** A grid size as a 17-significant-digit float print: how Hyperliquid printed "5725926.4000000004" and "-3311064.8999999999". */
const floatPrint = (size: string) => Number(size).toPrecision(17).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

describe('recorded Hyperliquid mainnet answers (fixtures/hyperliquid): the shapes every decoder of the copy path sees', () => {
  it('records the three incident shapes: a float-printed position size, zero-hash maker fills, an unknownOid status', () => {
    const noisy = info.index.addresses.flatMap(user => info.states(user).flatMap(([, s]) => (s as State).assetPositions.map(p => p.position.szi))).filter(szi => (szi.split('.')[1] ?? '').length > 6);
    expect(noisy.length).toBeGreaterThanOrEqual(7);
    expect(noisy).toContain('5725926.4000000004');
    const zeroHashMakers = fillsOf(leader).filter(f => ZERO_HASH.test(f.hash) && f.crossed === false && f.twapId === null);
    expect(zeroHashMakers.length).toBeGreaterThanOrEqual(12);
    expect(info.raw({ type: 'orderStatus', user: leader, oid: 1 })).toEqual({ status: 'unknownOid' });
    expect(info.index.totalBytes).toBeLessThan(2 * 1024 * 1024);
  });

  it("every recorded answer the info client has a schema for passes validateInfoResponse (the api's own decoder)", () => {
    const covered = ['meta', 'allPerpMetas', 'metaAndAssetCtxs', 'perpDexs', 'clearinghouseState', 'userFunding', 'userFillsByTime', 'userTwapSliceFillsByTime', 'spotClearinghouseState', 'userAbstraction', 'frontendOpenOrders'];
    const checked = info.entries().filter(e => covered.includes(e.type));
    expect(checked.length).toBeGreaterThanOrEqual(60);
    for (const entry of checked) expect(() => validateInfoResponse(entry.type as HlInfoRequestBody['type'], JSON.parse(info.text({ type: entry.type, ...entry.request }))), entry.file).not.toThrow();
    // The rest are read by the live readers below (spotMeta, userRole, userDexAbstraction, activeAssetData, orderStatus) or by the risk provider only (userFees).
    expect(new Set(info.entries().map(e => e.type).filter(t => !covered.includes(t)))).toEqual(new Set(['spotMeta', 'userRole', 'userDexAbstraction', 'userFees', 'activeAssetData', 'orderStatus']));
  });

  describe('leader fills → source evidence', () => {
    const fills = fillsOf(leader), slices = slicesOf(twapLeader);
    it(`decodes every recorded fill (${fills.length}) and TWAP slice (${slices.length}); every tid, oid and hash is accepted; zero-hash makers are ordinary fills`, () => {
      const window = windowOf(leader, 'userFillsByTime'), context = { network: 'mainnet' as const, leaderAddress: leader, from: window.from, to: window.to, receivedAt: window.to + 1 };
      const decoded = fills.map(raw => parseLiveSourceFill(raw, { ...context, kind: 'fills' }));
      expect(decoded).toHaveLength(fills.length);
      for (const [i, fill] of decoded.entries()) {
        expect(fill.tid).toBe(String(fills[i]!.tid)); expect(fill.oid).toBe(String(fills[i]!.oid));
        expect(fills[i]!.hash).toMatch(HASH); expect(fill.normalized.twapId).toBeNull(); expect(fill.tradeKey).toBe(`oid:${fill.oid}`);
        expect(canonicalLiveSourceLegs(fill).length).toBeGreaterThanOrEqual(1);
      }
      const skipped = fills.filter(presumedTwapSlice);
      expect(skipped, 'documented skips: zero hash + no twapId + taker (left to the TWAP endpoint)').toEqual([]);
      const zeroHash = fills.filter(f => ZERO_HASH.test(f.hash));
      expect(zeroHash.length).toBeGreaterThanOrEqual(12); expect(zeroHash.every(f => f.crossed === false)).toBe(true);
      const twapWindow = windowOf(twapLeader, 'userTwapSliceFillsByTime');
      const twapDecoded = slices.map(raw => parseLiveSourceFill(raw, { network: 'mainnet', leaderAddress: twapLeader, from: twapWindow.from, to: twapWindow.to, receivedAt: twapWindow.to + 1, kind: 'twap' }));
      expect(twapDecoded).toHaveLength(slices.length);
      for (const [i, fill] of twapDecoded.entries()) { expect(fill.normalized.twapId).toBe(String(slices[i]!.twapId)); expect(fill.tradeKey).toBe(`twap:${slices[i]!.twapId}`); }
      // The provider's own shape: every slice's hash is zero, its inner twapId null, and it is a taker.
      expect(new Set(slices.map(s => s.fill.hash))).toEqual(new Set([`0x${'0'.repeat(64)}`]));
      expect(slices.every(s => s.fill.twapId === null && s.fill.crossed === true && presumedTwapSlice(s.fill))).toBe(true);
    });
    it('a fast-source read over the recorded window keeps every fill: count = unique tids − presumed slices without a tagged copy (none here)', async () => {
      for (const [user, rows, count] of [[leader, fills, fills.length], [twapLeader, slices, slices.length]] as const) {
        const window = windowOf(user, 'userFillsByTime', 'userTwapSliceFillsByTime');
        const result = await new HyperliquidLiveSourceClient('mainnet', acquire, info.fetcher, () => window.to + 1).read({ leaderAddress: user, from: window.from, to: window.to, maxRequests: 64 });
        const tids = new Set(rows.map(r => ('fill' in r ? r.fill.tid : r.tid)));
        expect(tids.size).toBe(count);
        expect(result.fills.map(f => f.tid).sort()).toEqual([...tids].map(String).sort());
        expect(result.unresolved).toEqual([]); expect(result.complete).toBe(true);
        // 500 rows in one window is "possibly capped" (POSSIBLE_CAP): the client bisects until every window is below it (TWAP slices come in bursts).
        expect(result.observations.filter(o => o.saturated).length).toBe(count >= 500 ? result.observations.filter(o => o.count >= 500).length : 0);
        expect(result.observations.filter(o => o.saturated).length > 0).toBe(count >= 500);
        expect(result.requestsUsed).toBeGreaterThanOrEqual(2); expect(result.requestsUsed).toBeLessThanOrEqual(64);
      }
    });
    it('surprise: fills carry a float-printed startPosition ("5756507.7000000002"); the normalizer keeps it to the digit and legs are classified from it', () => {
      const noisy = fills.filter(f => (f.startPosition.split('.')[1] ?? '').length > sizeDecimals(f.coin));
      expect(noisy.length).toBeGreaterThan(0);
      const window = windowOf(leader, 'userFillsByTime');
      for (const raw of noisy) {
        const fill = parseLiveSourceFill(raw, { network: 'mainnet', leaderAddress: leader, from: window.from, to: window.to, receivedAt: window.to + 1, kind: 'fills' });
        expect(fill.startPosition).toBe(raw.startPosition);
        expect(canonicalLiveSourceLegs(fill).length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('clearinghouseState → observed positions (the float-grid path)', () => {
    it('surprise: the leader with the float-printed NEAR size also holds prediction-market outcome tokens (spot balances without a token index): its leader observation is unavailable, so its positions are never read', async () => {
      const balances = info.raw<{ balances: { coin: string; token?: number }[] }>({ type: 'spotClearinghouseState', user: leader }).balances;
      const untokened = balances.filter(b => b.token === undefined);
      // Outcome tokens ("+158850") and "o458"-style coins carry no `token` index; the observer's spot schema requires one.
      expect(untokened.length).toBeGreaterThanOrEqual(28); expect(untokened.every(b => /^[+o]\d+$/.test(b.coin))).toBe(true);
      const times = info.stateTimes(leader), now = Math.max(...times) + 1;
      const refusal = await observer(now, info.accountSource(leader, () => now)).observe(leader, { leader: true }).then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(LiveObservationUnavailable);
      expect(String((refusal as Error).cause)).toContain('balances');
    });
    it.each([twapLeader, restingAccount])('%s: a leader observation accepts every recorded position, each size on its coin\'s grid', async (user) => {
      const times = info.stateTimes(user), now = Math.max(...times) + 1;
      expect(now - Math.min(...times), 'the venues were recorded within the 5 s evidence window').toBeLessThan(5000);
      const snapshot = await observer(now, info.accountSource(user, () => now)).observe(user, { leader: true });
      const raw = info.states(user).flatMap(([dex, s]) => (s as State).assetPositions.map(p => ({ dex, ...p.position })));
      expect(snapshot.positions).toHaveLength(raw.length);
      expect(snapshot.dexes).toHaveLength(info.raw<unknown[]>({ type: 'perpDexs' }).length);
      let noisy = 0;
      for (const position of snapshot.positions) {
        const source = raw.find(p => p.coin === position.coin)!;
        expect(grid(position.size, position.sizeDecimals), `${position.coin} ${position.size}`).toBe(true);
        if (!grid(source.szi, position.sizeDecimals)) { noisy++; expect(Dec.from(source.szi).sub(position.size).abs().lte(Dec.from(`1e-${position.sizeDecimals + 3}`))).toBe(true); }
        else expect(Dec.from(position.size).eq(source.szi)).toBe(true);
      }
      expect(noisy, 'float-printed sizes the grid rule read back').toBeGreaterThanOrEqual(1);
      expect(snapshot.coverage.complete).toBe(true);
    });
  });

  describe('frontendOpenOrders → resting orders', () => {
    type Order = { coin: string; sz: string; origSz: string; oid: number; cloid: string | null; isTrigger: boolean; isPositionTpsl: boolean; tif: string; timestamp: number };
    const spotOrders = info.raw<Order[]>({ type: 'frontendOpenOrders', user: follower }), perpOrders = info.raw<Order[]>({ type: 'frontendOpenOrders', user: restingAccount });
    it('a follower observation accepts every recorded perp resting order (its oid, remaining and original size, null cloid, Gtc, reduce-only)', async () => {
      // The follower-shaped account's own modes (role user, abstraction disabled, no dex abstraction: what a copy account
      // reports) with the resting account's recorded order rows on its order channel: the rows carry no account field.
      expect(info.raw({ type: 'userRole', user: follower })).toEqual({ role: 'user' });
      expect(info.raw({ type: 'userAbstraction', user: follower })).toBe('disabled'); expect(info.raw({ type: 'userDexAbstraction', user: follower })).toBe(false);
      expect(perpOrders.length).toBeGreaterThanOrEqual(5); expect(perpOrders.every(o => !o.coin.startsWith('@') && o.cloid === null && !o.isTrigger && !o.isPositionTpsl)).toBe(true);
      const times = info.stateTimes(follower), now = Math.max(...times) + 1;
      const source = { ...info.accountSource(follower, () => now), readOrders: async (user: string, dexes: readonly string[]) => ({ network: 'mainnet' as const, accountAddress: user, observedAt: now, completedAt: now,
        requestedDexes: [...dexes], venues: dexes.map(dex => ({ dex, user, observedAt: now, receivedAt: now, orders: dex ? [] : perpOrders })) }) };
      const snapshot = await observer(now, source).observe(follower);
      expect(snapshot.restingOrders.map(o => o.oid).sort()).toEqual(perpOrders.map(o => String(o.oid)).sort());
      for (const o of snapshot.restingOrders) {
        const raw = perpOrders.find(p => String(p.oid) === o.oid)!;
        expect(o.cloid).toBeNull(); expect(grid(o.remainingSize, sizeDecimals(o.coin))).toBe(true);
        expect(Dec.from(o.remainingSize).eq(raw.sz)).toBe(true); expect(Dec.from(o.originalSize).eq(raw.origSz)).toBe(true); expect(o.timestamp).toBe(raw.timestamp);
      }
      expect(snapshot.positions.length).toBe(info.raw<State>({ type: 'clearinghouseState', user: follower }).assetPositions.length);
      expect(snapshot.coverage.orderComplete).toBe(true);
    });
    it('the follower-shaped account\'s own resting orders are all on a spot pair ("@260"), in the main dex\'s frontendOpenOrders next to perps', () => {
      expect(spotOrders.length).toBeGreaterThanOrEqual(19); expect(spotOrders.every(o => o.coin.startsWith('@'))).toBe(true);
    });
    it('surprise: a resting order on a spot pair ("@260", in the main dex\'s frontendOpenOrders) makes the whole observation unavailable, not a named refusal', async () => {
      const times = info.stateTimes(follower), now = Math.max(...times) + 1;
      // No order channel: the observer reads frontendOpenOrders itself, spot orders included.
      await expect(observer(now, info.accountSource(follower, () => now)).observe(follower)).rejects.toBeInstanceOf(LiveObservationUnavailable);
    });
  });

  describe('orderStatus → order evidence', () => {
    const record = (() => {
      const createdAt = 1_792_753_000_000, market = { network: 'mainnet' as const, coin: 'NEAR', dex: '', asset: 0, universeIndex: 0, perpDexIndex: 0, sizeDecimals: 1, maxLeverage: 10, observedAt: createdAt };
      const intent: LiveOrderIntent = { authorizationId: 'grant', userId: 1, strategyId: 9, walletId: 'agent', network: 'mainnet', accountAddress: leader as `0x${string}`, reduceOnly: true,
        cloid: '0xa79a8cd79eea2b7fdad1636e4f906b60', asset: 0, side: 'A', size: '5.2', limitPrice: '4.8777', sizeDecimals: 1, timeInForce: 'Alo', market };
      const action = buildOrderAction(intent);
      return { key: executionKey(intent), fingerprint: intentFingerprint(intent, action), market, action, nonce: createdAt, expiresAfter: createdAt + 60000, state: 'unknown', createdAt, updatedAt: createdAt,
        authorization: { id: 'grant', version: 1, userId: 1, strategyId: 9, walletId: 'agent', privyOwnerId: 'owner', signerAddress: `0x${'22'.repeat(20)}`, accountAddress: leader, network: 'mainnet',
          scopes: ['copy:trade'], validFrom: createdAt - 1, expiresAt: createdAt + 60000, revokedAt: null, exchangeApprovedAt: createdAt - 1 } } as unknown as LiveExecutionRecord;
    })();
    it('the found order (status "order", a filled Alo reduce-only order) carries every field the transport and the evidence parser read', () => {
      const found = info.raw<{ status: string; order: { status: string; statusTimestamp: number; order: Record<string, unknown> } }>({ type: 'orderStatus', user: leader, oid: 583575700359 });
      expect(found.status).toBe('order');
      expect(found.order.order).toMatchObject({ coin: 'NEAR', oid: 583575700359, side: 'A', tif: 'Alo', reduceOnly: true, isTrigger: false, isPositionTpsl: false, children: [], origSz: '5.2', sz: '0.0', limitPx: '4.8777' });
      expect(found.order.order.cloid).toMatch(/^0x[0-9a-f]{32}$/); expect(found.order.status).toBe('filled');
      expect(found.order.statusTimestamp).toBeGreaterThanOrEqual(found.order.order.timestamp as number);
      // The same order as if it were ours: the evidence parser reads it as a full fill.
      const now = found.order.statusTimestamp + 100, placed = (found.order.order.timestamp as number) - 10, market = { ...record.market!, observedAt: now - 1000 };
      const evidence = parseLiveOrderEvidence({ record: { ...record, createdAt: placed, updatedAt: placed, nonce: placed, expiresAfter: placed + 60000, market }, market, raw: found, checkedAt: now - 50, completedAt: now - 40, now });
      expect(evidence).toMatchObject({ kind: 'order', classification: 'filled', oid: '583575700359', quantity: { kind: 'full', filledSize: '5.2' }, providerStatus: 'filled' });
    });
    it('unknownOid (an order never placed, and — surprise — a TWAP slice\'s own oid) parses as a missing observation that binds nothing', () => {
      const now = record.createdAt + 2000;
      for (const match of [{ type: 'orderStatus', user: leader, oid: 1 }, { type: 'orderStatus', user: twapLeader, oid: 582907588354 }]) {
        const raw = info.raw({ ...match });
        expect(raw).toEqual({ status: 'unknownOid' });
        const evidence = parseLiveOrderEvidence({ record: { ...record, market: { ...record.market!, observedAt: now - 1000 } }, market: { ...record.market!, observedAt: now - 1000 }, raw, checkedAt: now - 100, completedAt: now - 90, now });
        expect(evidence.kind).toBe('missing');
      }
      const slice = slicesOf(twapLeader).at(-1)!;
      expect(slice.fill.oid, "the TWAP slice whose oid orderStatus does not know").toBe(582907588354);
    });
  });

  describe('follower receipts (the leader read as if it were a follower)', () => {
    it('every recorded fill parses as a follower fill receipt and every funding row as a funding receipt; the funding hash is the zero hash', () => {
      const window = windowOf(leader, 'userFillsByTime', 'userFunding');
      const context = { network: 'mainnet' as const, accountAddress: leader, minTime: window.from, maxTime: window.to };
      const fills = fillsOf(leader), refused: string[] = [];
      for (const raw of fills) { try { parseFollowerFill(raw, context); } catch (error) { refused.push((error as { code?: string }).code ?? 'unknown'); } }
      expect(refused, 'documented skips').toEqual([]);
      for (const user of info.index.addresses) {
        const funding = info.raw<{ hash: string; delta: { nSamples: unknown } }[]>({ type: 'userFunding', user }), coverage = info.entry({ type: 'userFunding', user }).coverage!;
        for (const raw of funding) expect(() => parseFollowerFunding(raw, { network: 'mainnet', accountAddress: user, minTime: coverage.from, maxTime: coverage.to })).not.toThrow();
        expect(funding.every(f => ZERO_HASH.test(f.hash))).toBe(true);
      }
    });
    it('a receipt read over the recorded window returns every fill and funding row', async () => {
      const window = windowOf(leader, 'userFillsByTime', 'userFunding');
      const result = await new HyperliquidFollowerReceiptReader('mainnet', acquire, info.fetcher, () => window.to + 1).read({ accountAddress: leader, from: window.from, to: window.to, maxRequests: 16 });
      expect(result.fills).toHaveLength(fillsOf(leader).length);
      expect(result.funding).toHaveLength(info.raw<unknown[]>({ type: 'userFunding', user: leader }).length);
      expect(result.unresolvedWindows).toEqual([]); expect(result.fresh).toBe(true);
    });
  });

  it('the market resolver reads the recorded main-dex meta: the incident coins resolve with their size decimals', async () => {
    const resolver = new HyperliquidLiveMarketResolver('mainnet', acquire, info.fetcher, () => 1_792_755_000_000);
    await expect(resolver.resolve('NEAR')).resolves.toMatchObject({ coin: 'NEAR', dex: '', sizeDecimals: 1 });
    await expect(resolver.resolve('FARTCOIN')).resolves.toMatchObject({ coin: 'FARTCOIN', sizeDecimals: 1 });
  });

  it('an unrecorded request fails loudly, naming the request and the recording', async () => {
    await expect(info.fetcher(info.index.endpoint, { method: 'POST', body: JSON.stringify({ type: 'allMids' }) })).rejects.toThrow(UnrecordedInfoRequest);
    await expect(info.fetcher(info.index.endpoint, { method: 'POST', body: JSON.stringify({ type: 'clearinghouseState', user: `0x${'99'.repeat(20)}` }) })).rejects.toThrow(/no recording for .*clearinghouseState.*9999/);
    const window = windowOf(leader, 'userFillsByTime');
    await expect(info.fetcher(info.index.endpoint, { method: 'POST', body: JSON.stringify({ type: 'userFillsByTime', user: leader, startTime: window.from - 1 }) })).rejects.toThrow(/outside the recorded coverage/);
    await expect(info.fetcher('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', body: '{}' })).rejects.toThrow(/not the recorded endpoint/);
  });
});

describe('property tests for the three incident shapes (seeded generators; each fails on the code before its fix)', () => {
  it('float-printed sizes: for any grid size of a recorded position\'s coin, the observer reads its 17-digit float print back as that grid value (pre-fix: live_account_invalid_position)', async () => {
    // The TWAP leader's recording (40 main-dex positions, six of them float-printed); the other leader's spot balances refuse its observation (above).
    const random = rng(20261018), times = info.stateTimes(twapLeader), now = Math.max(...times) + 1;
    const cases: { coin: string; exact: string; printed: string }[] = [];
    for (let i = 0; i < 24; i++) {
      const expected = new Map<string, string>();
      const mutate = (dex: string, state: Record<string, unknown>) => dex ? state : { ...state, assetPositions: (state as State).assetPositions.map(p => {
        const decimals = sizeDecimals(p.position.coin), step = Dec.from(`1e-${decimals}`);
        // Sizes of at least 0.01: a 17-significant-digit print of a smaller one has more than the 18 decimals the schema allows.
        let exact: string;
        do exact = step.mul(random.int(1, 10 ** random.int(1, 7))).mul(random.pick([1, -1])).toString(); while (Dec.from(exact).abs().lt(Dec.from('0.01')));
        const printed = floatPrint(exact);
        expected.set(p.position.coin, exact); cases.push({ coin: p.position.coin, exact, printed });
        return { ...p, position: { ...p.position, szi: printed } };
      }) };
      const snapshot = await observer(now, info.accountSource(twapLeader, () => now, mutate)).observe(twapLeader, { leader: true });
      for (const position of snapshot.positions) if (!position.dex) expect(position.size, `${position.coin}`).toBe(expected.get(position.coin));
    }
    const noisy = cases.filter(c => c.printed !== c.exact && !grid(c.printed, sizeDecimals(c.coin)));
    expect(noisy.length, 'cases whose float print left the grid').toBeGreaterThan(cases.length / 4);
    expect(noisy.some(c => c.printed.endsWith('0000000004') || c.printed.endsWith('9999999996') || c.printed.endsWith('0000000002') || c.printed.endsWith('9999999998'))).toBe(true);
  });

  it('zero-hash maker fills: for any maker fill (crossed false) with a zero hash and no twapId, the fast source keeps it as an ordinary fill (pre-fix: skipped as a presumed TWAP slice, never copied)', async () => {
    const random = rng(20261019), from = 1_792_700_000_000, to = from + 3_600_000, coins = ['FARTCOIN', 'NEAR', 'BTC', 'xyz:MU'];
    const fill = (tid: number, crossed: boolean) => ({ coin: random.pick(coins), px: String(random.int(1, 100000) / 100), sz: String(random.int(1, 999999) / 10), side: random.pick(['A', 'B']), time: random.int(from, to),
      startPosition: String(random.int(-9999999, 9999999) / 10), dir: 'Open Long', closedPnl: '0.0', hash: `0x${'0'.repeat(64)}`, oid: random.int(1, 1e12), crossed, fee: String(random.int(-1000, 1000) / 1e6), tid,
      cloid: `0x${random.int(0, 0xffff).toString(16).padStart(4, '0').repeat(8)}`, feeToken: 'USDC', ...(random.next() < 0.5 ? { twapId: null } : {}) });
    const makers = Array.from({ length: 120 }, (_, i) => fill(1000 + i, false));
    for (const m of makers) expect(presumedTwapSlice(m), JSON.stringify(m)).toBe(false);
    const client = (rows: unknown[]) => new HyperliquidLiveSourceClient('mainnet', acquire, (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { type: string; startTime: number; endTime: number };
      return Response.json(body.type === 'userFillsByTime' ? (rows as { time: number }[]).filter(r => r.time >= body.startTime && r.time <= body.endTime) : []);
    }) as typeof fetch, () => to + 1);
    const kept = await client(makers).read({ leaderAddress: leader, from, to, maxRequests: 8 });
    expect(kept.fills.map(f => f.tid).sort()).toEqual(makers.map(m => String(m.tid)).sort());
    expect(kept.unresolved).toEqual([]); expect(kept.complete).toBe(true);
    // The rule still leaves a zero-hash *taker* fill without a twapId to the TWAP endpoint (the generator discriminates on `crossed` alone).
    const takers = makers.map(m => ({ ...m, crossed: true }));
    expect(takers.every(presumedTwapSlice)).toBe(true);
    const left = await client(takers).read({ leaderAddress: leader, from, to, maxRequests: 8 });
    expect(left.fills).toEqual([]); expect(new Set(left.unresolved.map(u => u.reason))).toEqual(new Set(['twap_identity_unproven'])); expect(left.unresolved).toHaveLength(takers.length);
  });

  it('unknown oid: for any status read answering unknownOid, the evidence is a missing observation (kind "missing") whose digest covers the raw answer; nothing is classified or bound (the ledger rule on it: copy-follower-ledger.spec)', () => {
    const random = rng(20261018), createdAt = 1_792_753_000_000;
    const market = { network: 'mainnet' as const, coin: 'NEAR', dex: '', asset: 0, universeIndex: 0, perpDexIndex: 0, sizeDecimals: 1, maxLeverage: 10, observedAt: createdAt };
    for (let i = 0; i < 100; i++) {
      const size = String(random.int(1, 99999) / 10), cloid = `0x${random.int(0, 0xffffffff).toString(16).padStart(8, '0').repeat(4)}` as `0x${string}`;
      const intent: LiveOrderIntent = { authorizationId: 'grant', userId: 1, strategyId: 9, walletId: 'agent', network: 'mainnet', accountAddress: leader as `0x${string}`, reduceOnly: random.next() < 0.5,
        cloid, asset: 0, side: random.pick(['A', 'B']), size, limitPrice: String(random.int(1, 99999) / 10000), sizeDecimals: 1, timeInForce: 'Ioc', market };
      const action = buildOrderAction(intent);
      const record = { key: executionKey(intent), fingerprint: intentFingerprint(intent, action), market, action, nonce: createdAt, expiresAfter: createdAt + 60000, state: 'unknown', createdAt, updatedAt: createdAt,
        authorization: { id: 'grant', version: 1, userId: 1, strategyId: 9, walletId: 'agent', privyOwnerId: 'owner', signerAddress: `0x${'22'.repeat(20)}`, accountAddress: leader, network: 'mainnet',
          scopes: ['copy:trade'], validFrom: createdAt - 1, expiresAt: createdAt + 60000, revokedAt: null, exchangeApprovedAt: createdAt - 1 } } as unknown as LiveExecutionRecord;
      const checkedAt = createdAt + random.int(1, 3000), completedAt = checkedAt + random.int(0, 500), now = completedAt + random.int(0, 500);
      const raw = { status: 'unknownOid', ...(random.next() < 0.3 ? { user: leader } : {}), ...(random.next() < 0.3 ? { oid: random.int(1, 1e12) } : {}) };
      const evidence = parseLiveOrderEvidence({ record, market: { ...market, observedAt: now - random.int(0, 4000) }, raw, checkedAt, completedAt, now });
      expect(evidence.kind).toBe('missing');
      expect(evidence).not.toHaveProperty('classification'); expect(evidence).not.toHaveProperty('oid');
      expect(evidence.sourceDigest).toMatch(/^[0-9a-f]{64}$/); expect(evidence.raw).toEqual(raw);
      const other = parseLiveOrderEvidence({ record, market: { ...market, observedAt: now - 1 }, raw: { status: 'unknownOid', nonce: i }, checkedAt, completedAt, now });
      expect(other.sourceDigest).not.toBe(evidence.sourceDigest);
    }
  });
});
