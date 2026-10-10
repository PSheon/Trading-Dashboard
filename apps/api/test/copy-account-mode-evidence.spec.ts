import { describe, expect, it, vi } from 'vitest';
import { HyperliquidAccountModeAbsenceReader } from '../src/copy/copy-account-mode-evidence.js';
import type { LiveAllDexsAccountEvidence } from '../src/copy/live/live-account-ws-source.js';
const user = `0x${'22'.repeat(20)}`, time = 1_800_000_000_000;
function state() { return { marginSummary: { accountValue: '100', totalRawUsd: '100', totalNtlPos: '0', totalMarginUsed: '0' },
  crossMarginSummary: { accountValue: '100', totalRawUsd: '100', totalNtlPos: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '100', time, assetPositions: [] }; }
function setup() {
  let clock = time, dexes: ({ name: string } | null)[] = [null, { name: 'xyz' }];
  let patch: ((proof: LiveAllDexsAccountEvidence) => LiveAllDexsAccountEvidence) | undefined;
  const budget = vi.fn(async (_weight: number) => undefined);
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    expect(url).toBe('https://api.hyperliquid-testnet.xyz/info'); expect(options?.redirect).toBe('error');
    const body = JSON.parse(String(options?.body));
    if (body.type === 'perpDexs') return Response.json(dexes);
    if (body.type === 'spotClearinghouseState') return Response.json({ balances: [], portfolioMarginEnabled: false });
    if (body.type === 'extraAgents') return Response.json([]);
    throw new Error('unexpected read');
  });
  const readAccount = vi.fn(async (address: string, requested: readonly string[]) => {
    const data: LiveAllDexsAccountEvidence = { state: { network: 'testnet', accountAddress: address, observedAt: clock,
      data: { user: address, clearinghouseStates: requested.map(dex => [dex, state()]) } },
      orders: { network: 'testnet', accountAddress: address, observedAt: clock, completedAt: clock, requestedDexes: [...requested],
        venues: requested.map(dex => ({ dex, user: address, observedAt: clock, receivedAt: clock, orders: [] })) } };
    return patch ? patch(data) : data;
  });
  const reader = new HyperliquidAccountModeAbsenceReader('testnet', budget, fetcher, () => clock, { read: vi.fn(), readAccount });
  return { reader, budget, fetcher, readAccount, setClock: (n: number) => { clock = n; },
    setDexes: (d: typeof dexes) => { dexes = d; }, patch: (fn: NonNullable<typeof patch>) => { patch = fn; } };
}
describe('all-venue mode-bootstrap absence proof', () => {
  it('charges only dispatched stages when the first REST evidence is rejected', async () => {
    const s = setup(); let spent = 0;
    s.fetcher.mockImplementation(async () => Response.json({}, { status: 500 }));
    await expect(s.reader.prove(user, { prepaid: true, consume: weight => { spent += weight; } })).rejects.toThrow('account_mode_absence_unproven');
    expect(spent).toBe(42);
  });
  it('proves only absence across every indexed venue, retaining opaque names and null holes', async () => {
    const s = setup(); s.setDexes([null, null, { name: 'i<3fl' }, ...Array.from({ length: 265 }, (_, i) => ({ name: `dex${i}` }))]);
    const result = await s.reader.prove(user); expect(result).toMatchObject({ network: 'testnet', accountAddress: user, complete: true, empty: true, observedAt: time });
    expect(result.dexes).toHaveLength(267); expect(result.dexes.slice(0, 2)).toEqual(['', 'i<3fl']); expect(Object.isFrozen(result.dexes)).toBe(true);
    // One reservation (20 + 2 + 20 + 40 + 20), before the clock starts.
    expect(s.budget.mock.calls.map(c => c[0])).toEqual([102]); expect(s.readAccount).toHaveBeenCalledTimes(1);
  });
  it.each(['missing-state', 'duplicate-state', 'position', 'margin', 'missing-order', 'nonempty-order', 'wrong-user', 'wrong-network', 'stale', 'future'])('refuses %s coverage', async kind => {
    const s = setup(); s.patch(proof => {
      const states = (proof.state.data as { clearinghouseStates: [string, ReturnType<typeof state>][] }).clearinghouseStates;
      if (kind === 'missing-state') states.pop();
      if (kind === 'duplicate-state') states[1]![0] = '';
      if (kind === 'position') states[1]![1].assetPositions = [{}] as never;
      if (kind === 'margin') states[1]![1].marginSummary.totalMarginUsed = '1';
      if (kind === 'missing-order') (proof.orders.venues as unknown[]).pop();
      if (kind === 'nonempty-order') (proof.orders.venues[1]!.orders as unknown[]).push({ coin: 'xyz:ABC', isTrigger: true });
      if (kind === 'wrong-user') return { ...proof, state: { ...proof.state, accountAddress: `0x${'33'.repeat(20)}` } };
      if (kind === 'wrong-network') return { ...proof, orders: { ...proof.orders, network: 'mainnet' as 'testnet' } };
      if (kind === 'stale') return { ...proof, orders: { ...proof.orders, observedAt: time - 5001 } };
      if (kind === 'future') return { ...proof, state: { ...proof.state, observedAt: time + 1 } };
      return proof;
    });
    await expect(s.reader.prove(user)).rejects.toThrow('account_mode_absence_unproven');
  });
  it('rejects malformed, duplicate or too many listed dexes', async () => {
    for (const list of [[null, { name: 'x' }, { name: 'x' }], [null, { name: '' }], [null, ...Array.from({ length: 1000 }, (_, i) => ({ name: `d${i}` }))]]) {
      const s = setup(); s.setDexes(list); await expect(s.reader.prove(user)).rejects.toThrow('account_mode_absence_unproven');
    }
  });
  it('rejects dex-list changes before returning completeness', async () => {
    const s = setup(); s.patch(proof => { s.setDexes([null, { name: 'new' }]); return proof; });
    await expect(s.reader.prove(user)).rejects.toThrow('account_mode_absence_unproven');
  });
  it('keeps earliest source age through final metadata', async () => {
    const s = setup(); let n = 0; const fetcher = s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation(async (url, options) => { if (JSON.parse(String(options?.body)).type === 'perpDexs' && ++n === 2) s.setClock(time + 5001); return fetcher(url, options); });
    await expect(s.reader.prove(user)).rejects.toThrow('account_mode_absence_unproven');
  });
  it('pays for its weight before its clock starts: a budget wait never ages the proof', async () => {
    // Before: five budget waits inside the 5 s window (here 4 s each) made it stale.
    let clock = time; const s = setup(); s.budget.mockImplementation(async () => { clock += 4_000; s.setClock(clock); });
    await expect(s.reader.prove(user)).resolves.toMatchObject({ complete: true }); expect(s.budget).toHaveBeenCalledTimes(1);
  });
  it('prepaid by its caller, it takes no weight; abandoned, it reserves no socket and subscribes nothing', async () => {
    const s = setup(); let spent = 0;
    const consume = (weight: number) => { spent += weight; };
    await s.reader.prove(user, { prepaid: true, consume }); expect(s.budget).not.toHaveBeenCalled();
    expect(spent).toBe(102);
    const abandon = new AbortController(); abandon.abort();
    await expect(s.reader.prove(user, { prepaid: true, signal: abandon.signal, consume })).rejects.toThrow();
    expect(spent).toBe(102);
    expect(s.readAccount).toHaveBeenCalledTimes(1);
  });
  it('waits for its turn on the shared all-venue source instead of being refused', async () => {
    const s = setup(); let busy = false, overlapped = false;
    s.readAccount.mockImplementationOnce(async (address: string, requested: readonly string[]) => {
      busy = true; await new Promise(resolve => setTimeout(resolve, 30)); busy = false;
      return { state: { network: 'testnet', accountAddress: address, observedAt: time, data: { user: address, clearinghouseStates: requested.map(dex => [dex, state()]) } },
        orders: { network: 'testnet', accountAddress: address, observedAt: time, completedAt: time, requestedDexes: [...requested], venues: requested.map(dex => ({ dex, user: address, observedAt: time, receivedAt: time, orders: [] })) } };
    });
    const spy = s.readAccount.getMockImplementation()!;
    s.readAccount.mockImplementation(async (...args: Parameters<typeof spy>) => { if (busy) overlapped = true; return spy(...args); });
    const [a, b] = await Promise.all([s.reader.prove(user), s.reader.prove(user)]);
    expect(a.complete && b.complete).toBe(true); expect(overlapped).toBe(false);
  });
  it('never substitutes a main-only or missing combined source for complete absence', async () => {
    const reader = new HyperliquidAccountModeAbsenceReader('testnet', async () => undefined, fetch, () => time, { read: vi.fn() });
    await expect(reader.prove(user)).rejects.toThrow('account_mode_absence_unproven');
  });
});
