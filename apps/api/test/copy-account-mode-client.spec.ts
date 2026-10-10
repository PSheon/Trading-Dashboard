import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { PrivyAccountModeClient, accountModeTypedData, type AccountModeIntent, type AccountModeOwnedMaster } from '../src/copy/live/privy-account-mode-client.js';

const masterSigner = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const foreignSigner = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const time = 1_800_000_000_000;
const master: AccountModeOwnedMaster = { walletId: 'master', address: masterSigner.address.toLowerCase(), ownerQuorumId: 'owner-quorum' };
const intent: AccountModeIntent = { operationId: 'mode-operation', accountId: 'account', strategyId: 1, network: 'testnet', accountAddress: master.address, nonce: time, consentExpiresAt: time + 300_000 };
const signature = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
const expectedDomain = { name: 'HyperliquidSignTransaction', version: '1', chainId: 421614, verifyingContract: '0x0000000000000000000000000000000000000000' } as const;
const expectedTypes = { 'HyperliquidTransaction:UserSetAbstraction': [
  { name: 'hyperliquidChain', type: 'string' }, { name: 'user', type: 'address' },
  { name: 'abstraction', type: 'string' }, { name: 'nonce', type: 'uint64' },
] } as const;
const expectedAction = { type: 'userSetAbstraction', signatureChainId: '0x66eee', hyperliquidChain: 'Testnet', user: master.address, abstraction: 'disabled', nonce: time } as const;
let now: number;
let failurePath: string | undefined;
let onPath: ((path: string) => void) | undefined;
const requests: { url: string; path: string; method: string; body: Record<string, unknown> | undefined; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
const modeValues: Record<string, unknown> = {};
let budget: ReturnType<typeof vi.fn<(weight: number) => Promise<void>>>;
let transport: typeof fetch;

beforeEach(() => {
  now = time; failurePath = undefined; onPath = undefined; requests.length = 0;
  Object.assign(modeValues, { userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false, spotClearinghouseState: { balances: [], portfolioMarginEnabled: false } });
  budget = vi.fn(async (_weight: number) => undefined);
  transport = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url: url.href, path: url.pathname, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers), redirect: init?.redirect });
    onPath?.(url.pathname);
    if (url.pathname === failurePath) return Response.json({ error: 'private token provider detail' }, { status: 500 });
    if (url.href === 'https://api.hyperliquid-testnet.xyz/info' && typeof body?.type === 'string' && Object.hasOwn(modeValues, body.type)) return Response.json(modeValues[body.type]);
    if (url.href === 'https://api.hyperliquid-testnet.xyz/exchange') return Response.json({ status: 'ok', response: { type: 'default' } });
    throw new Error(`unexpected transport path ${url.pathname}`);
  };
  vi.stubGlobal('fetch', transport);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const client = (credentials = true) => new PrivyAccountModeClient(credentials ? { appId: 'test-app', appSecret: 'test-secret' } : {}, budget, transport, () => now);

describe('dedicated testnet standard-mode principal provider', () => {
  it('builds immutable canonical principal typed data, not agent or multisig wire aliases', () => {
    const data = accountModeTypedData(intent);
    expect(data.domain).toEqual(expectedDomain); expect(data.types).toEqual(expectedTypes);
    expect(data.primaryType).toBe('HyperliquidTransaction:UserSetAbstraction'); expect(data.message).toEqual(expectedAction);
    expect(Object.isFrozen(data)).toBe(true); expect(Object.isFrozen(data.domain)).toBe(true); expect(Object.isFrozen(data.message)).toBe(true);
  });
  it('signs and sends a mainnet intent with the mainnet chain fields and origin', async () => {
    const mainnet = { ...intent, network: 'mainnet' } as const, data = accountModeTypedData(mainnet);
    expect(data.domain).toEqual({ ...expectedDomain, chainId: 42161 });
    expect(data.message).toEqual({ ...expectedAction, signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet' });
    const sent: string[] = [];
    const provider = new PrivyAccountModeClient({ appId: 'test-app', appSecret: 'test-secret' }, budget, async input => { sent.push(String(input)); return Response.json({ status: 'ok', response: { type: 'default' } }); }, () => now);
    await provider.send(mainnet, signature);
    expect(sent).toEqual(['https://api.hyperliquid.xyz/exchange']);
  });
  it.each([
    { network: 'devnet' }, { accountAddress: 'bad' }, { accountAddress: `0x${'00'.repeat(20)}` },
    { nonce: -1 }, { nonce: Number.MAX_SAFE_INTEGER + 1 }, { nonce: time + 1 },
    { consentExpiresAt: time }, { consentExpiresAt: time + 300_001 }, { strategyId: 0 }, { operationId: '' },
  ])('rejects invalid intent before signing or POST %j', async changes => {
    const invalid = { ...intent, ...changes } as AccountModeIntent;
    await expect(client().send(invalid, signature)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it('requires caller budget once and sends exact immutable action without JWT, expiry or legacy fallback', async () => {
    const provider = client(false); await provider.acquire(); await provider.send(intent, signature);
    expect(budget.mock.calls).toEqual([[1]]); expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.hyperliquid-testnet.xyz/exchange'); expect(requests[0]!.redirect).toBe('error');
    expect(requests[0]!.body).toEqual({ action: expectedAction, nonce: time, signature: { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 27 } });
  });
  it('refuses the actual exchange fetch when request preparation ages the captured account proof', async () => {
    const guard = vi.fn(() => { if (now - time > 5000) throw new Error('expired captured account proof'); });
    guard();
    const provider = new PrivyAccountModeClient({}, budget, transport, () => { now = time + 5001; return now; });
    // Refused before the POST reached the transport: typed, so the caller may put the operation back.
    await expect(provider.send(intent, signature, guard)).rejects.toThrow('account_mode_not_dispatched');
    expect(requests).toHaveLength(0); expect(guard).toHaveBeenCalledTimes(2); expect(budget).not.toHaveBeenCalled();
  });
  it('refuses an asynchronous exchange proof fence before transport', async () => {
    const provider = client(false);
    await expect(provider.send(intent, signature, async () => undefined)).rejects.toThrow('account_mode_not_dispatched');
    expect(requests).toHaveLength(0); expect(budget).not.toHaveBeenCalled();
  });
  it.each(['0xbad', `0x${'11'.repeat(64)}ff`])('rejects malformed signatures before sending %s', async sig => {
    await expect(client(false).send(intent, sig)).rejects.toThrow(); expect(requests).toHaveLength(0);
  });
  it('does not POST after consent expires during caller budget acquisition', async () => {
    budget.mockImplementation(async () => { now = intent.consentExpiresAt; });
    const provider = client(false); await provider.acquire(); await expect(provider.send(intent, signature)).rejects.toThrow(); expect(requests).toHaveLength(0);
  });
  it('redacts caller budget failure without attempting a POST', async () => {
    budget.mockRejectedValue(new Error('private budget store payload'));
    await expect(client(false).acquire()).rejects.toThrow(/^account_mode_budget_unavailable$/); expect(requests).toHaveLength(0);
  });
  it('keeps ambiguous transport failures redacted and sends once', async () => {
    const fetcher = vi.fn(async () => { throw new Error('JWT secret internal provider detail'); });
    const provider = new PrivyAccountModeClient({}, budget, fetcher, () => now);
    await expect(provider.send(intent, signature)).rejects.toThrow(/^account_mode_submission_unknown$/); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ status: 'err', response: 'explicit rejection' }, { status: 'ok', response: { type: 'default' } }])('returns exchange acknowledgment for repository classification, not mode confirmation %j', async value => {
    const provider = new PrivyAccountModeClient({}, budget, async () => Response.json(value), () => now);
    await expect(provider.send(intent, signature)).resolves.toEqual(value);
  });
  it.each([{ status: 'ok', response: { type: 'order' } }, { status: 'ok' }, { status: 'err', response: {} }])('rejects malformed acknowledgments as unknown %j', async value => {
    const fetcher = vi.fn(async () => Response.json(value)); const provider = new PrivyAccountModeClient({}, budget, fetcher, () => now);
    await expect(provider.send(intent, signature)).rejects.toThrow('account_mode_submission_unknown'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds exchange response bytes and treats HTTP failure as unknown', async () => {
    for (const response of [new Response('x'.repeat(65 * 1024)), Response.json({ status: 'err', response: 'private detail' }, { status: 500 })]) {
      const fetcher = vi.fn(async () => response); const provider = new PrivyAccountModeClient({}, budget, fetcher, () => now);
      await expect(provider.send(intent, signature)).rejects.toThrow('account_mode_submission_unknown'); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds submission including delayed fetch and stalled body by one total deadline', async () => {
    vi.useFakeTimers();
    const stalledResponse = new Response(new ReadableStream<Uint8Array>({ start() {} }));
    const fetcher = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 4000)); now += 4000; return stalledResponse; });
    const provider = new PrivyAccountModeClient({}, budget, fetcher, () => now);
    let result: Error | undefined;
    const pending = provider.send(intent, signature).catch(error => { result = error as Error; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(result).toMatchObject({ message: 'account_mode_submission_unknown' }); await pending; expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('observes immutable exact fresh standard evidence with every REST read budgeted once', async () => {
    const result = await client(false).observe(intent);
    expect(result).toMatchObject({ network: 'testnet', accountAddress: master.address, earliestObservedAt: time, completedAt: time,
      role: 'user', abstraction: 'disabled', dexAbstraction: false, portfolioMarginEnabled: false, status: 'confirmed', issue: null });
    expect(result.sourceDigest).toMatch(/^0x[0-9a-f]{64}$/); expect(Object.isFrozen(result)).toBe(true);
    // One reservation for the four reads (60 + 20 + 20 + 2), taken before the clock.
    expect(budget.mock.calls.map(c => c[0])).toEqual([102]);
    expect(requests).toHaveLength(4); expect(requests.every(r => r.url === 'https://api.hyperliquid-testnet.xyz/info' && r.body!.user === master.address && r.redirect === 'error')).toBe(true);
  });
  it('consumes prepaid weight at transport dispatch even when the observation fails', async () => {
    let spent = 0;
    failurePath = '/info';
    await expect(client(false).observe(intent, { prepaid: true, consume: weight => { spent += weight; } })).rejects.toThrow('account_mode_observation_unavailable');
    expect(spent).toBe(102);
  });
  it('retains the POST charge for an unknown submission and consumes none when the proof refuses dispatch', async () => {
    let spent = 0;
    const consume = (weight: number) => { spent += weight; };
    const provider = new PrivyAccountModeClient({}, budget, async () => { throw new Error('response lost'); }, () => now);
    await expect(provider.send(intent, signature, () => { throw new Error('proof expired'); }, consume)).rejects.toThrow('account_mode_not_dispatched');
    expect(spent).toBe(0);
    await expect(provider.send(intent, signature, () => undefined, consume)).rejects.toThrow('account_mode_submission_unknown');
    expect(spent).toBe(1);
  });
  it.each([
    { abstraction: 'default', dex: null, status: 'unproven', issue: 'account_mode_standard_unproven' },
    { abstraction: 'disabled', dex: null, status: 'unproven', issue: 'account_mode_legacy_state_unproven' },
    { abstraction: 'unifiedAccount', dex: false, status: 'unsupported', issue: 'account_mode_unsupported_abstraction' },
    { abstraction: 'portfolioMargin', dex: false, status: 'unsupported', issue: 'account_mode_unsupported_abstraction' },
    { abstraction: 'disabled', dex: true, status: 'unsupported', issue: 'account_mode_unsupported_abstraction' },
  ])('does not infer standard mode from unsupported or unknown combinations %j', async value => {
    modeValues.userAbstraction = value.abstraction; modeValues.userDexAbstraction = value.dex;
    expect(await client(false).observe(intent)).toMatchObject({ status: value.status, issue: value.issue });
  });
  it.each(['missing', 'agent', 'vault', 'subAccount'])('returns unsupported evidence for role %s', async role => {
    modeValues.userRole = { role }; expect(await client(false).observe(intent)).toMatchObject({ role, status: 'unsupported', issue: 'account_mode_unsupported_role' });
  });
  it('rejects portfolio margin even if mode strings look standard', async () => {
    modeValues.spotClearinghouseState = { balances: [], portfolioMarginEnabled: true };
    expect(await client(false).observe(intent)).toMatchObject({ status: 'unsupported', issue: 'account_mode_unsupported_abstraction' });
  });
  it('supports read-only recovery after consent expiry and never reuses cached positive mode evidence', async () => {
    now = intent.consentExpiresAt + 1; const provider = client(false);
    expect((await provider.observe(intent)).status).toBe('confirmed'); modeValues.userDexAbstraction = null;
    expect((await provider.observe(intent)).status).toBe('unproven'); expect(requests).toHaveLength(8);
  });
  it.each([
    ['userRole', { role: ['user'] }], ['userAbstraction', ['disabled']], ['userDexAbstraction', 'false'],
    ['spotClearinghouseState', { portfolioMarginEnabled: 'false', balances: [] }],
    ['spotClearinghouseState', {}], ['spotClearinghouseState', { balances: [{ coin: 'USDC', token: 0, total: '-1', hold: '0' }] }],
    ['spotClearinghouseState', { balances: [{ coin: 'USDC', token: 0, total: '1', hold: '2' }] }],
    ['spotClearinghouseState', { balances: [{ coin: 'USDC', token: 0, total: '1', hold: '0' }, { coin: 'USDC', token: 0, total: '1', hold: '0' }] }],
    ['spotClearinghouseState', { balances: [], user: foreignSigner.address }],
    ['spotClearinghouseState', { balances: [], network: 'mainnet' }],
  ])('rejects malformed or foreign observation %s %j', async (key, value) => {
    modeValues[key as string] = value; await expect(client(false).observe(intent)).rejects.toThrow(/^account_mode_observation_unavailable$/);
  });
  it('pays for its weight before its clock starts: a budget wait never ages the evidence', async () => {
    // Before: the 5 s clock started before four budget waits of 1.3 s each,
    // and a drained bucket turned every observation stale (the setup stall).
    budget.mockImplementation(async () => { now += 6_000; });
    expect(await client(false).observe(intent)).toMatchObject({ status: 'confirmed', earliestObservedAt: time + 6_000 });
  });
  it('rejects delayed or future clocks inside its window and ignores no old mode proof', async () => {
    onPath = () => { now += 1300; };
    await expect(client(false).observe(intent)).rejects.toThrow('account_mode_observation_unavailable');
    now = time; let reads = 0; onPath = () => { if (++reads === 2) now = time - 1; };
    await expect(client(false).observe(intent)).rejects.toThrow('account_mode_observation_unavailable');
  });
  it('a busy budget is a typed wait: nothing is read', async () => {
    const { HyperliquidBudgetWait } = await import('../src/hyperliquid/hyperliquid-budget-wait.js');
    budget.mockRejectedValue(new HyperliquidBudgetWait(12_000, 'local_budget'));
    await expect(client(false).observe(intent)).rejects.toMatchObject({ retryMs: 12_000, reason: 'local_budget' }); expect(requests).toHaveLength(0);
  });
  it('redacts failed read and performs no exchange or wallet call', async () => {
    failurePath = '/info'; await expect(client(false).observe(intent)).rejects.toThrow(/^account_mode_observation_unavailable$/);
    expect(requests.every(r => r.path === '/info')).toBe(true);
  });
  it('bounds observation body bytes without accepting truncated mode evidence', async () => {
    const oversized = vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    const provider = new PrivyAccountModeClient({}, budget, oversized, () => now);
    await expect(provider.observe(intent)).rejects.toThrow('account_mode_observation_unavailable');
  });
  it('bounds stalled budget by the total observation deadline', async () => {
    vi.useFakeTimers(); budget.mockImplementation(() => new Promise(() => {}));
    const pending = client(false).observe(intent).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(10_001); expect(await pending).toMatchObject({ message: 'account_mode_observation_unavailable' }); expect(requests).toHaveLength(0);
  });
});
