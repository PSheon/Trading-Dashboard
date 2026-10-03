import { exchangeApprovalFixture, executionGateFixture } from "./copy-live-test-utils.js";
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from 'viem/accounts';
import { splitSignature } from '@trading-dashboard/shared/contracts';
import { createL1ActionHash, signL1Action } from "@nktkas/hyperliquid/signing";
import { HyperliquidLiveTransport } from "../src/copy/live/hyperliquid-live-transport.js";
import { PrivyOrderSigner, type PrivyOrderSigningClient } from "../src/copy/live/privy-order-signer.js";
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from "../src/copy/live/live-order.js";
import { WalletAuthorizationService, type WalletAuthorization } from "../src/copy/live/wallet-authorization.js";
import { HyperliquidAgentApprovalVerifier } from "../src/copy/live/hyperliquid-agent-approval.js";
import type { ExchangeApprovalVerifier } from "../src/copy/live/wallet-authorization.js";
import { LiveOrderExecutor, type LiveExecutionJournal } from "../src/copy/live/live-execution.js";
import type { LiveExecutionRecord } from "../src/copy/live/live-execution.js";
import type { LiveExecutionGate } from '../src/copy/live/live-execution-gate.js';

const gate = executionGateFixture();
const lease = { assertHeld: async () => {} };
const now = 1_790_000_000_000;
const fixtureSigner = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const foreignSigner = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const signatureDomain = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'00'.repeat(20)}` as `0x${string}` };
const signatureTypes = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };
const market = { network: 'testnet' as const, coin: 'BTC', dex: '', asset: 0, universeIndex: 0,
  perpDexIndex: 0, sizeDecimals: 5, maxLeverage: 40, observedAt: now };
const grant: WalletAuthorization = { id: "grant", version: 1, userId: 1, strategyId: 2, walletId: "wallet", privyOwnerId: "quorum",
  signerAddress: fixtureSigner.address.toLowerCase() as `0x${string}`, accountAddress: `0x${"22".repeat(20)}`, network: "testnet", scopes: ["copy:trade", "copy:reduce"],
  validFrom: now - 1, expiresAt: now + 100_000, revokedAt: null, exchangeApprovedAt: now - 1 };
const intent: LiveOrderIntent = { authorizationId: "grant", userId: 1, strategyId: 2, walletId: "wallet", network: "testnet",
  accountAddress: grant.accountAddress, reduceOnly: false, cloid: `0x${"ab".repeat(16)}`, asset: 0, side: "B", size: "0.01", limitPrice: "65000", sizeDecimals: 5, timeInForce: "Ioc", market };
const action = buildOrderAction(intent);
const record: LiveExecutionRecord = { key: executionKey(intent), fingerprint: intentFingerprint(intent, action), action, authorization: grant,
  nonce: now, expiresAfter: now + 60_000, state: "prepared", createdAt: now, updatedAt: now };
function setup(finalGate: LiveExecutionGate = gate, approval: ExchangeApprovalVerifier = exchangeApprovalFixture(() => now), clock = () => now, localGrant = grant) {
  const wallet = { id: grant.walletId, chain_type: "ethereum", address: grant.signerAddress, owner_id: grant.privyOwnerId, archived_at: null };
  const get = vi.fn(async () => wallet);
  const signTypedData = vi.fn(async (_walletId: string, input: Record<string, unknown>) => {
    const data = (input.params as { typed_data: { message: { source: string; connectionId: `0x${string}` } } }).typed_data;
    return { encoding: 'hex', signature: await fixtureSigner.signTypedData({ domain: signatureDomain, types: signatureTypes, primaryType: 'Agent', message: data.message }) };
  });
  // Ephemeral offline EVM fixture only; no credentials or HTTP requests.
  const client: PrivyOrderSigningClient = { getWallet: get, signTypedData: async (id, input, assertFresh) => {
    assertFresh(); return signTypedData(id, input as unknown as Record<string, unknown>);
  } };
  const auth = new WalletAuthorizationService({ find: async () => localGrant }, approval, clock);
  const signer = new PrivyOrderSigner(client, auth, async () => ({}), finalGate, clock);
  const fetcher = vi.fn<typeof fetch>();
  const resolver = { network: 'testnet' as const, resolve: async () => ({ ...market, observedAt: clock() }),
    resolveAsset: async () => ({ ...market, observedAt: clock() }) };
  const acquire = vi.fn(async (_weight: number) => {});
  return { wallet, get, signTypedData, signer, fetcher, auth, acquire, resolver,
    transport: new HyperliquidLiveTransport("testnet", signer, finalGate, fetcher, 10_000, clock, { marketResolver: resolver, acquire }) };
}
function reply(body: unknown) { return new Response(JSON.stringify(body), { status: 200 }); }
function statusReply(status = "open", overrides = {}) {
  return { status: "order", order: { status, statusTimestamp: now, order: { coin: 'BTC', reduceOnly: false, tif: 'Ioc', cloid: intent.cloid, side: "B", origSz: "0.01", sz: "0.01", limitPx: "65000", oid: 10, ...overrides } } };
}

function realApprovalFixture(clock = () => now, validUntil: number | null = now + 100_000) {
  let approved = true;
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    expect(JSON.parse(String(options?.body))).toEqual({ type: "extraAgents", user: grant.accountAddress });
    return reply(approved ? [{ address: grant.signerAddress, name: "copy-2", validUntil }] : []);
  });
  return { verifier: new HyperliquidAgentApprovalVerifier("testnet", async () => {}, fetcher, clock), fetcher,
    revoke: () => { approved = false; } };
}

describe("real approval checks at signing and submission boundaries (offline)", () => {
  it.each(['foreign signer', 'different connection hash'])('rejects a validly encoded provider signature for %s', async scenario => {
    const s = setup();
    s.signTypedData.mockImplementation(async (_id, input) => {
      const message = (input.params as { typed_data: { message: { source: string; connectionId: `0x${string}` } } }).typed_data.message;
      return { encoding: 'hex', signature: await (scenario === 'foreign signer' ? foreignSigner : fixtureSigner).signTypedData({
        domain: signatureDomain, types: signatureTypes, primaryType: 'Agent',
        message: scenario === 'foreign signer' ? message : { ...message, connectionId: `0x${'ff'.repeat(32)}` },
      }) };
    });
    await expect(s.transport.sign(record, intent, lease)).rejects.toMatchObject({ cause: { code: 'privy_signature_scope_mismatch' } });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('captures sign record and intent before the first market provider wait', async () => {
    const s = setup(), saved = structuredClone(record), approved = structuredClone(intent);
    const pending = s.transport.sign(saved, approved, lease);
    saved.nonce++; saved.expiresAfter = now - 1; saved.authorization.accountAddress = `0x${'33'.repeat(20)}`;
    approved.size = '1'; approved.accountAddress = saved.authorization.accountAddress;
    const signed = await pending;
    expect(signed).toMatchObject({ nonce: record.nonce, expiresAfter: record.expiresAfter, action });
  });
  it('captures submit record and intent before provider budget waits', async () => {
    const s = setup(), signed = await s.transport.sign(record, intent, lease);
    const saved = structuredClone({ ...record, state: 'submitting' as const }), approved = structuredClone(intent);
    s.fetcher.mockResolvedValue(reply({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 10 } }] } } }));
    const pending = s.transport.submit(signed, saved, approved, lease);
    saved.nonce++; saved.authorization.accountAddress = `0x${'33'.repeat(20)}`; approved.size = '1';
    expect(await pending).toMatchObject({ state: 'resting', exchangeOrderId: '10' });
    expect(JSON.parse(String(s.fetcher.mock.calls[0]![1]?.body))).toEqual(signed);
  });
  it.each(['sign', 'submit'] as const)('rechecks authorization after the final synchronous %s risk computation consumes freshness', async phase => {
    let clock = now, consume = false;
    const riskGate: LiveExecutionGate = { assertReady: async ({ phase, record }) => {
      let checks = 0;
      return { phase, key: record.key, fingerprint: record.fingerprint, assertFresh: () => {
        if (++checks === 2 && consume) clock += 5001;
      } };
    } };
    const s = setup(riskGate, exchangeApprovalFixture(() => clock), () => clock);
    const signed = phase === 'submit' ? await s.transport.sign(record, intent, lease) : null;
    consume = true;
    const operation = phase === 'sign' ? s.transport.sign(record, intent, lease) : s.transport.submit(signed!, record, intent, lease);
    if (phase === 'sign') await expect(operation).rejects.toMatchObject({ cause: { code: 'exchange_approval_evidence_invalid' } });
    else await expect(operation).rejects.toThrow('exchange_approval_evidence_invalid');
    expect(s.signTypedData).toHaveBeenCalledTimes(phase === 'sign' ? 0 : 1);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each(['sign', 'submit'] as const)('expired risk evidence blocks %s even when final market and authorization proofs are refreshed', async phase => {
    let clock = now;
    const riskGate: LiveExecutionGate = { assertReady: async ({ phase, record }) => {
      const capturedAt = clock;
      return { phase, key: record.key, fingerprint: record.fingerprint, assertFresh: () => {
        if (clock - capturedAt > 5000) throw new Error('risk_evidence_expired');
      } };
    } };
    const s = setup(riskGate, exchangeApprovalFixture(() => clock), () => clock);
    const signed = phase === 'submit' ? await s.transport.sign(record, intent, lease) : null;
    let reads = 0;
    s.resolver.resolve = async () => {
      if (++reads === (phase === 'sign' ? 2 : 1)) clock += 5001;
      return { ...market, observedAt: clock };
    };
    const operation = phase === 'sign' ? s.transport.sign(record, intent, lease) : s.transport.submit(signed!, record, intent, lease);
    if (phase === 'sign') await expect(operation).rejects.toMatchObject({ cause: { message: 'risk_evidence_expired' } });
    else await expect(operation).rejects.toThrow('final_execution_check_failed');
    expect(s.signTypedData).toHaveBeenCalledTimes(phase === 'sign' ? 0 : 1);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('refuses an old void-returning gate before SDK signing', async () => {
    const s = setup({ assertReady: async () => {} } as never);
    await expect(s.transport.sign(record, intent, lease)).rejects.toMatchObject({ cause: { code: 'live_execution_permit_invalid' } });
    expect(s.signTypedData).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("exchange revocation inside the signing risk gate prevents the SDK signing request", async () => {
    const approval = realApprovalFixture();
    const s = setup(executionGateFixture(async () => { approval.revoke(); }), approval.verifier);
    await expect(s.transport.sign(record, intent, lease)).rejects.toMatchObject({ cause: { code: "exchange_agent_not_approved" } });
    expect(s.signTypedData).not.toHaveBeenCalled();
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("exchange revocation inside the submission risk gate prevents the exchange POST", async () => {
    const approval = realApprovalFixture();
    let revokeOnGate = false;
    const s = setup(executionGateFixture(async () => { if (revokeOnGate) approval.revoke(); }), approval.verifier);
    const signed = await s.transport.sign(record, intent, lease);
    revokeOnGate = true;
    await expect(s.transport.submit(signed, record, intent, lease)).rejects.toThrow("exchange_agent_not_approved");
    expect(s.signTypedData).toHaveBeenCalledTimes(1);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(approval.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(["sign", "submit"] as const)("a delayed final lease blocks %s when proof becomes stale", async (phase) => {
    let clock = now;
    const approval = realApprovalFixture(() => clock);
    const s = setup(gate, approval.verifier, () => clock);
    const signed = phase === "submit" ? await s.transport.sign(record, intent, lease) : null;
    s.signTypedData.mockClear();
    let checks = 0;
    const slowLease = { assertHeld: async () => { if (++checks === 2) clock = now + 5_001; } };
    const operation = phase === "sign" ? s.transport.sign(record, intent, slowLease) : s.transport.submit(signed!, record, intent, slowLease);
    if (phase === "sign") await expect(operation).rejects.toMatchObject({ cause: { code: "exchange_approval_evidence_invalid" } });
    else await expect(operation).rejects.toThrow("exchange_approval_evidence_invalid");
    expect(s.signTypedData).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each(["sign", "submit"] as const)("a delayed final lease blocks %s when the exchange agent expires within the freshness window", async (phase) => {
    let clock = now;
    const approval = realApprovalFixture(() => clock, now + 1_000);
    const s = setup(gate, approval.verifier, () => clock);
    const signed = phase === "submit" ? await s.transport.sign(record, intent, lease) : null;
    s.signTypedData.mockClear();
    let checks = 0;
    const slowLease = { assertHeld: async () => { if (++checks === 2) clock = now + 1_001; } };
    const operation = phase === "sign" ? s.transport.sign(record, intent, slowLease) : s.transport.submit(signed!, record, intent, slowLease);
    if (phase === "sign") await expect(operation).rejects.toMatchObject({ cause: { code: "exchange_approval_evidence_invalid" } });
    else await expect(operation).rejects.toThrow("exchange_approval_evidence_invalid");
    expect(s.signTypedData).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each(["sign", "submit"] as const)("a delayed final lease blocks %s when local consent expires", async (phase) => {
    let clock = now;
    const approval = realApprovalFixture(() => clock);
    const shortGrant = { ...grant, expiresAt: now + 1_000 };
    const shortRecord = { ...record, authorization: shortGrant };
    const s = setup(gate, approval.verifier, () => clock, shortGrant);
    const signed = phase === "submit" ? await s.transport.sign(shortRecord, intent, lease) : null;
    s.signTypedData.mockClear();
    let checks = 0;
    const slowLease = { assertHeld: async () => { if (++checks === 2) clock = now + 1_001; } };
    const operation = phase === "sign" ? s.transport.sign(shortRecord, intent, slowLease) : s.transport.submit(signed!, shortRecord, intent, slowLease);
    if (phase === "sign") await expect(operation).rejects.toMatchObject({ cause: { code: "wallet_authorization_expired" } });
    else await expect(operation).rejects.toThrow("wallet_authorization_expired");
    expect(s.signTypedData).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("the complete executor rechecks approval after market proof and recovers after revocation without another signature", async () => {
    const approval = realApprovalFixture();
    const s = setup(gate, approval.verifier);
    let stored: LiveExecutionRecord | null = null;
    const journal: LiveExecutionJournal = {
      withOrderLock: async (_key, work) => work(lease), get: async () => stored,
      prepare: async (input) => stored ??= { key: input.key, fingerprint: input.fingerprint, authorization: input.authorization,
        action: input.action, nonce: input.now, expiresAfter: input.now + 60_000, state: "prepared", createdAt: input.now, updatedAt: input.now },
      save: async (value) => { stored = value; },
    };
    const executor = new LiveOrderExecutor(s.auth, journal, s.transport, gate, () => now);
    s.fetcher.mockRejectedValueOnce(new Error("Exchange accepted, response lost"));
    expect((await executor.execute(intent)).state).toBe("unknown");
    expect(approval.fetcher).toHaveBeenCalledTimes(3);
    expect(s.signTypedData).toHaveBeenCalledTimes(1);
    approval.revoke();
    s.fetcher.mockResolvedValueOnce(reply(statusReply("filled")));
    expect((await executor.execute(intent)).state).toBe("filled");
    expect(approval.fetcher).toHaveBeenCalledTimes(3);
    expect(s.signTypedData).toHaveBeenCalledTimes(1);
    expect(s.fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).type)).toEqual([undefined, "orderStatus"]);
  });
});

describe("testnet Hyperliquid SDK to Privy integration (offline)", () => {
  it('refuses a builder revoked while the signer waits for wallet identity', async () => {
    const s = setup();
    let cap = 10;
    s.fetcher.mockImplementation(async () => reply(cap));
    const get = s.get.getMockImplementation()!;
    s.get.mockImplementation(async () => { const wallet = await get(); cap = 0; return wallet; });
    const builderIntent = { ...intent, builder: { address: `0x${'33'.repeat(20)}`, feeTenthsBps: 10, approvedMaxFeeTenthsBps: 10 } };
    const action = buildOrderAction(builderIntent);
    const builderRecord = { ...record, action, fingerprint: intentFingerprint(builderIntent, action), market };
    await expect(s.transport.sign(builderRecord, builderIntent, lease)).rejects.toMatchObject({ cause: { code: 'builder_fee_not_approved' } });
    expect(s.signTypedData).not.toHaveBeenCalled();
  });
  it('refuses builder proof that becomes stale during the final signing lease', async () => {
    let clock = now;
    const s = setup(gate, exchangeApprovalFixture(() => clock), () => clock);
    s.fetcher.mockResolvedValue(reply(10));
    const builderIntent = { ...intent, builder: { address: `0x${'33'.repeat(20)}`, feeTenthsBps: 10, approvedMaxFeeTenthsBps: 10 } };
    const action = buildOrderAction(builderIntent);
    const builderRecord = { ...record, action, fingerprint: intentFingerprint(builderIntent, action), market };
    let checks = 0;
    const slowLease = { assertHeld: async () => { if (++checks === 2) clock += 5001; } };
    await expect(s.transport.sign(builderRecord, builderIntent, slowLease)).rejects.toThrow();
    expect(s.signTypedData).not.toHaveBeenCalled();
  });
  it('checks builder proof after a delayed final approval read even when that approval is fresh', async () => {
    let clock = now, reads = 0;
    const s = setup(gate, { verify: async (grant) => {
      if (++reads === 2) clock = now + 5001;
      return { network: grant.network, accountAddress: grant.accountAddress, signerAddress: grant.signerAddress,
        checkedAt: clock, expiresAt: null };
    } }, () => clock);
    const builderIntent = { ...intent, market: undefined,
      builder: { address: `0x${'33'.repeat(20)}`, feeTenthsBps: 10, approvedMaxFeeTenthsBps: 10 } };
    const action = buildOrderAction(builderIntent);
    const builderRecord = { ...record, action, fingerprint: intentFingerprint(builderIntent, action) };
    const wallet = s.signer.wallet(builderRecord, builderIntent, lease, async () => ({ builder: {
      network: 'testnet', accountAddress: grant.accountAddress, builderAddress: `0x${'33'.repeat(20)}`,
      feeTenthsBps: 10, approvedMaxFeeTenthsBps: 10, checkedAt: now } }));
    await expect(signL1Action({ wallet, action: { ...action }, nonce: now, expiresAfter: record.expiresAfter, isTestnet: true }))
      .rejects.toMatchObject({ cause: { code: 'builder_approval_proof_invalid' } });
    expect(s.signTypedData).not.toHaveBeenCalled();
  });
  it('uses fresh exchange builder approval before POST rather than the incoming claimed cap', async () => {
    const s = setup(); let cap = 10;
    s.fetcher.mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      expect(body).toEqual({ type: 'maxBuilderFee', user: grant.accountAddress, builder: `0x${'33'.repeat(20)}` });
      return reply(cap);
    });
    const builderIntent = { ...intent, builder: { address: `0x${'33'.repeat(20)}`, feeTenthsBps: 10, approvedMaxFeeTenthsBps: 100 } };
    const action = buildOrderAction(builderIntent);
    const builderRecord = { ...record, action, fingerprint: intentFingerprint(builderIntent, action), market };
    const signed = await s.transport.sign(builderRecord, builderIntent, lease);
    cap = 0;
    await expect(s.transport.submit(signed, builderRecord, builderIntent, lease)).rejects.toThrow('builder_fee_not_approved');
    expect(s.fetcher.mock.calls.every(([url]) => String(url).endsWith('/info'))).toBe(true);
  });
  it('refuses production reconciliation without market resolver and request budget', async () => {
    const s = setup();
    const transport = new HyperliquidLiveTransport('testnet', s.signer, gate, s.fetcher, 10000, () => now);
    await expect(transport.query(record)).rejects.toThrow('live_market_resolver_missing');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('does not accept order status after the market observation aged during HTTP', async () => {
    let clock = now;
    const s = setup(gate, exchangeApprovalFixture(() => clock), () => clock);
    s.fetcher.mockImplementation(async () => { clock += 5001; return reply(statusReply('filled')); });
    await expect(s.transport.query(record)).rejects.toThrow('live_boundary_evidence_expired');
  });
  it("uses installed SDK canonical hashing, Agent EIP-712, durable nonce, and fixed testnet POST", async () => {
    const { transport, signTypedData, fetcher } = setup();
    const signed = await transport.sign(record, intent, lease);
    const input = signTypedData.mock.calls[0]![1];
    expect(signTypedData.mock.calls[0]![0]).toBe("wallet");
    expect(input).toMatchObject({ address: grant.signerAddress, request_expiry: record.expiresAfter,
      params: { typed_data: { primary_type: "Agent", domain: { name: "Exchange", version: "1", chainId: 1337 },
        message: { source: "b", connectionId: createL1ActionHash({ action: { ...action }, nonce: now, expiresAfter: record.expiresAfter }) } } } });
    expect(signed.signature).toEqual(splitSignature((await signTypedData.mock.results[0]!.value).signature));
    fetcher.mockResolvedValue(reply({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.01", avgPx: "64999", oid: 10 } }] } } }));
    expect(await transport.submit(signed, record, intent, lease)).toEqual({ state: "filled", filledSize: "0.01", averagePrice: "64999", exchangeOrderId: "10" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(options!.body as string)).toEqual(signed);
  });
  it.each([{ owner_id: "wrong" }, { address: `0x${"33".repeat(20)}` }, { chain_type: "solana" }, { archived_at: now }])("rejects Privy identity mismatch %j", async (override) => {
    const { transport, wallet, signTypedData } = setup(); Object.assign(wallet, override);
    await expect(transport.sign(record, intent, lease)).rejects.toMatchObject({ cause: { code: "privy_wallet_identity_mismatch" } });
    expect(signTypedData).not.toHaveBeenCalled();
  });
  it("scoped signer refuses arbitrary typed data before calling Privy", async () => {
    const { signer, get } = setup();
    await expect(signer.wallet(record, intent, lease).signTypedData({ domain: { name: "Exchange", version: "1", chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000" }, types: {}, primaryType: "Agent",
      message: { source: "a", connectionId: `0x${"00".repeat(32)}` } })).rejects.toThrow("signer_payload_outside_order_scope");
    expect(get).not.toHaveBeenCalled();
  });
  it('captures the validated typed data before a delayed wallet read', async () => {
    const s = setup();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    s.get.mockImplementation(async () => { entered(); await held; return s.wallet; });
    const data = { domain: { name: 'Exchange', version: '1', chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000' as const },
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      primaryType: 'Agent', message: { source: 'b', connectionId: createL1ActionHash({ action: { ...action }, nonce: now, expiresAfter: record.expiresAfter }) } };
    const original = structuredClone(data);
    const signing = s.signer.wallet(record, intent, lease).signTypedData(data);
    await waiting;
    data.domain.name = 'Other'; data.domain.chainId = 1;
    data.message.source = 'a'; data.message.connectionId = `0x${'00'.repeat(32)}`;
    data.types.Agent[0].name = 'changed';
    release();
    await signing;
    expect(s.signTypedData.mock.calls[0]![1]).toMatchObject({ params: { typed_data: {
      domain: original.domain, message: original.message, types: original.types } } });
  });
  it("refuses a persisted payload changed behind its fingerprint", async () => {
    const { transport, get } = setup();
    const corrupted = structuredClone(record); corrupted.action.orders[0].s = "1";
    await expect(transport.sign(corrupted, intent, lease)).rejects.toThrow("persisted_order_payload_mismatch");
    expect(get).not.toHaveBeenCalled();
  });
  it("submission refuses a changed signed payload before any POST", async () => {
    const { transport, fetcher } = setup();
    const signed = await transport.sign(record, intent, lease);
    signed.action.orders[0].s = "1";
    await expect(transport.submit(signed, record, intent, lease)).rejects.toThrow("signed_order_payload_mismatch");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("submission without a current execution lease cannot POST", async () => {
    const { transport, fetcher } = setup();
    const signed = await transport.sign(record, intent, lease);
    await expect(transport.submit(signed, record, intent, undefined as never)).rejects.toThrow("execution_lease_missing");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks current risk after remote wallet lookup and before requesting a signature", async () => {
    let denied = false;
    const { transport, get, signTypedData } = setup(executionGateFixture(async () => { if (denied) throw new Error("risk_changed"); }));
    const read = get.getMockImplementation()!;
    get.mockImplementationOnce(async () => { const wallet = await read(); denied = true; return wallet; });
    await expect(transport.sign(record, intent, lease)).rejects.toMatchObject({ cause: { message: "risk_changed" } });
    expect(signTypedData).not.toHaveBeenCalled();
  });
  it("submission refuses a newly denied final gate before HTTP", async () => {
    let denied = false;
    const { transport, fetcher } = setup(executionGateFixture(async () => { if (denied) throw new Error("risk_changed"); }));
    const signed = await transport.sign(record, intent, lease); denied = true;
    await expect(transport.submit(signed, record, intent, lease)).rejects.toThrow("final_execution_check_failed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("queries master account and original cloid, preserves partial resting status", async () => {
    const { transport, fetcher } = setup();
    fetcher.mockResolvedValue(reply(statusReply("open", { sz: "0.007" })));
    expect(await transport.query(record)).toEqual({ state: "resting", exchangeOrderId: "10", filledSize: "0.003" });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ type: "orderStatus", user: grant.accountAddress, oid: intent.cloid });
  });
  it("missing cloid supplies no retry authorization", async () => {
    const { transport, fetcher } = setup(); fetcher.mockResolvedValue(reply({ status: "unknownOid" }));
    expect(await transport.query(record)).toBeNull();
  });
  it("terminal partially cancelled orders preserve exact filled size", async () => {
    const { transport, fetcher } = setup(); fetcher.mockResolvedValue(reply(statusReply("iocCancelRejected")));
    expect((await transport.query(record))?.state).toBe("rejected");
    fetcher.mockResolvedValue(reply(statusReply("canceled", { sz: "0.007" })));
    expect(await transport.query(record)).toEqual({ state: "partial", exchangeOrderId: "10", filledSize: "0.003" });
  });
  it.each([{ cloid: `0x${"cd".repeat(16)}` }, { side: "A" }, { origSz: "0.02" }, { limitPx: "64000" }, { sz: "0.02" }, { coin: 'ETH' }, { reduceOnly: true }, { tif: 'Gtc' }])("rejects mismatched exchange order evidence %j", async (override) => {
    const { transport, fetcher } = setup(); fetcher.mockResolvedValue(reply(statusReply("filled", override)));
    await expect(transport.query(record)).rejects.toThrow();
  });
  it("does not automatically retry HTTP errors and rejects malformed success", async () => {
    const { transport, fetcher } = setup(); const signed = await transport.sign(record, intent, lease);
    fetcher.mockResolvedValue(new Response("upstream failure", { status: 503 }));
    await expect(transport.submit(signed, record, intent, lease)).rejects.toThrow("exchange_http_failure");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(reply({ status: "ok", response: { type: "order", data: { statuses: [] } } }));
    await expect(transport.submit(signed, record, intent, lease)).rejects.toThrow("invalid_exchange_order_count");
  });
});
