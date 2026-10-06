import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BoundaryPrivyOrderSigningClient } from '../src/copy/live/privy-order-client.js';
import type { PrivyOrderSignInput } from '../src/copy/live/privy-order-signer.js';

const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const time = 1_790_000_000_000;
const signature = `0x${'11'.repeat(64)}1b`;
function input(): PrivyOrderSignInput {
  return { address: `0x${'22'.repeat(20)}`, request_expiry: time + 60_000,
    authorization_context: { authorization_private_keys: [key] }, params: { typed_data: {
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'00'.repeat(20)}` },
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      primary_type: 'Agent', message: { source: 'b', connectionId: `0x${'ab'.repeat(32)}` },
    } } };
}
function setup() {
  let now = time;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.redirect).toBe('error');
    return Response.json({ method: 'eth_signTypedData_v4', data: { encoding: 'hex', signature } });
  });
  return { fetcher, advance: (ms: number) => { now += ms; },
    client: new BoundaryPrivyOrderSigningClient('testnet', { appId: 'fixture-app', appSecret: 'fixture-secret' }, fetcher, () => now) };
}
describe('real SDK order RPC boundary (HTTP replaced)', () => {
  it('sends one exact authorized testnet agent request with an SDK generated signature header', async () => {
    const s = setup(), guard = vi.fn(() => undefined);
    expect(await s.client.signTypedData('agent', input(), guard)).toEqual({ encoding: 'hex', signature });
    expect(s.fetcher).toHaveBeenCalledTimes(1); expect(guard).toHaveBeenCalledTimes(2);
    const [url, init] = s.fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.privy.io/v1/wallets/agent/rpc');
    const headers = new Headers(init?.headers);
    expect(headers.get('privy-authorization-signature')).toBeTruthy();
    expect(headers.get('privy-request-expiry')).toBe(String(time + 60_000));
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ address: input().address, method: 'eth_signTypedData_v4', chain_type: 'ethereum', params: input().params });
    expect(String(init?.body)).not.toContain(key);
  });
  it('rechecks the original permit after internal SDK authorization awaits', async () => {
    const s = setup(); let valid = true;
    const pending = s.client.signTypedData('agent', input(), () => { if (!valid) throw new Error('original_scope_lost'); });
    valid = false;
    await expect(pending).rejects.toThrow('privy_order_signing_unavailable');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('does not send a request whose evidence expires inside SDK preparation', async () => {
    const s = setup();
    const pending = s.client.signTypedData('agent', input(), () => undefined);
    s.advance(5001);
    await expect(pending).rejects.toThrow('privy_order_signing_unavailable');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('captures caller data before SDK awaits', async () => {
    const s = setup(), data = input();
    const pending = s.client.signTypedData('agent', data, () => undefined);
    data.params.typed_data.message.source = 'a'; data.request_expiry = time - 1;
    expect(await pending).toEqual({ encoding: 'hex', signature });
    expect(JSON.parse(String(s.fetcher.mock.calls[0]![1]?.body)).params.typed_data.message.source).toBe('b');
  });
  it('never retries an RPC after the first transport error and redacts provider details', async () => {
    const s = setup(); s.fetcher.mockResolvedValue(Response.json({ error: 'private token and authorization material' }, { status: 500 }));
    await expect(s.client.signTypedData('agent', input(), () => undefined)).rejects.toThrow('privy_order_signing_unavailable');
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects missing or asynchronous boundary guards before transport', async () => {
    const s = setup();
    await expect(s.client.signTypedData('agent', input(), undefined as never)).rejects.toThrow('privy_order_signing_unavailable');
    await expect(s.client.signTypedData('agent', input(), (async () => undefined) as never)).rejects.toThrow('privy_order_signing_unavailable');
    await expect(s.client.signTypedData('agent', input(), (async () => { throw new Error('private guard detail'); }) as never)).rejects.toThrow('privy_order_signing_unavailable');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('cancels a never-ending wallet response and aborts the original request', async () => {
    const s = setup(); let canceled = false;
    s.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"agent",'));
    }, cancel() { canceled = true; } })));
    await expect(s.client.getWallet('agent')).rejects.toThrow('privy_order_wallet_unavailable');
    expect(canceled).toBe(true); expect(s.fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  }, 15_000);
  it('rejects oversized wallet bodies and disables ambient SDK debug logging', async () => {
    const s = setup(), debug = vi.spyOn(console, 'debug').mockImplementation(() => {}), log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('PRIVY_API_LOG', 'debug');
    try {
      s.fetcher.mockResolvedValue(Response.json({ id: 'agent', metadata: 'x'.repeat(65536) }));
      await expect(s.client.getWallet('agent')).rejects.toThrow('privy_order_wallet_unavailable');
      expect(debug).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
      expect(s.fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); debug.mockRestore(); log.mockRestore(); }
  });
  it.each(['master transfer', 'mainnet source', 'wrong domain', 'expired', 'JWT authority', 'no worker', 'bad wallet'])('refuses %s before SDK RPC', async name => {
    const s = setup(), data = input(); let wallet = 'agent';
    if (name === 'master transfer') data.params.typed_data.primary_type = 'Transfer';
    if (name === 'mainnet source') data.params.typed_data.message.source = 'a';
    if (name === 'wrong domain') data.params.typed_data.domain.chainId = 421614;
    if (name === 'expired') data.request_expiry = time;
    if (name === 'JWT authority') data.authorization_context = { user_jwts: ['principal-jwt'], authorization_private_keys: [key] };
    if (name === 'no worker') data.authorization_context = {};
    if (name === 'bad wallet') wallet = '../master';
    await expect(s.client.signTypedData(wallet, data, () => undefined)).rejects.toThrow('privy_order_signing_unavailable');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('bounds the complete SDK response body, not just response headers', async () => {
    const s = setup();
    let canceled = false;
    s.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"method":"eth_signTypedData_v4","data":'));
      // No completion: adapter timeout must include SDK JSON response decoding.
    }, cancel() { canceled = true; } })));
    const pending = s.client.signTypedData('agent', input(), () => undefined);
    await expect(pending).rejects.toThrow('privy_order_signing_unavailable');
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(canceled).toBe(true); expect(s.fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  }, 15_000);
});
