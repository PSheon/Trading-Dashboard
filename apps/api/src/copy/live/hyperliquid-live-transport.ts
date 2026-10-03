import { assertLiveExecutionReady, assertSignedOrderMatches, LiveSubmissionBlockedError, type LiveExecutionGate, type LiveExecutionLease } from "./live-execution-gate.js";
import { canonicalize, signL1Action } from "@nktkas/hyperliquid/signing";
import { isDeepStrictEqual } from "node:util";
import { OrderRequest } from "@nktkas/hyperliquid/api/exchange";
import { Dec } from "../../common/decimal/dec.js";
import { LiveBoundaryError, type LiveNetwork } from "./wallet-authorization.js";
import { buildOrderAction, executionKey, intentFingerprint, wireDecimal, type LiveOrderIntent } from "./live-order.js";
import type { ExchangeOutcome, LiveExchangeTransport, LiveExecutionRecord, SignedLiveOrder } from "./live-execution.js";
import { PrivyOrderSigner } from "./privy-order-signer.js";

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
    private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 10_000, private readonly now = Date.now) {
    if (!["mainnet", "testnet"].includes(network)) throw new LiveBoundaryError("unsupported_exchange_network");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new LiveBoundaryError("invalid_exchange_timeout");
    this.endpoint = network === "testnet" ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
  }

  async sign(record: LiveExecutionRecord, intent: LiveOrderIntent, lease: LiveExecutionLease): Promise<SignedLiveOrder> {
    if (record.authorization.network !== this.network || intent.network !== this.network) throw new LiveBoundaryError("transport_network_mismatch");
    const approved = buildOrderAction(intent);
    if (!isDeepStrictEqual(record.action, approved) || record.key !== executionKey(intent) || record.fingerprint !== intentFingerprint(intent, approved)) throw new LiveBoundaryError("persisted_order_payload_mismatch");
    const action = canonicalize(OrderRequest.entries.action, record.action);
    const canonicalRecord = { ...record, action };
    const signature = await signL1Action({ wallet: this.signer.wallet(canonicalRecord, intent, lease), action: { ...action }, nonce: record.nonce,
      expiresAfter: record.expiresAfter, isTestnet: this.network === "testnet" });
    return { action, nonce: record.nonce, expiresAfter: record.expiresAfter, signature };
  }

  async submit(order: SignedLiveOrder, record: LiveExecutionRecord, intent: LiveOrderIntent, lease: LiveExecutionLease): Promise<ExchangeOutcome> {
    try {
      if (record.authorization.network !== this.network || intent.network !== this.network) throw new LiveBoundaryError("transport_network_mismatch");
      const action = buildOrderAction(intent);
      if (!isDeepStrictEqual(record.action, action) || record.key !== executionKey(intent) || record.fingerprint !== intentFingerprint(intent, action)) throw new LiveBoundaryError("persisted_order_payload_mismatch");
      // Detach from caller-owned objects before asynchronous final checks.
      order = structuredClone(order);
      assertSignedOrderMatches(order, record);
      await assertLiveExecutionReady(this.gate, lease, "submit", intent, record);
      // The risk adapter can perform remote reads. Verify exchange approval
      // after it too, immediately before starting the exchange POST.
      const verified = await this.signer.assertAuthorization(record, intent);
      await lease.assertHeld();
      this.signer.assertAuthorizationFresh(verified, intent);
      if (order.expiresAfter <= this.now()) throw new LiveBoundaryError("signed_order_expired");
    } catch (error) {
      throw new LiveSubmissionBlockedError(error instanceof LiveBoundaryError ? error.code : "final_execution_check_failed");
    }
    const body = object(await this.post("exchange", order));
    if (body.status === "err") return { state: "rejected", reason: "exchange_rejected_action" };
    if (body.status !== "ok") throw new LiveBoundaryError("invalid_exchange_response");
    const response = object(body.response);
    if (response.type !== "order") throw new LiveBoundaryError("invalid_exchange_response_type");
    const statuses = object(response.data).statuses;
    if (!Array.isArray(statuses) || statuses.length !== 1) throw new LiveBoundaryError("invalid_exchange_order_count");
    const result = object(statuses[0]);
    if (typeof result.error === "string") return { state: "rejected", reason: "exchange_rejected_order" };
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
    if (record.authorization.network !== this.network) throw new LiveBoundaryError("transport_network_mismatch");
    const body = object(await this.post("info", { type: "orderStatus", user: record.authorization.accountAddress, oid: record.action.orders[0].c }));
    if (body.status === "unknownOid") return null;
    if (body.status !== "order") throw new LiveBoundaryError("invalid_exchange_order_status");
    const status = object(body.order);
    const order = object(status.order);
    const expected = record.action.orders[0];
    if (order.cloid !== expected.c || order.side !== (expected.b ? "B" : "A") || Dec.from(size(order.origSz)).cmp(expected.s) !== 0 ||
        Dec.from(wireDecimal(String(order.limitPx))).cmp(expected.p) !== 0) throw new LiveBoundaryError("exchange_order_identity_mismatch");
    const remaining = size(order.sz);
    if (Dec.from(remaining).gt(expected.s)) throw new LiveBoundaryError("exchange_remaining_exceeds_order");
    const filledSize = Dec.from(expected.s).sub(remaining).toString();
    const exchangeOrderId = orderId(order.oid);
    if (status.status === "open") return { state: "resting", exchangeOrderId, filledSize };
    if (status.status === "filled") return { state: "filled", exchangeOrderId, filledSize: expected.s };
    if (typeof status.status === "string" && (status.status === "canceled" || status.status.endsWith("Canceled"))) {
      return { state: filledSize === "0" ? "cancelled" : "partial", exchangeOrderId, filledSize };
    }
    if (typeof status.status === "string" && (status.status === "rejected" || status.status.endsWith("Rejected"))) return { state: "rejected", exchangeOrderId, reason: "exchange_rejected_order" };
    throw new LiveBoundaryError("unrecognized_exchange_order_status");
  }

  private async post(path: "info" | "exchange", body: unknown): Promise<unknown> {
    const response = await this.fetcher(`${this.endpoint}/${path}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
    if (!response.ok) throw new LiveBoundaryError("exchange_http_failure");
    return response.json();
  }
}
