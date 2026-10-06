import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { CancelByCloidRequest } from '@nktkas/hyperliquid/api/exchange';
import {
  canonicalize,
  createL1ActionHash,
  signL1Action,
} from '@nktkas/hyperliquid/signing';
import { BoundaryPrivyOrderSigningClient } from '../src/copy/live/privy-order-client.js';
import { PrivyTrackedCancellationSigner } from '../src/copy/live/privy-cancellation-signer.js';
import { HyperliquidTrackedCancellationTransport } from '../src/copy/live/hyperliquid-cancellation-transport.js';
import {
  trackedCancellationAction,
  trackedCancellationFingerprint,
  type CancellationPermit,
  type PreparedTrackedCancellation,
} from '../src/copy/live/live-tracked-cancellation.js';
import {
  buildOrderAction,
  executionKey,
  intentFingerprint,
  type LiveOrderIntent,
} from '../src/copy/live/live-order.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import {
  LiveBoundaryError,
  type WalletAuthorization,
} from '../src/copy/live/wallet-authorization.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { DrizzleDb } from '../src/db/drizzle.provider.js';

// Generated offline test keys and mocked HTTP only; no credentials, DB or funds.
const authorizationKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .privateKey.export({ format: 'der', type: 'pkcs8' })
  .toString('base64');
const agent = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const foreign = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const time = 1_790_000_000_000;
const domain = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: `0x${'00'.repeat(20)}` as `0x${string}`,
};
const types = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};
const ack = {
  status: 'ok',
  response: { type: 'cancel', data: { statuses: ['success'] } },
};
function operation(): PreparedTrackedCancellation {
  const grant: WalletAuthorization = {
    id: 'original',
    version: 1,
    userId: 1,
    strategyId: 2,
    walletId: 'old-agent',
    privyOwnerId: 'old-quorum',
    signerAddress: foreign.address.toLowerCase() as `0x${string}`,
    accountAddress: `0x${'22'.repeat(20)}`,
    network: 'testnet',
    scopes: ['copy:trade'],
    validFrom: time - 600_000,
    expiresAt: time - 1,
    revokedAt: time - 1,
    exchangeApprovedAt: time - 600_000,
  };
  const intent: LiveOrderIntent = {
    authorizationId: grant.id,
    walletId: grant.walletId,
    userId: 1,
    strategyId: 2,
    network: 'testnet',
    accountAddress: grant.accountAddress,
    reduceOnly: false,
    cloid: `0x${'ab'.repeat(16)}`,
    asset: 0,
    side: 'B',
    size: '0.01',
    limitPrice: '65000',
    sizeDecimals: 5,
    timeInForce: 'Ioc',
  };
  const action = buildOrderAction(intent);
  const record: LiveExecutionRecord = {
    key: executionKey(intent),
    fingerprint: intentFingerprint(intent, action),
    action,
    authorization: grant,
    nonce: time - 600_000,
    expiresAfter: time - 1,
    state: 'unknown',
    createdAt: time - 600_000,
    updatedAt: time - 1,
  };
  const saved: PreparedTrackedCancellation = {
    operationId: 'cancel-1',
    stopId: 'stop-1',
    claimToken: 'durable-claim-1',
    state: 'claimed',
    createdAt: time,
    target: { record, intent },
    authorization: {
      id: 'new-cancel-grant',
      version: 2,
      userId: 1,
      strategyId: 2,
      walletId: 'agent',
      privyOwnerId: 'current-quorum',
      signerAddress: agent.address.toLowerCase() as `0x${string}`,
      accountAddress: grant.accountAddress,
      network: 'testnet',
      scope: 'copy:cancel',
      validFrom: time - 1,
      expiresAt: time + 100_000,
      revokedAt: null,
    },
    ownerConsentDigest: 'cc'.repeat(32),
    nonce: time,
    expiresAfter: time + 60_000,
    action: {} as never,
    fingerprint: '',
  };
  saved.action = trackedCancellationAction(saved.target);
  saved.fingerprint = trackedCancellationFingerprint(saved);
  return saved;
}
function fixture() {
  let clock = time,
    valid = true,
    identity: object = {};
  const saved = operation();
  const wallet = {
    id: 'agent',
    chain_type: 'ethereum',
    address: saved.authorization.signerAddress,
    owner_id: 'current-quorum',
    archived_at: null,
  };
  const rpcFetch = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.redirect).toBe('error');
    if (String(url).endsWith('/rpc')) {
      const body = JSON.parse(String(init?.body));
      const signature = await agent.signTypedData({
        domain,
        types,
        primaryType: 'Agent',
        message: body.params.typed_data.message,
      });
      return Response.json({
        method: 'eth_signTypedData_v4',
        data: { encoding: 'hex', signature },
      });
    }
    return Response.json(wallet);
  });
  const client = new BoundaryPrivyOrderSigningClient(
    'testnet',
    { appId: 'fixture-app', appSecret: 'fixture-secret' },
    rpcFetch,
    () => clock,
  );
  const guard = vi.fn(() => {
    if (!valid) throw Error('scope lost');
  });
  const authorize = vi.fn(
    async (
      supplied: Readonly<PreparedTrackedCancellation>,
      phase: 'sign' | 'submit',
    ): Promise<CancellationPermit> => ({
      phase,
      operationId: saved.operationId,
      operationFingerprint: saved.fingerprint,
      claimToken: saved.claimToken,
      targetExecutionKey: saved.target.record.key,
      targetFingerprint: saved.target.record.fingerprint,
      authorization: structuredClone(saved.authorization),
      ownerConsentDigest: saved.ownerConsentDigest,
      ownerEnabled: true,
      checkedAt: clock,
      exchangeApproval: {
        network: 'testnet',
        accountAddress: saved.authorization.accountAddress,
        signerAddress: saved.authorization.signerAddress,
        checkedAt: clock,
        expiresAt: null,
      },
      assertFresh: guard,
    }),
  );
  const signingContext = vi.fn(async () => ({
    authorization_context: { authorization_private_keys: [authorizationKey] },
  }));
  const signer = new PrivyTrackedCancellationSigner(
    client,
    { authorize },
    signingContext,
    () => clock,
  );
  const exchangeFetch = vi.fn<typeof fetch>(async () => Response.json(ack));
  const quota = new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
  const global = new HyperliquidGlobalTransport(
    quota,
    { egressKey: 'fixture-egress', ownerId: 'fixture-worker' },
    exchangeFetch,
    () => clock,
  );
  vi.spyOn(global, 'isOriginal').mockReturnValue(true);
  vi.spyOn(global, 'contextIdentity').mockImplementation(() => identity);
  const acquire = vi.fn(async () => {
    let used = false;
    return {
      assertFresh: guard,
      dispatch: <T>(work: () => T): T => {
        if (used) throw Error('permit consumed');
        used = true;
        return work();
      },
    };
  });
  vi.spyOn(global, 'currentQuota').mockReturnValue({
    acquireRest: acquire,
    reserveSocket: vi.fn(),
  });
  const transport = new HyperliquidTrackedCancellationTransport(
    signer,
    global,
    exchangeFetch,
    () => clock,
  );
  return {
    saved,
    wallet,
    rpcFetch,
    client,
    guard,
    authorize,
    signingContext,
    exchangeFetch,
    acquire,
    global,
    signer,
    transport,
    advance: (ms: number) => {
      clock += ms;
    },
    lose: () => {
      valid = false;
    },
    changeIdentity: () => {
      identity = {};
    },
  };
}
const rpcCalls = (f: ReturnType<typeof fixture>) =>
  f.rpcFetch.mock.calls.filter(([url]) => String(url).endsWith('/rpc'));

describe('exact tracked testnet cancellation with installed SDK and HTTP mocks', () => {
  it('signs the SDK canonical single-target action and posts once after quota, returning ACK evidence only', async () => {
    const f = fixture();
    const result = await f.transport.attempt(f.saved, f.guard);
    expect(result).toMatchObject({
      state: 'accepted',
      signingRequested: true,
      exchangeRequestBegan: true,
      targetExecutionKey: f.saved.target.record.key,
    });
    const action = canonicalize(
      CancelByCloidRequest.entries.action,
      f.saved.action,
    );
    const signature = await signL1Action({
      wallet: agent,
      action: { ...action },
      nonce: time,
      expiresAfter: time + 60_000,
      isTestnet: true,
    });
    expect(result.response).toEqual(ack);
    expect(result.actionHash).toBe(
      createL1ActionHash({
        action: { ...action },
        nonce: time,
        expiresAfter: time + 60_000,
      }),
    );
    expect(rpcCalls(f)).toHaveLength(1);
    const rpcBody = JSON.parse(String(rpcCalls(f)[0]![1]?.body));
    expect(rpcBody.params.typed_data.message).toEqual({
      source: 'b',
      connectionId: result.actionHash,
    });
    expect(
      new Headers(rpcCalls(f)[0]![1]?.headers).get(
        'privy-authorization-signature',
      ),
    ).toBeTruthy();
    expect(f.exchangeFetch).toHaveBeenCalledOnce();
    const [url, init] = f.exchangeFetch.mock.calls[0]!;
    expect(url).toBe('https://api.hyperliquid-testnet.xyz/exchange');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({
      action,
      nonce: time,
      expiresAfter: time + 60_000,
      signature,
    });
    expect(f.acquire).toHaveBeenCalledWith(1, time + 5000);
    expect(f.saved.target.record.state).toBe('unknown'); // No reconciliation/release capability.
    expect(f.saved.target.record.authorization.walletId).toBe('old-agent');
    expect(f.authorize.mock.calls.at(-1)![1]).toBe('submit');
  });

  it.each([
    'extra-target',
    'asset',
    'cloid',
    'fast',
    'oid',
    'vault',
    'network',
    'foreign-account',
  ])('refuses %s before any provider call', async (mutation) => {
    const f = fixture(),
      saved = structuredClone(f.saved);
    if (mutation === 'extra-target')
      saved.action.cancels.push(saved.action.cancels[0]);
    if (mutation === 'asset') saved.action.cancels[0].asset = 1;
    if (mutation === 'cloid')
      saved.action.cancels[0].cloid = `0x${'de'.repeat(16)}`;
    if (mutation === 'fast') Object.assign(saved.action, { f: true });
    if (mutation === 'oid')
      Object.assign(saved.action, {
        type: 'cancel',
        cancels: [{ a: 0, o: 1 }],
      });
    if (mutation === 'vault')
      Object.assign(saved, { vaultAddress: `0x${'33'.repeat(20)}` });
    if (mutation === 'network')
      Object.assign(saved.authorization, { network: 'mainnet' });
    if (mutation === 'foreign-account')
      saved.authorization.accountAddress = `0x${'33'.repeat(20)}`;
    await expect(f.transport.attempt(saved, f.guard)).rejects.toThrow();
    expect(f.rpcFetch).not.toHaveBeenCalled();
    expect(f.exchangeFetch).not.toHaveBeenCalled();
  });

  it('rejects a self-consistent foreign original target against authoritative durable claim', async () => {
    const f = fixture(),
      supplied = structuredClone(f.saved);
    supplied.target.intent.cloid = `0x${'de'.repeat(16)}`;
    supplied.target.record.action = buildOrderAction(supplied.target.intent);
    supplied.target.record.key = executionKey(supplied.target.intent);
    supplied.target.record.fingerprint = intentFingerprint(
      supplied.target.intent,
      supplied.target.record.action,
    );
    supplied.action = trackedCancellationAction(supplied.target);
    supplied.fingerprint = trackedCancellationFingerprint(supplied);
    expect(await f.transport.attempt(supplied, f.guard)).toMatchObject({
      state: 'unknown',
      signingRequested: false,
      exchangeRequestBegan: false,
      issue: 'cancel_current_authority_invalid',
    });
    expect(f.rpcFetch).not.toHaveBeenCalled();
  });

  it.each(['past-nonce', 'future-nonce', 'expiry-at-nonce', 'grant-expiry'])(
    'rejects the %s bound before any provider call',
    async (mutation) => {
      const f = fixture();
      if (mutation === 'past-nonce') f.saved.nonce = time - 1;
      if (mutation === 'future-nonce') f.saved.nonce = time + 30_001;
      if (mutation === 'expiry-at-nonce') {
        f.saved.nonce = time + 5000;
        f.saved.expiresAfter = time + 5000;
      }
      if (mutation === 'grant-expiry')
        f.saved.authorization.expiresAt = time + 5000;
      f.saved.fingerprint = trackedCancellationFingerprint(f.saved);
      await expect(f.transport.attempt(f.saved, f.guard)).rejects.toThrow(
        'cancel_operation_invalid_or_expired',
      );
      expect(f.rpcFetch).not.toHaveBeenCalled();
      expect(f.exchangeFetch).not.toHaveBeenCalled();
    },
  );

  it('admits the shared allocator future nonce exactly at the 30-second bound', async () => {
    const f = fixture();
    f.saved.nonce = time + 30_000;
    f.saved.fingerprint = trackedCancellationFingerprint(f.saved);
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'accepted',
      nonce: time + 30_000,
    });
  });

  it('requires explicit unarchived Privy wallet identity', async () => {
    const f = fixture();
    Object.assign(f.wallet, { archived_at: undefined });
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      issue: 'cancel_privy_wallet_identity_mismatch',
      exchangeRequestBegan: false,
    });
    expect(rpcCalls(f)).toHaveLength(0);
  });

  it('cancels a non-success exchange HTTP body without retry or releasing liability', async () => {
    const f = fixture();
    let canceled = false;
    f.exchangeFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
        { status: 503 },
      ),
    );
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      issue: 'cancel_exchange_http_ambiguous',
      exchangeRequestBegan: true,
    });
    expect(canceled).toBe(true);
    expect(f.exchangeFetch).toHaveBeenCalledOnce();
  });

  it('captures caller-owned payloads before provider awaits', async () => {
    const f = fixture(),
      supplied = structuredClone(f.saved);
    const pending = f.transport.attempt(supplied, f.guard);
    supplied.action.cancels[0].cloid = `0x${'de'.repeat(16)}`;
    supplied.nonce += 1;
    supplied.authorization.walletId = 'foreign';
    supplied.target.intent.cloid = `0x${'de'.repeat(16)}`;
    expect(await pending).toMatchObject({ state: 'accepted' });
    expect(
      JSON.parse(String(f.exchangeFetch.mock.calls[0]![1]?.body)).action,
    ).toEqual(f.saved.action);
  });

  it('rejects foreign Privy identity before signing', async () => {
    const f = fixture();
    f.wallet.owner_id = 'foreign-quorum';
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      issue: 'cancel_privy_wallet_identity_mismatch',
      exchangeRequestBegan: false,
    });
    expect(rpcCalls(f)).toHaveLength(0);
  });

  it.each(['revoke', 'stale', 'expire'])(
    'rechecks %s after the real Privy SDK hidden authorization await',
    async (kind) => {
      const f = fixture();
      const original = f.client.signTypedData.bind(f.client);
      vi.spyOn(f.client, 'signTypedData').mockImplementation(
        (id, input, guard) => {
          const work = original(id, input, guard);
          if (kind === 'revoke') f.lose();
          else f.advance(kind === 'stale' ? 5001 : 60_000);
          return work;
        },
      );
      expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
        state: 'unknown',
        exchangeRequestBegan: false,
      });
      expect(rpcCalls(f)).toHaveLength(0);
      expect(f.exchangeFetch).not.toHaveBeenCalled();
    },
  );

  it('refuses the actual Privy RPC exactly at expiresAfter', async () => {
    const f = fixture();
    f.saved.expiresAfter = time + 5000;
    f.saved.fingerprint = trackedCancellationFingerprint(f.saved);
    const original = f.client.signTypedData.bind(f.client);
    vi.spyOn(f.client, 'signTypedData').mockImplementation(
      (id, input, guard) => {
        const work = original(id, input, guard);
        f.advance(5000);
        return work;
      },
    );
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      exchangeRequestBegan: false,
    });
    expect(rpcCalls(f)).toHaveLength(0);
  });

  it('rejects an identity observation made stale by later current-authority reads', async () => {
    const f = fixture();
    f.signingContext.mockImplementationOnce(async () => {
      f.advance(5001);
      return {
        authorization_context: {
          authorization_private_keys: [authorizationKey],
        },
      };
    });
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      issue: 'cancel_privy_wallet_identity_stale',
    });
    expect(rpcCalls(f)).toHaveLength(0);
  });

  it.each(['foreign-signer', 'foreign-hash', 'mainnet-source'])(
    'verifies returned signatures against %s',
    async (mutation) => {
      const f = fixture(),
        raw = f.rpcFetch.getMockImplementation()!;
      f.rpcFetch.mockImplementation(async (url, init) => {
        if (!String(url).endsWith('/rpc')) return raw(url, init);
        const body = JSON.parse(String(init?.body));
        const message = { ...body.params.typed_data.message };
        if (mutation === 'foreign-hash')
          message.connectionId = `0x${'ff'.repeat(32)}`;
        if (mutation === 'mainnet-source') message.source = 'a';
        const signature = await (
          mutation === 'foreign-signer' ? foreign : agent
        ).signTypedData({ domain, types, primaryType: 'Agent', message });
        return Response.json({
          method: 'eth_signTypedData_v4',
          data: { encoding: 'hex', signature },
        });
      });
      expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
        state: 'unknown',
        issue: 'cancel_privy_signature_scope_mismatch',
        exchangeRequestBegan: false,
      });
      expect(f.exchangeFetch).not.toHaveBeenCalled();
    },
  );

  it('reads current permission after quota waiting and rechecks the original identity at dispatch', async () => {
    const f = fixture();
    f.acquire.mockImplementationOnce(async () => {
      f.changeIdentity();
      return { assertFresh: f.guard, dispatch: (work) => work() };
    });
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      issue: 'cancel_original_context_lost',
      exchangeRequestBegan: false,
    });
    expect(f.authorize.mock.calls.at(-1)![1]).toBe('submit');
    expect(f.exchangeFetch).not.toHaveBeenCalled();
  });

  it('checks stale authority after a newer quota permit at actual dispatch', async () => {
    const f = fixture();
    f.acquire.mockImplementationOnce(async () => ({
      assertFresh: f.guard,
      dispatch: (work) => {
        f.advance(5001);
        return work();
      },
    }));
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      exchangeRequestBegan: false,
      issue: 'cancel_current_authority_invalid',
    });
    expect(f.exchangeFetch).not.toHaveBeenCalled();
  });

  it('refuses dispatch exactly at expiresAfter even if newer quota and authority remain fresh', async () => {
    const f = fixture();
    f.acquire.mockImplementationOnce(async () => ({
      assertFresh: f.guard,
      dispatch: (work) => {
        f.advance(60_000);
        return work();
      },
    }));
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      exchangeRequestBegan: false,
      issue: 'cancel_operation_invalid_or_expired',
    });
    expect(f.exchangeFetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'err', response: 'nonce already used' },
    {
      status: 'ok',
      response: {
        type: 'cancel',
        data: {
          statuses: [
            { error: 'Order was never placed, already canceled, or filled.' },
          ],
        },
      },
    },
    { status: 'unknownOid' },
  ])(
    'retains uncertainty for non-success responses without releasing the target',
    async (body) => {
      const f = fixture();
      f.exchangeFetch.mockResolvedValue(Response.json(body));
      expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
        state: 'unknown',
        exchangeRequestBegan: true,
      });
      expect(f.saved.target.record.state).toBe('unknown');
      expect(f.exchangeFetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      status: 'err',
      response: 'private-provider-text',
      signature: 'echoed-signature',
      authorization_token: 'echoed-authorization',
    },
    {
      status: 'future-status',
      response: {
        data: { error: 'private-provider-text', signature: 'echoed-signature' },
      },
    },
  ])(
    'omits all unrecognized provider response content from unknown evidence',
    async (body) => {
      const f = fixture();
      f.exchangeFetch.mockResolvedValue(Response.json(body));
      const result = await f.transport.attempt(f.saved, f.guard);
      expect(result).toMatchObject({
        state: 'unknown',
        issue: 'cancel_exchange_response_ambiguous',
        exchangeRequestBegan: true,
      });
      expect(result).not.toHaveProperty('response');
      expect(JSON.stringify(result)).not.toContain('private-provider-text');
      expect(JSON.stringify(result)).not.toContain('echoed-signature');
      expect(JSON.stringify(result)).not.toContain('echoed-authorization');
    },
  );

  it('allowlists evidence error codes rather than persisting arbitrary boundary error strings', async () => {
    const f = fixture();
    f.acquire.mockRejectedValue(new LiveBoundaryError('private-provider-text'));
    const result = await f.transport.attempt(f.saved, f.guard);
    expect(result).toMatchObject({
      state: 'unknown',
      issue: 'cancel_attempt_ambiguous',
      exchangeRequestBegan: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-provider-text');
  });

  it.each(['abort', 'deadline'])(
    'refuses buffered complete ACK with stalled EOF followed by %s',
    async (kind) => {
      const f = fixture(),
        controller = new AbortController();
      let canceled = false,
        scheduled = false;
      // Keep the transport signal under test control, without slowing the test by
      // its real ten-second timeout. Privy still uses its actual SDK HTTP mock.
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(controller.signal);
      f.exchangeFetch.mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new TextEncoder().encode(JSON.stringify(ack)));
              },
              pull(stream) {
                if (scheduled) return;
                scheduled = true;
                // This macrotask runs while the second read waits for EOF, after the
                // complete valid JSON has been buffered by the first awaited read.
                setTimeout(() => {
                  if (kind === 'abort') controller.abort();
                  else {
                    f.advance(10_000);
                    stream.close();
                  }
                }, 0);
              },
              cancel() {
                canceled = true;
              },
            }),
          ),
      );
      try {
        const result = await f.transport.attempt(f.saved, f.guard);
        expect(result).toMatchObject({
          state: 'unknown',
          issue: 'cancel_response_deadline',
          exchangeRequestBegan: true,
        });
        expect(result).not.toHaveProperty('response');
        if (kind === 'abort') expect(canceled).toBe(true);
        expect(f.exchangeFetch).toHaveBeenCalledOnce();
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it('does not retry a dropped POST or mint a successor cancellation', async () => {
    const f = fixture();
    f.exchangeFetch.mockRejectedValue(
      Error('connection reset with private details'),
    );
    expect(await f.transport.attempt(f.saved, f.guard)).toMatchObject({
      state: 'unknown',
      exchangeRequestBegan: true,
      issue: 'cancel_attempt_ambiguous',
    });
    await expect(f.transport.attempt(f.saved, f.guard)).rejects.toThrow(
      'cancel_attempt_already_invoked',
    );
    expect(f.exchangeFetch).toHaveBeenCalledOnce();
    expect(rpcCalls(f)).toHaveLength(1);
  });

  it('bounds responses and never retries a Privy transport error', async () => {
    const oversized = fixture();
    oversized.exchangeFetch.mockResolvedValue(
      new Response('x'.repeat(64 * 1024 + 1)),
    );
    expect(
      await oversized.transport.attempt(oversized.saved, oversized.guard),
    ).toMatchObject({ state: 'unknown', exchangeRequestBegan: true });
    const failed = fixture();
    failed.rpcFetch.mockImplementation(async (url) =>
      String(url).endsWith('/rpc')
        ? Response.json({ error: 'private material' }, { status: 500 })
        : Response.json(failed.wallet),
    );
    expect(
      await failed.transport.attempt(failed.saved, failed.guard),
    ).toMatchObject({
      state: 'unknown',
      exchangeRequestBegan: false,
      issue: 'privy_order_signing_unavailable',
    });
    expect(rpcCalls(failed)).toHaveLength(1);
    expect(failed.exchangeFetch).not.toHaveBeenCalled();
  });

  it('requires synchronous caller guards and original global context', async () => {
    const f = fixture();
    await expect(
      f.transport.attempt(f.saved, (async () => undefined) as never),
    ).rejects.toThrow('cancel_guard_must_be_synchronous');
    vi.mocked(f.global.isOriginal).mockReturnValue(false);
    await expect(f.transport.attempt(f.saved, f.guard)).rejects.toThrow(
      'cancel_original_context_missing',
    );
    expect(f.rpcFetch).not.toHaveBeenCalled();
  });
});
