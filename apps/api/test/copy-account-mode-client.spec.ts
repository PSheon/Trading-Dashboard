import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { PrivyAccountModeClient, accountModeTypedData, type AccountModeIntent, type AccountModeOwnedMaster } from '../src/copy/live/privy-account-mode-client.js';
import { offlineGlobalTransport } from './hyperliquid-global-test-utils.js';

// Real installed SDK, including HPKE JWT exchange/request authorization. Only HTTP is replaced.
const require = createRequire(import.meta.url);
const sdkCrypto = require(join(dirname(require.resolve('@privy-io/node')), 'lib/cryptography.js')) as {
  setupHPKESender(): Promise<{ encryptPayload(key: Uint8Array, payload: Uint8Array): Promise<{ ciphertext: Uint8Array; encapsulatedKey: Uint8Array }> }>;
};
const authKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
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
let walletChanges: Record<string, unknown>;
let rpcChanges: Record<string, unknown>;
let failurePath: string | undefined;
let onPath: ((path: string) => void) | undefined;
let signWithForeign: boolean;
const requests: { url: string; path: string; method: string; body: Record<string, unknown> | undefined; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
const modeValues: Record<string, unknown> = {};
let budget: ReturnType<typeof vi.fn<(weight: number) => Promise<void>>>;
let transport: typeof fetch;

beforeEach(() => {
  now = time; walletChanges = {}; rpcChanges = {}; failurePath = undefined; onPath = undefined; signWithForeign = false; requests.length = 0;
  Object.assign(modeValues, { userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false, spotClearinghouseState: { balances: [], portfolioMarginEnabled: false } });
  budget = vi.fn(async (_weight: number) => undefined);
  transport = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url: url.href, path: url.pathname, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers), redirect: init?.redirect });
    onPath?.(url.pathname);
    if (url.pathname === failurePath) return Response.json({ error: 'private token provider detail' }, { status: 500 });
    if (url.pathname === '/v1/wallets/master') return Response.json({ id: 'master', address: master.address, chain_type: 'ethereum', owner_id: 'owner-quorum', archived_at: null, ...walletChanges });
    if (url.pathname === '/v1/wallets/authenticate') {
      if (typeof body?.user_jwt !== 'string' || body.encryption_type !== 'HPKE' || typeof body.recipient_public_key !== 'string') throw new Error('incorrect SDK auth request');
      const recipient = await crypto.subtle.importKey('spki', Buffer.from(body.recipient_public_key, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', recipient));
      const sender = await sdkCrypto.setupHPKESender();
      const encrypted = await sender.encryptPayload(raw, new TextEncoder().encode(authKey));
      return Response.json({ expires_at: time + 600_000, encrypted_authorization_key: { encryption_type: 'HPKE', encapsulated_key: Buffer.from(encrypted.encapsulatedKey).toString('base64'), ciphertext: Buffer.from(encrypted.ciphertext).toString('base64') } });
    }
    if (url.pathname === '/v1/wallets/master/rpc') {
      if (body?.method !== 'eth_signTypedData_v4') throw new Error('unexpected SDK RPC');
      const signed = await (signWithForeign ? foreignSigner : masterSigner).signTypedData({ domain: expectedDomain, types: expectedTypes,
        primaryType: 'HyperliquidTransaction:UserSetAbstraction', message: { hyperliquidChain: 'Testnet', user: master.address as `0x${string}`, abstraction: 'disabled', nonce: BigInt(time) } });
      return Response.json({ method: 'eth_signTypedData_v4', data: { encoding: 'hex', signature: signed, ...rpcChanges } });
    }
    if (url.href === 'https://api.hyperliquid-testnet.xyz/info' && typeof body?.type === 'string' && Object.hasOwn(modeValues, body.type)) return Response.json(modeValues[body.type]);
    if (url.href === 'https://api.hyperliquid-testnet.xyz/exchange') return Response.json({ status: 'ok', response: { type: 'default' } });
    throw new Error(`unexpected transport path ${url.pathname}`);
  };
  vi.stubGlobal('fetch', transport);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const client = (credentials = true) => new PrivyAccountModeClient(credentials ? { appId: 'test-app', appSecret: 'test-secret' } : {}, budget, transport, () => now);

describe('dedicated testnet standard-mode principal provider', () => {
  it('requires the current caller proof before any production-configured signing request', async () => {
    const global = offlineGlobalTransport(transport, () => now).transport;
    const provider = new PrivyAccountModeClient({ appId: 'test-app', appSecret: 'test-secret' }, budget, transport, () => now, global);
    await expect(provider.signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests).toHaveLength(0);
  });
  it('signs with the production-configured transport only after its synchronous caller proof', async () => {
    const global = offlineGlobalTransport(transport, () => now).transport;
    const provider = new PrivyAccountModeClient({ appId: 'test-app', appSecret: 'test-secret' }, budget, transport, () => now, global);
    const proof = vi.fn(() => undefined);
    await expect(provider.signMaster(master, intent, 'jwt', proof)).resolves.toMatch(/^0x[0-9a-f]{130}$/i);
    expect(proof).toHaveBeenCalledTimes(1);
    expect(requests.map(r => r.path)).toEqual(['/v1/wallets/master', '/v1/wallets/authenticate', '/v1/wallets/master/rpc']);
  });
  it('builds immutable canonical principal typed data, not agent or multisig wire aliases', () => {
    const data = accountModeTypedData(intent);
    expect(data.domain).toEqual(expectedDomain); expect(data.types).toEqual(expectedTypes);
    expect(data.primaryType).toBe('HyperliquidTransaction:UserSetAbstraction'); expect(data.message).toEqual(expectedAction);
    expect(Object.isFrozen(data)).toBe(true); expect(Object.isFrozen(data.domain)).toBe(true); expect(Object.isFrozen(data.message)).toBe(true);
  });
  it('uses exact owned master SDK RPC with per-request JWT and consent expiry', async () => {
    await expect(client().signMaster(master, intent, 'jwt-one')).resolves.toMatch(/^0x[0-9a-f]{130}$/i);
    expect(requests.map(r => r.path)).toEqual(['/v1/wallets/master', '/v1/wallets/authenticate', '/v1/wallets/master/rpc']);
    expect(requests[1]!.body!.user_jwt).toBe('jwt-one');
    const rpc = requests[2]!;
    expect(requests.every(r => r.redirect === 'error')).toBe(true);
    expect(rpc.headers.get('privy-request-expiry')).toBe(String(time + 300_000));
    expect(rpc.headers.has('privy-authorization-signature')).toBe(true);
    expect(rpc.body).toEqual({ address: master.address, chain_type: 'ethereum', method: 'eth_signTypedData_v4', params: { typed_data: {
      domain: expectedDomain, primary_type: 'HyperliquidTransaction:UserSetAbstraction', message: expectedAction,
      types: { ...expectedTypes, EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] },
    } } });
    expect(budget).not.toHaveBeenCalled();
  });
  it('does not reuse exchanged authorization keys across owner requests even with the same JWT', async () => {
    const provider = client(); await provider.signMaster(master, intent, 'jwt-same'); await provider.signMaster(master, intent, 'jwt-same');
    expect(requests.filter(r => r.path === '/v1/wallets/authenticate')).toHaveLength(2);
  });
  it.each([{ id: 'other' }, { address: foreignSigner.address }, { owner_id: 'foreign' }, { chain_type: 'solana' }, { archived_at: time }, { archived_at: undefined }])('rejects mismatched or unproven Privy identity before authorization %j', async (changes) => {
    walletChanges = changes;
    await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.map(r => r.path)).toEqual(['/v1/wallets/master']);
  });
  it('does not authorize signing when wallet-read identity expires', async () => {
    onPath = path => { if (path === '/v1/wallets/master') now += 5001; };
    await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.map(r => r.path)).toEqual(['/v1/wallets/master']);
  });
  it('blocks actual SDK RPC after delayed JWT exchange consumes identity freshness', async () => {
    onPath = path => { if (path === '/v1/wallets/authenticate') now += 5001; };
    await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.map(r => r.path)).toEqual(['/v1/wallets/master', '/v1/wallets/authenticate']);
  });
  it('rechecks the caller all-venue proof at the actual SDK RPC after JWT exchange', async () => {
    let proofValid = true;
    onPath = path => { if (path === '/v1/wallets/authenticate') proofValid = false; };
    const check = vi.fn(() => { if (!proofValid) throw new Error('expired all-venue proof'); });
    await expect(client().signMaster(master, intent, 'jwt', check)).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.some(r => r.path.endsWith('/rpc'))).toBe(false);
    expect(check).toHaveBeenCalled();
  });
  it('refuses an asynchronous proof hook instead of signing before its check completes', async () => {
    await expect(client().signMaster(master, intent, 'jwt', async () => undefined)).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.some(r => r.path.endsWith('/rpc'))).toBe(false);
  });
  it('checks identity and consent again after a synchronous proof hook consumes their remaining time', async () => {
    await expect(client().signMaster(master, intent, 'jwt', () => { now += 5001; })).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.some(r => r.path.endsWith('/rpc'))).toBe(false);
  });
  it('bounds complete SDK wallet response bytes before JWT authorization', async () => {
    walletChanges = { providerDetails: 'x'.repeat(65 * 1024) };
    await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.map(r => r.path)).toEqual(['/v1/wallets/master']);
  });
  it('cancels a stalled SDK body and aborts the invocation when its total deadline ends', async () => {
    vi.useFakeTimers(); const cancel = vi.fn(); let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => { signal = init?.signal; return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel,
    })); };
    const result = new PrivyAccountModeClient({ appId: 'app', appSecret: 'secret' }, budget, fetcher, () => now).signMaster(master, intent, 'jwt').catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ message: 'account_mode_master_signature_unavailable' });
    expect(cancel).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(true);
  });
  it('blocks actual SDK RPC when consent expires during JWT exchange', async () => {
    onPath = path => { if (path === '/v1/wallets/authenticate') now = intent.consentExpiresAt; };
    await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.some(r => r.path.endsWith('/rpc'))).toBe(false);
  });
  it('does not return a master signature if consent expires during RPC response', async () => {
    onPath = path => { if (path.endsWith('/rpc')) now = intent.consentExpiresAt; };
    await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
    expect(requests.filter(r => r.path.endsWith('/rpc'))).toHaveLength(1);
  });
  it('captures immutable account and intent before the first provider await', async () => {
    const originalMaster = { ...master }; const originalIntent = { ...intent };
    onPath = path => { if (path === '/v1/wallets/master') { originalMaster.address = foreignSigner.address; originalMaster.ownerQuorumId = 'foreign'; originalIntent.accountAddress = foreignSigner.address; originalIntent.nonce++; originalIntent.consentExpiresAt++; } };
    await client().signMaster(originalMaster, originalIntent, 'jwt');
    expect((requests.find(r => r.path.endsWith('/rpc'))!.body!.params as { typed_data: { message: unknown } }).typed_data.message).toEqual(expectedAction);
  });
  it.each([{ encoding: 'base64' }, { signature: '0xbad' }])('rejects malformed SDK signature response %j', async changes => {
    rpcChanges = changes; await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
  });
  it('rejects a well-formed signature recovered from another account', async () => {
    signWithForeign = true; await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow('account_mode_master_signature_unavailable');
  });
  it.each(['/v1/wallets/master', '/v1/wallets/authenticate', '/v1/wallets/master/rpc'])('redacts SDK faults without retrying %s', async path => {
    failurePath = path; await expect(client().signMaster(master, intent, 'jwt')).rejects.toThrow(/^account_mode_master_signature_unavailable$/);
    expect(requests.filter(r => r.path === path)).toHaveLength(1);
  });
  it.each([
    { network: 'mainnet' }, { accountAddress: 'bad' }, { accountAddress: `0x${'00'.repeat(20)}` },
    { nonce: -1 }, { nonce: Number.MAX_SAFE_INTEGER + 1 }, { nonce: time + 1 },
    { consentExpiresAt: time }, { consentExpiresAt: time + 300_001 }, { strategyId: 0 }, { operationId: '' },
  ])('rejects invalid intent before signing or POST %j', async changes => {
    const invalid = { ...intent, ...changes } as AccountModeIntent;
    await expect(client().signMaster(master, invalid, 'jwt')).rejects.toThrow(); await expect(client().send(invalid, signature)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it('rejects missing credentials/JWT or an account binding change before provider calls', async () => {
    await expect(client(false).signMaster(master, intent, 'jwt')).rejects.toThrow();
    await expect(client().signMaster(master, intent, '')).rejects.toThrow();
    await expect(client().signMaster({ ...master, address: foreignSigner.address }, intent, 'jwt')).rejects.toThrow();
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
