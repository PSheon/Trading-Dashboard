import { createPrivateKey } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PrivyClient } from '@privy-io/node';
import { isHyperliquidNetwork, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { PrivyOrderSigningClient, PrivyOrderSignInput } from './privy-order-signer.js';
import { boundedLiveRead } from './live-market-resolver.js';
import { LiveBoundaryError } from './wallet-authorization.js';

const domain = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'00'.repeat(20)}` };
const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
  Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };
function fail(code: string): never { throw new LiveBoundaryError(code); }
function walletId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error();
}
function key(value: unknown): void {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64');
  const parsed = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  if (bytes.toString('base64') !== value || parsed.asymmetricKeyType !== 'ec' || parsed.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
      !Buffer.from(parsed.export({ format: 'der', type: 'pkcs8' })).equals(bytes)) throw new Error();
}
function checkGuard(guard: () => void): void {
  const result: unknown = guard();
  if (result !== undefined) {
    // A rejected async callback must not become an unhandled rejection after
    // admission has already refused it. It can never authorize transport.
    if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result)
      void Promise.resolve(result).catch(() => undefined);
    throw new Error();
  }
}
async function readSdkBody(response: Response, remaining: () => number, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error();
      const { done, value } = await boundedLiveRead(() => reader.read(), remaining());
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', abort);
    await boundedLiveRead(() => reader.cancel(), 100).catch(() => undefined);
    reader.releaseLock();
  }
}

/** Fixed-origin, request-scoped installed SDK adapter. Worker keys authorize
 * one exact Agent RPC on this client's network; principal JWTs, arbitrary signing and hidden SDK
 * retries are refused. No client/key-exchange cache survives an invocation. */
export class BoundaryPrivyOrderSigningClient implements PrivyOrderSigningClient {
  private readonly credentials: Readonly<{ appId: string; appSecret: string }> | null;
  constructor(readonly network: HyperliquidNetwork, config: { appId?: string; appSecret?: string }, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    if (!isHyperliquidNetwork(network)) fail('privy_order_signing_unavailable');
    this.credentials = config.appId && config.appSecret ? Object.freeze({ appId: config.appId, appSecret: config.appSecret }) : null;
  }
  async getWallet(id: string): ReturnType<PrivyOrderSigningClient['getWallet']> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref();
    try {
      walletId(id); if (!this.credentials) throw new Error();
      const started = this.now(), remaining = () => {
        const now = this.now();
        if (!Number.isSafeInteger(started) || started <= 0 || !Number.isSafeInteger(now) || now < started || now - started >= 10_000 || controller.signal.aborted) throw new Error();
        return Math.max(1, 10_000 - (now - started));
      };
      remaining();
      const client = new PrivyClient({ ...this.credentials, timeout: 10_000, maxRetries: 0, logLevel: 'off', fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== 'https://api.privy.io' || url.pathname !== `/v1/wallets/${id}` || url.search || url.hash ||
            (init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET') throw new Error();
        const responseWork = this.fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any([
          controller.signal, ...(init?.signal ? [init.signal] : []),
        ]) });
        void Promise.resolve(responseWork).catch(() => undefined);
        return (async () => {
          const response = await boundedLiveRead(() => responseWork, remaining());
          const value = await readSdkBody(response, remaining, controller.signal);
          return Response.json(value, { status: response.status, headers: response.headers });
        })();
      } });
      return await boundedLiveRead(() => client.wallets().get(id), 10_000);
    } catch { fail('privy_order_wallet_unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async signTypedData(id: string, rawInput: PrivyOrderSignInput, guard: () => void): Promise<{ encoding: string; signature: string }> {
    const controller = new AbortController(); let timer: NodeJS.Timeout | undefined;
    try {
      walletId(id); const input = structuredClone(rawInput), started = this.now();
      const remaining = () => {
        const now = this.now();
        if (!Number.isSafeInteger(started) || started <= 0 || !Number.isSafeInteger(now) || now <= 0 || now < started || now - started > 5000 ||
            !Number.isSafeInteger(input.request_expiry) || input.request_expiry! <= now || input.request_expiry! > started + 60_000) throw new Error();
        return Math.max(1, Math.min(10_000, input.request_expiry! - now));
      };
      remaining();
      const data = input.params.typed_data, auth = input.authorization_context;
      if (!this.credentials || typeof guard !== 'function' || !isDeepStrictEqual(data.domain, domain) || !isDeepStrictEqual(data.types, types) ||
          data.primary_type !== 'Agent' || data.message.source !== (this.network === 'testnet' ? 'b' : 'a') || !/^0x[0-9a-f]{64}$/.test(String(data.message.connectionId)) ||
          Object.keys(data.message).sort().join(',') !== 'connectionId,source' || typeof input.address !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(input.address) || /^0x0{40}$/i.test(input.address) ||
          !auth || Object.keys(auth).join(',') !== 'authorization_private_keys' || auth.authorization_private_keys?.length !== 1 ||
          Object.keys(input).sort().join(',') !== 'address,authorization_context,params,request_expiry' ||
          Object.keys(input.params).join(',') !== 'typed_data') throw new Error();
      key(auth.authorization_private_keys[0]);
      checkGuard(guard); remaining();
      let submitted = false;
      const requestExpiry = input.request_expiry!;
      const deadline = started + Math.min(10_000, requestExpiry - started);
      timer = setTimeout(() => controller.abort(), deadline - started); timer.unref();
      const deadlineRemaining = () => {
        const now = this.now();
        if (!Number.isSafeInteger(now) || now < started || now >= deadline || controller.signal.aborted) throw new Error();
        return Math.max(1, deadline - now);
      };
      const client = new PrivyClient({ ...this.credentials, timeout: deadlineRemaining(), maxRetries: 0, logLevel: 'off', fetch: (request, init) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        if (submitted || url.origin !== 'https://api.privy.io' || url.pathname !== `/v1/wallets/${id}/rpc` || url.search || url.hash ||
            (init?.method ?? (request instanceof Request ? request.method : 'GET')) !== 'POST' ||
            !isDeepStrictEqual(JSON.parse(String(init?.body)), { address: input.address, params: input.params, method: 'eth_signTypedData_v4', chain_type: 'ethereum' }) ||
            new Headers(init?.headers).get('privy-request-expiry') !== String(requestExpiry)) throw new Error();
        // The SDK awaited request authorization before reaching this callback.
        // These final synchronous checks precede the actual transport call.
        checkGuard(guard); remaining();
        submitted = true;
        const responseWork = this.fetcher(request, { ...init, redirect: 'error', signal: AbortSignal.any([
          controller.signal, ...(init?.signal ? [init.signal] : []),
        ]) });
        void Promise.resolve(responseWork).catch(() => undefined);
        return (async () => {
          const response = await boundedLiveRead(() => responseWork, deadlineRemaining());
          const value = await readSdkBody(response, deadlineRemaining, controller.signal);
          return Response.json(value, { status: response.status, headers: response.headers });
        })();
      } });
      const result = await boundedLiveRead(() => client.wallets().ethereum().signTypedData(id, input), deadlineRemaining());
      if (result.encoding !== 'hex' || !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(result.signature)) throw new Error();
      return { encoding: result.encoding, signature: result.signature };
    } catch { return fail('privy_order_signing_unavailable'); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
}
