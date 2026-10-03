import { assertLiveExecutionReady, assertLiveExecutionPermit, assertSignedOrderMatches, LiveSubmissionBlockedError, type LiveExecutionGate, type LiveExecutionLease } from "./live-execution-gate.js";
import { canonicalize, signL1Action } from "@nktkas/hyperliquid/signing";
import { isDeepStrictEqual } from "node:util";
import { OrderRequest } from "@nktkas/hyperliquid/api/exchange";
import { Dec } from "../../common/decimal/dec.js";
import { LiveBoundaryError, type LiveNetwork } from "./wallet-authorization.js";
import { buildOrderAction, executionKey, intentFingerprint, wireDecimal, type LiveOrderIntent } from "./live-order.js";
import type { ExchangeOutcome, LiveExchangeTransport, LiveExecutionRecord, SignedLiveOrder } from "./live-execution.js";
import { PrivyOrderSigner, assertLiveSigningBoundaryProof, type LiveBuilderApprovalProof } from "./privy-order-signer.js";
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { boundedLiveRead, marketIdentityKey, type LiveMarketIdentity, type LiveMarketResolver } from './live-market-resolver.js';
import { parseLiveOrderEvidence, type LiveOrderEvidence } from './live-order-evidence.js';

export interface LiveTransportDependencies {
  marketResolver: LiveMarketResolver;
  acquire: (weight: number) => Promise<unknown>;
}

// Protocol statuses, not suffix guesses. Unknown future statuses retain
// uncertainty until their meaning is explicitly reviewed.
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-order-status-by-oid-or-cloid
const canceledStatuses = new Set(['canceled', 'marginCanceled', 'vaultWithdrawalCanceled', 'openInterestCapCanceled',
  'selfTradeCanceled', 'reduceOnlyCanceled', 'siblingFilledCanceled', 'delistedCanceled', 'liquidatedCanceled', 'scheduledCancel']);
const rejectedStatuses = new Set(['rejected', 'tickRejected', 'minTradeNtlRejected', 'perpMarginRejected', 'reduceOnlyRejected',
  'badAloPxRejected', 'iocCancelRejected', 'badTriggerPxRejected', 'marketOrderNoLiquidityRejected',
  'positionIncreaseAtOpenInterestCapRejected', 'positionFlipAtOpenInterestCapRejected', 'tooAggressiveAtOpenInterestCapRejected',
  'openInterestIncreaseRejected', 'insufficientSpotBalanceRejected', 'oracleRejected', 'perpMaxPositionRejected']);
// Only exact documented order-placement errors prove rejection. Top-level
// errors (including nonce reuse) and unknown messages may describe a prior
// accepted request; they must flow through durable unknown reconciliation.
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses
const placementErrors = new Set(['Price must be divisible by tick size.', 'Order must have minimum value of $10.',
  'Insufficient margin to place order.', 'Reduce only order would increase position.',
  'Order could not immediately match against any resting orders.', 'Invalid TP/SL price.',
  'No liquidity available for market order.', 'Order would increase open interest while open interest is capped',
  'Order would increase open interest too quickly', 'Order price too far from oracle',
  'Order would cause position to exceed margin tier limit at current leverage']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LiveBoundaryError("invalid_exchange_response");
  return value as Record<string, unknown>;
}
function orderId(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new LiveBoundaryError("invalid_exchange_order_id");
  return String(value);
}
function size(value: unknown): string {
  if (value === "0" || value === "0.0") return "0";
  if (typeof value !== "string") throw new LiveBoundaryError("invalid_exchange_size");
  const parsed = Dec.from(value);
  if (parsed.isZero && /^0(?:\.0+)?$/.test(value)) return "0";
  return wireDecimal(value);
}

/** Uses the SDK's canonical msgpack/hash/EIP-712 implementation, never homemade signing.
 * Endpoints are fixed at construction; no caller-provided URL or automatic POST retry. */
export class HyperliquidLiveTransport implements LiveExchangeTransport {
  private readonly endpoint: string;
  constructor(readonly network: LiveNetwork, private readonly signer: PrivyOrderSigner, private readonly gate: LiveExecutionGate,
    private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 10_000, private readonly now = Date.now,
    private readonly dependencies?: LiveTransportDependencies) {
    if (!["mainnet", "testnet"].includes(network)) throw new LiveBoundaryError("unsupported_exchange_network");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new LiveBoundaryError("invalid_exchange_timeout");
    this.endpoint = network === "testnet" ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
  }

  async sign(record: LiveExecutionRecord, intent: LiveOrderIntent, lease: LiveExecutionLease): Promise<SignedLiveOrder> {
    record = structuredClone(record);
    intent = structuredClone(intent);
    if (record.authorization.network !== this.network || intent.network !== this.network) throw new LiveBoundaryError("transport_network_mismatch");
    const approved = buildOrderAction(intent);
    if (!isDeepStrictEqual(record.action, approved) || record.key !== executionKey(intent) || record.fingerprint !== intentFingerprint(intent, approved)) throw new LiveBoundaryError("persisted_order_payload_mismatch");
    const market = await this.verifyMarket(intent, record);
    const builder = await this.verifyBuilder(record);
    this.assertObservationFresh(market.observedAt);
    if (builder) this.assertObservationFresh(builder.checkedAt);
    const action = canonicalize(OrderRequest.entries.action, record.action);
    const canonicalRecord = { ...record, action };
    const signature = await signL1Action({ wallet: this.signer.wallet(canonicalRecord, intent, lease,
      async (saved, approvedIntent) => ({ market: await this.verifyMarket(approvedIntent, saved),
        ...(saved.action.builder ? { builder: (await this.verifyBuilder(saved))! } : {}) })), action: { ...action }, nonce: record.nonce,
      expiresAfter: record.expiresAfter, isTestnet: this.network === "testnet" });
    return { action, nonce: record.nonce, expiresAfter: record.expiresAfter, signature };
  }

  async submit(order: SignedLiveOrder, record: LiveExecutionRecord, intent: LiveOrderIntent, lease: LiveExecutionLease): Promise<ExchangeOutcome> {
    try {
      record = structuredClone(record);
      intent = structuredClone(intent);
      if (record.authorization.network !== this.network || intent.network !== this.network) throw new LiveBoundaryError("transport_network_mismatch");
      const action = buildOrderAction(intent);
      if (!isDeepStrictEqual(record.action, action) || record.key !== executionKey(intent) || record.fingerprint !== intentFingerprint(intent, action)) throw new LiveBoundaryError("persisted_order_payload_mismatch");
      // Detach from caller-owned objects before asynchronous final checks.
      order = structuredClone(order);
      assertSignedOrderMatches(order, record);
      await this.acquire(1);
      const permit = await assertLiveExecutionReady(this.gate, lease, "submit", intent, record);
      const market = await this.verifyMarket(intent, record);
      const builder = await this.verifyBuilder(record);
      // The risk adapter can perform remote reads. Verify exchange approval
      // after it too, immediately before starting the exchange POST.
      const verified = await this.signer.assertAuthorization(record, intent);
      await lease.assertHeld();
      assertLiveExecutionPermit(permit, 'submit', intent, record);
      this.signer.assertAuthorizationFresh(verified, intent);
      assertLiveSigningBoundaryProof({ market, ...(builder ? { builder } : {}) }, record, intent, this.now());
      if (order.expiresAfter <= this.now()) throw new LiveBoundaryError("signed_order_expired");
    } catch (error) {
      throw new LiveSubmissionBlockedError(error instanceof LiveBoundaryError ? error.code : "final_execution_check_failed");
    }
    const body = object(await this.post("exchange", order, true));
    if (body.status === "err") throw new LiveBoundaryError('exchange_submission_ambiguous');
    if (body.status !== "ok") throw new LiveBoundaryError("invalid_exchange_response");
    const response = object(body.response);
    if (response.type !== "order") throw new LiveBoundaryError("invalid_exchange_response_type");
    const statuses = object(response.data).statuses;
    if (!Array.isArray(statuses) || statuses.length !== 1) throw new LiveBoundaryError("invalid_exchange_order_count");
    const result = object(statuses[0]);
    if (typeof result.error === "string") {
      if (!placementErrors.has(result.error)) throw new LiveBoundaryError('exchange_submission_ambiguous');
      return { state: "rejected", reason: "exchange_rejected_order" };
    }
    if (result.resting) return { state: "resting", exchangeOrderId: orderId(object(result.resting).oid) };
    if (result.filled) {
      const filled = object(result.filled);
      const filledSize = size(filled.totalSz);
      if (Dec.from(filledSize).gt(order.action.orders[0].s)) throw new LiveBoundaryError("exchange_fill_exceeds_order");
      if (filledSize === "0") return { state: "cancelled", filledSize: "0", reason: "ioc_unfilled" };
      if (Dec.from(filledSize).lt(order.action.orders[0].s) && order.action.orders[0].t.limit.tif !== "Ioc") throw new LiveBoundaryError("non_ioc_partial_fill_requires_reconciliation");
      return { state: Dec.from(filledSize).eq(order.action.orders[0].s) ? "filled" : "partial", exchangeOrderId: orderId(filled.oid),
        filledSize, averagePrice: wireDecimal(String(filled.avgPx)) };
    }
    throw new LiveBoundaryError("unrecognized_exchange_submission");
  }

  async query(record: LiveExecutionRecord): Promise<ExchangeOutcome | null> {
    record = structuredClone(record);
    if (record.authorization.network !== this.network) throw new LiveBoundaryError("transport_network_mismatch");
    const market = await boundedLiveRead(this.resolver().resolveAsset(record.action.orders[0].a), 5_000);
    if (record.market && !isDeepStrictEqual(marketIdentityKey(record.market), marketIdentityKey(market)))
      throw new LiveBoundaryError('exchange_market_identity_mismatch');
    this.assertObservationFresh(market.observedAt);
    const body = object(await this.post("info", { type: "orderStatus", user: record.authorization.accountAddress, oid: record.action.orders[0].c }));
    this.assertObservationFresh(market.observedAt);
    if (body.status === "unknownOid") return null;
    if (body.status !== "order") throw new LiveBoundaryError("invalid_exchange_order_status");
    const status = object(body.order);
    const order = object(status.order);
    const expected = record.action.orders[0];
    if (order.coin !== market.coin || order.reduceOnly !== expected.r || order.tif !== expected.t.limit.tif ||
        order.cloid !== expected.c || order.side !== (expected.b ? "B" : "A") || Dec.from(size(order.origSz)).cmp(expected.s) !== 0 ||
        Dec.from(wireDecimal(String(order.limitPx))).cmp(expected.p) !== 0) throw new LiveBoundaryError("exchange_order_identity_mismatch");
    const remaining = size(order.sz);
    if (Dec.from(remaining).gt(expected.s)) throw new LiveBoundaryError("exchange_remaining_exceeds_order");
    const filledSize = Dec.from(expected.s).sub(remaining).toString();
    const exchangeOrderId = orderId(order.oid);
    if (status.status === "open") return { state: "resting", exchangeOrderId, filledSize };
    if (status.status === "filled") return { state: "filled", exchangeOrderId, filledSize: expected.s };
    if (typeof status.status === "string" && canceledStatuses.has(status.status)) {
      return { state: filledSize === "0" ? "cancelled" : "partial", exchangeOrderId, filledSize };
    }
    if (typeof status.status === "string" && rejectedStatuses.has(status.status)) return { state: "rejected", exchangeOrderId, reason: "exchange_rejected_order" };
    throw new LiveBoundaryError("unrecognized_exchange_order_status");
  }

  /** Separate settlement-grade read evidence. Legacy query outcomes alone do
   * not carry terminal source timing or authoritative cancellation quantity. */
  async queryEvidence(supplied: LiveExecutionRecord): Promise<Readonly<LiveOrderEvidence>> {
    const record = structuredClone(supplied), checkedAt = this.now();
    if (this.network !== 'testnet' || record.authorization.network !== 'testnet') throw new LiveBoundaryError('transport_network_mismatch');
    const remaining = () => {
      this.assertObservationFresh(checkedAt); return Math.max(1, 5000 - (this.now() - checkedAt));
    };
    const market = await boundedLiveRead(this.resolver().resolveAsset(record.action.orders[0].a), remaining());
    await boundedLiveRead(this.acquire(20), remaining());
    const response = await boundedLiveRead(this.fetcher(`${this.endpoint}/info`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'orderStatus', user: record.authorization.accountAddress, oid: record.action.orders[0].c }),
      signal: AbortSignal.timeout(remaining()), redirect: 'error' }), remaining());
    if (!response.ok) throw new LiveBoundaryError('exchange_http_failure');
    const raw = await boundedLiveRead(readInfoJson(response, 'live order evidence', 256 * 1024), remaining());
    const completedAt = this.now(), evidence = parseLiveOrderEvidence({ record, market, raw, checkedAt, completedAt, now: completedAt });
    this.assertObservationFresh(checkedAt); return evidence;
  }

  private resolver(): LiveMarketResolver {
    if (!this.dependencies?.marketResolver || this.dependencies.marketResolver.network !== this.network)
      throw new LiveBoundaryError('live_market_resolver_missing');
    return this.dependencies.marketResolver;
  }
  private async verifyMarket(intent: LiveOrderIntent, record: LiveExecutionRecord): Promise<LiveMarketIdentity> {
    if (!intent.market) throw new LiveBoundaryError('live_market_identity_missing');
    const market = await boundedLiveRead(this.resolver().resolve(intent.market.coin), 5_000);
    if (!isDeepStrictEqual(marketIdentityKey(intent.market), marketIdentityKey(market)) ||
        (record.market && !isDeepStrictEqual(marketIdentityKey(record.market), marketIdentityKey(market))) ||
        market.asset !== record.action.orders[0].a || market.sizeDecimals !== intent.sizeDecimals)
      throw new LiveBoundaryError('live_market_identity_mismatch');
    this.assertObservationFresh(market.observedAt);
    return market;
  }
  private assertObservationFresh(at: number): void {
    if (!Number.isSafeInteger(at) || at > this.now() || this.now() - at > 5_000)
      throw new LiveBoundaryError('live_boundary_evidence_expired');
  }
  private async verifyBuilder(record: LiveExecutionRecord): Promise<LiveBuilderApprovalProof | null> {
    if (!record.action.builder) return null;
    const checkedAt = this.now();
    const cap = await this.post('info', { type: 'maxBuilderFee', user: record.authorization.accountAddress,
      builder: record.action.builder.b });
    if (!Number.isSafeInteger(cap) || (cap as number) < record.action.builder.f || (cap as number) < 0 || (cap as number) > 100)
      throw new LiveBoundaryError('builder_fee_not_approved');
    this.assertObservationFresh(checkedAt);
    return { network: this.network, accountAddress: record.authorization.accountAddress,
      builderAddress: record.action.builder.b, feeTenthsBps: record.action.builder.f,
      approvedMaxFeeTenthsBps: cap as number, checkedAt };
  }
  private async acquire(weight: number): Promise<void> {
    if (!this.dependencies || typeof this.dependencies.acquire !== 'function') throw new LiveBoundaryError('live_request_budget_missing');
    await boundedLiveRead(this.dependencies.acquire(weight), 5_000);
  }
  private async post(path: "info" | "exchange", body: unknown, admitted = false): Promise<unknown> {
    if (!admitted) await this.acquire(path === 'exchange' ? 1 : 20);
    const response = await boundedLiveRead(this.fetcher(`${this.endpoint}/${path}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" }), this.timeoutMs);
    if (!response.ok) throw new LiveBoundaryError("exchange_http_failure");
    return boundedLiveRead(readInfoJson(response, 'live exchange', 256 * 1024), this.timeoutMs);
  }
}
