import { PrivyClient } from '@privy-io/node';
import { verifyTypedData, type TypedDataDefinition } from 'viem';
import { boundedLiveRead } from './live-market-resolver.js';
import { LiveBoundaryError } from './wallet-authorization.js';

const domainFields = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
export interface MasterAccount { readonly walletId: string; readonly address: string; readonly ownerQuorumId: string }
/** A Hyperliquid user-signed action's typed data (usdSend, approveBuilderFee). */
export interface MasterTypedData {
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}
export const MASTER_ACTION_SIGNER = Symbol('MASTER_ACTION_SIGNER');

/** The only actions a copy account signs here, with their exact fields: a
 * USDC transfer (the return to the owner's main wallet) and the builder fee
 * approval. Anything else (ApproveAgent, Withdraw3, …) is refused before
 * Privy is asked. */
const SIGNABLE: Readonly<Record<string, readonly { name: string; type: string }[]>> = {
  'HyperliquidTransaction:UsdSend': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
  'HyperliquidTransaction:ApproveBuilderFee': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'maxFeeRate', type: 'string' }, { name: 'builder', type: 'address' }, { name: 'nonce', type: 'uint64' }],
};
export function masterActionSignable(data: Pick<MasterTypedData, 'primaryType' | 'types' | 'message'>): boolean {
  const fields = Object.hasOwn(SIGNABLE, data.primaryType) ? SIGNABLE[data.primaryType]! : null;
  const declared = data.types[data.primaryType];
  return Boolean(fields && declared && Object.keys(data.types).length === 1 && JSON.stringify(declared) === JSON.stringify(fields) &&
    Object.keys(data.message).sort().join(',') === fields.map(f => f.name).sort().join(','));
}
export interface MasterActionSigner {
  readonly available: boolean;
  sign(account: MasterAccount, data: MasterTypedData, userJwt: string, deadline: number, assertFresh: () => void): Promise<string>;
}

/**
 * Signs one exact Hyperliquid user-signed action with the copy's own account
 * (a Privy wallet the owner alone owns), authorised by the owner's fresh
 * session token for this request only. The same fixed-origin boundary as
 * Codex's agent approval: the wallet's identity is read first, only that
 * wallet's GET, authenticate and one RPC are allowed, the domain must be
 * Hyperliquid's user-signed one, and the returned signature must recover to
 * the account. Neither the token nor any reusable authority is kept.
 */
export class PrivyMasterActionSigner implements MasterActionSigner {
  private readonly credentials: Readonly<{ appId: string; appSecret: string }> | null;
  constructor(config: { appId?: string; appSecret?: string }, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    this.credentials = config.appId && config.appSecret ? Object.freeze({ appId: config.appId, appSecret: config.appSecret }) : null;
  }
  get available() { return this.credentials !== null; }
  async sign(rawAccount: MasterAccount, rawData: MasterTypedData, userJwt: string, rawDeadline: number, assertFresh: () => void): Promise<string> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const account = Object.freeze(structuredClone(rawAccount)), data = structuredClone(rawData), started = this.now(), deadline = Math.min(started + 5000, rawDeadline);
      if (!this.credentials || typeof userJwt !== 'string' || !userJwt.trim() || userJwt.length > 32768 || typeof assertFresh !== 'function' ||
        data.domain.name !== 'HyperliquidSignTransaction' || data.domain.version !== '1' || data.domain.verifyingContract !== `0x${'00'.repeat(20)}` ||
        !masterActionSignable(data)) throw new Error();
      const remaining = () => { const now = this.now(); if (!Number.isSafeInteger(now) || now < started || now >= deadline || controller.signal.aborted) throw new Error(); return deadline - now; };
      const fresh = () => { const result: unknown = assertFresh(); if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error(); } };
      fresh(); remaining(); timer = setTimeout(() => controller.abort(), remaining()); timer.unref();
      let verified = false, submitted = false;
      const walletPath = `/v1/wallets/${encodeURIComponent(account.walletId)}`, rpcPath = `${walletPath}/rpc`;
      const sdkFetch: typeof fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (url.origin !== 'https://api.privy.io' || url.search || url.hash || !(url.pathname === walletPath && method === 'GET' || url.pathname === '/v1/wallets/authenticate' && method === 'POST' || url.pathname === rpcPath && method === 'POST')) throw new Error();
        remaining();
        if (url.pathname === rpcPath) { if (!verified || submitted) throw new Error(); fresh(); remaining(); submitted = true; }
        const request = { ...init, redirect: 'error' as const, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) };
        return (async () => {
          const response = await boundedLiveRead(this.fetcher(input, request), remaining());
          if (!response.body) throw new Error();
          const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
          try {
            if (Number(response.headers.get('content-length')) > 65536) throw new Error();
            for (;;) { const { done, value } = await boundedLiveRead(reader.read(), remaining()); if (done) break; bytes += value.byteLength; if (bytes > 65536) throw new Error(); chunks.push(value); }
            return Response.json(JSON.parse(Buffer.concat(chunks, bytes).toString()), { status: response.status, headers: response.headers });
          } finally { await boundedLiveRead(reader.cancel(), 100).catch(() => {}); reader.releaseLock(); }
        })();
      };
      const client = new PrivyClient({ ...this.credentials, timeout: remaining(), maxRetries: 0, fetch: sdkFetch, logLevel: 'off' });
      const wallet = await boundedLiveRead(client.wallets().get(account.walletId), remaining());
      if (wallet.id !== account.walletId || wallet.chain_type !== 'ethereum' || typeof wallet.address !== 'string' || wallet.address.toLowerCase() !== account.address.toLowerCase() ||
        wallet.owner_id !== account.ownerQuorumId || wallet.archived_at !== null) throw new Error();
      verified = true;
      const result = await boundedLiveRead(client.wallets().ethereum().signTypedData(account.walletId, { address: account.address, authorization_context: { user_jwts: [userJwt] },
        request_expiry: deadline, params: { typed_data: { domain: data.domain, types: { ...data.types, EIP712Domain: domainFields }, primary_type: data.primaryType, message: data.message } } } as never), remaining());
      remaining();
      if (result.encoding !== 'hex' || !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(result.signature) ||
        !await verifyTypedData({ address: account.address as `0x${string}`, ...(data as unknown as TypedDataDefinition), signature: result.signature as `0x${string}` })) throw new Error();
      remaining(); return result.signature;
    } catch { throw new LiveBoundaryError('master_action_signing_unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
