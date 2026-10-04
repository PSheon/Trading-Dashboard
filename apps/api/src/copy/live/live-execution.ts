import { assertLiveExecutionReady, assertLiveExecutionPermit, assertSignedOrderMatches, LiveSubmissionBlockedError, type LiveExecutionGate, type LiveExecutionLease } from "./live-execution-gate.js";
import { buildOrderAction, executionKey, intentFingerprint, type HyperliquidOrderAction, type LiveOrderIntent } from "./live-order.js";
import { isDeepStrictEqual } from "node:util";
import { LiveBoundaryError, WalletAuthorizationService, assertSameAuthorization, type LiveNetwork, type WalletAuthorization } from "./wallet-authorization.js";
import type { LiveMarketIdentity } from './live-market-resolver.js';
import type { LiveUnattemptedReleaseCertificate } from './live-unattempted-release.js';

export type LiveExecutionState = "prepared" | "submitting" | "unknown" | "resting" | "filled" | "partial" | "cancelled" | "rejected";
export interface ExchangeOutcome {
  state: Exclude<LiveExecutionState, "prepared" | "submitting" | "unknown">;
  exchangeOrderId?: string;
  filledSize?: string;
  averagePrice?: string;
  reason?: string;
}
export interface LiveExecutionRecord {
  key: string;
  fingerprint: string;
  authorization: WalletAuthorization;
  action: HyperliquidOrderAction;
  market?: LiveMarketIdentity;
  nonce: number;
  expiresAfter: number;
  state: LiveExecutionState;
  createdAt: number;
  updatedAt: number;
  outcome?: ExchangeOutcome;
  /** Codes only, never SDK errors containing authorization material. */
  errorCode?: string;
  /** Retained local zero-effect expiry proof; never exchange terminal evidence. */
  unattemptedRelease?: Readonly<LiveUnattemptedReleaseCertificate>;
}

export interface LiveExecutionJournal {
  /** Distributed, crash-released serialization. Do not hold a SQL transaction across HTTP. */
  withOrderLock<T>(key: string, work: (lease: LiveExecutionLease) => Promise<T>): Promise<T>;
  get(key: string): Promise<LiveExecutionRecord | null>;
  /** Atomic insert + monotonic nonce allocation scoped to network AND signer address.
   * Unique key is network/account/cloid. Return existing row on conflict; never overwrite.
   * nonce = max(now, previousNonce+1), expiresAfter = now+60_000.
   * Must commit BEFORE signing or submitting. */
  prepare(input: { key: string; fingerprint: string; authorization: WalletAuthorization; action: HyperliquidOrderAction; market?: LiveMarketIdentity; now: number }): Promise<LiveExecutionRecord>;
  /** Durable replace under withOrderLock; commit before returning. */
  save(record: LiveExecutionRecord): Promise<void>;
}

export interface SignedLiveOrder {
  action: HyperliquidOrderAction;
  nonce: number;
  expiresAfter: number;
  signature: { r: `0x${string}`; s: `0x${string}`; v: number };
}
export interface LiveExchangeTransport {
  readonly network: LiveNetwork;
  /** Must independently verify current local consent AND fresh exchange
   * approval after the risk gate, at the actual signing request boundary. */
  sign(record: LiveExecutionRecord, intent: LiveOrderIntent, lease: LiveExecutionLease): Promise<SignedLiveOrder>;
  /** Must repeat fresh exchange/local approval checks at the actual POST
   * boundary. Exceptions are ambiguous after POST. Only
   * LiveSubmissionBlockedError proves no request began. */
  submit(order: SignedLiveOrder, record: LiveExecutionRecord, intent: LiveOrderIntent, lease: LiveExecutionLease): Promise<ExchangeOutcome>;
  /** null means no evidence yet, not permission to retry. Query the trading account by cloid. */
  query(record: LiveExecutionRecord): Promise<ExchangeOutcome | null>;
}

/** Separate from paper accounting. It never fabricates fills or releases reservations. */
export class LiveOrderExecutor {
  constructor(private readonly authorizations: WalletAuthorizationService, private readonly journal: LiveExecutionJournal,
    private readonly transport: LiveExchangeTransport, private readonly gate: LiveExecutionGate, private readonly now = Date.now) {}

  async execute(intent: LiveOrderIntent): Promise<LiveExecutionRecord> {
    if (intent.network !== this.transport.network) throw new LiveBoundaryError("transport_network_mismatch");
    const action = buildOrderAction(intent);
    const key = executionKey(intent);
    const fingerprint = intentFingerprint(intent, action);
    return this.journal.withOrderLock(key, async (lease) => {
      let record = await this.journal.get(key);
      if (record && record.fingerprint !== fingerprint) throw new LiveBoundaryError("cloid_payload_conflict");
      if (record && !isDeepStrictEqual(record.action, action)) throw new LiveBoundaryError("persisted_order_payload_mismatch");
      // Reconciliation is read-only and remains possible after grant revocation/expiry.
      if (record && ["submitting", "unknown", "resting"].includes(record.state)) return this.reconcileLocked(record, lease);
      if (record && record.state !== "prepared") return record;
      const authorization = await this.authorizations.authorizeLocal(intent);
      record ??= await this.journal.prepare({ key, fingerprint, authorization, action, ...(intent.market ? { market: intent.market } : {}), now: this.now() });
      if (record.fingerprint !== fingerprint) throw new LiveBoundaryError("cloid_payload_conflict");
      if (record.key !== key || !isDeepStrictEqual(record.action, action)) throw new LiveBoundaryError("persisted_order_payload_mismatch");
      assertSameAuthorization(record.authorization, authorization);
      if (!Number.isSafeInteger(record.nonce) || record.nonce < record.createdAt || record.nonce > this.now() + 86_400_000) throw new LiveBoundaryError("invalid_persisted_nonce");
      if (record.expiresAfter <= this.now()) {
        return this.persist({ ...record, state: "rejected", errorCode: "prepared_order_expired", updatedAt: this.now() }, lease);
      }
      // Signing failures are definitely before submission and leave the order prepared.
      const signingPermit = await assertLiveExecutionReady(this.gate, lease, "sign", intent, record);
      assertLiveExecutionPermit(signingPermit, 'sign', intent, record);
      const signed = structuredClone(await this.transport.sign(structuredClone(record), structuredClone(intent), lease));
      assertSignedOrderMatches(signed, record);
      const fresh = await this.authorizations.authorizeLocal(intent);
      assertSameAuthorization(authorization, fresh);
      if (record.expiresAfter <= this.now()) throw new LiveBoundaryError("signed_order_expired");
      await lease.assertHeld();
      record = await this.persist({ ...record, state: "submitting", updatedAt: this.now(), errorCode: undefined }, lease);
      // Persistence can block long enough for controls or the lock to change.
      // Any failure before POST is a definite non-submission, never an unknown fill.
      try {
        const finalAuthorization = await this.authorizations.authorizeLocal(intent);
        assertSameAuthorization(authorization, finalAuthorization);
        const submissionPermit = await assertLiveExecutionReady(this.gate, lease, "submit", intent, record);
        if (record.expiresAfter <= this.now()) throw new LiveBoundaryError("signed_order_expired");
        assertSignedOrderMatches(signed, record);
        assertLiveExecutionPermit(submissionPermit, 'submit', intent, record);
      } catch (error) {
        // A lost session may have a successor owner; do not write from that worker.
        await lease.assertHeld();
        await this.persist({ ...record, state: "rejected", updatedAt: this.now(), errorCode: "final_execution_check_failed" }, lease);
        throw error;
      }
      let outcome: ExchangeOutcome;
      try { outcome = await this.transport.submit(signed, structuredClone(record), structuredClone(intent), lease); }
      catch (error) {
        await lease.assertHeld();
        if (error instanceof LiveSubmissionBlockedError) {
          return this.persist({ ...record, state: "rejected", errorCode: "final_execution_check_failed", updatedAt: this.now() }, lease);
        }
        return this.persist({ ...record, state: "unknown", errorCode: "exchange_submission_ambiguous", updatedAt: this.now() }, lease);
      }
      // A persistence failure or lost lease leaves durable submitting for reconciliation.
      await lease.assertHeld();
      return this.persist({ ...record, state: outcome.state, outcome, updatedAt: this.now() }, lease);
    });
  }

  async reconcile(key: string): Promise<LiveExecutionRecord> {
    return this.journal.withOrderLock(key, async (lease) => {
      const record = await this.journal.get(key);
      if (!record) throw new LiveBoundaryError("execution_missing");
      if (record.authorization.network !== this.transport.network) throw new LiveBoundaryError("transport_network_mismatch");
      return ["submitting", "unknown", "resting"].includes(record.state) ? this.reconcileLocked(record, lease) : record;
    });
  }

  private async reconcileLocked(record: LiveExecutionRecord, lease: LiveExecutionLease): Promise<LiveExecutionRecord> {
    let outcome: ExchangeOutcome | null;
    try { outcome = await this.transport.query(record); }
    catch { return this.persist({ ...record, state: record.state === "resting" ? "resting" : "unknown", errorCode: "exchange_reconciliation_unavailable", updatedAt: this.now() }, lease); }
    if (!outcome) return this.persist({ ...record, state: record.state === "resting" ? "resting" : "unknown", errorCode: "exchange_order_not_yet_found", updatedAt: this.now() }, lease);
    return this.persist({ ...record, state: outcome.state, outcome, errorCode: undefined, updatedAt: this.now() }, lease);
  }

  private async persist(record: LiveExecutionRecord, lease: LiveExecutionLease): Promise<LiveExecutionRecord> {
    await lease.assertHeld();
    await this.journal.save(record);
    return record;
  }
}
