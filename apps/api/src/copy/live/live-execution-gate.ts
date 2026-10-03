import type { LiveExecutionRecord, SignedLiveOrder } from "./live-execution.js";
import type { LiveOrderIntent } from "./live-order.js";
import { isDeepStrictEqual } from "node:util";
import { LiveBoundaryError } from "./wallet-authorization.js";
import { executionKey, intentFingerprint } from './live-order.js';

export interface LiveExecutionLease {
  /** Check the original lock session, never acquire a replacement lock. */
  assertHeld(): Promise<void>;
}

export interface LiveExecutionGate {
  /** Authoritative, uncached final check of current strategy/owner/platform controls,
   * risk policy, reservation ownership, funded collateral, quotes and market identity.
   * Verify dedicated execution-account ownership and supported master-account
   * role: a current agent listing alone does not establish either prerequisite.
   * Reject unavailable dependencies as well as denied risk. No permissive default.
   * Integration must use exact record.action/nonce, without resizing the order. */
  assertReady(input: { phase: "sign" | "submit"; intent: LiveOrderIntent; record: LiveExecutionRecord }): Promise<LiveExecutionPermit>;
}

/** Exact phase/order evidence, never a permanent Boolean authorization. The
 * synchronous callback rechecks the captured proof and original serialization
 * scope after all later awaits. No await may follow it before a side effect. */
export interface LiveExecutionPermit {
  readonly phase: 'sign' | 'submit';
  readonly key: string;
  readonly fingerprint: string;
  assertFresh(): void;
}

export function assertLiveExecutionPermit(permit: LiveExecutionPermit,
  phase: 'sign' | 'submit', intent: LiveOrderIntent, record: LiveExecutionRecord): void {
  if (!permit || permit.phase !== phase || permit.key !== record.key || permit.key !== executionKey(intent) ||
      permit.fingerprint !== record.fingerprint || permit.fingerprint !== intentFingerprint(intent, record.action) ||
      typeof permit.assertFresh !== 'function') throw new LiveBoundaryError('live_execution_permit_invalid');
  if (permit.assertFresh() !== undefined) throw new LiveBoundaryError('live_execution_permit_invalid');
}

export async function assertLiveExecutionReady(gate: LiveExecutionGate, lease: LiveExecutionLease,
  phase: "sign" | "submit", intent: LiveOrderIntent, record: LiveExecutionRecord): Promise<LiveExecutionPermit> {
  if (!gate || typeof gate.assertReady !== "function") throw new LiveBoundaryError("live_execution_gate_missing");
  if (!lease || typeof lease.assertHeld !== "function") throw new LiveBoundaryError("execution_lease_missing");
  const result = await gate.assertReady({ phase, intent: structuredClone(intent), record: structuredClone(record) });
  if (!result || typeof result.assertFresh !== 'function') throw new LiveBoundaryError('live_execution_permit_invalid');
  // Capture the exact callback and metadata before the lease wait; a later
  // mutation of the producer's returned object cannot replace this permit.
  const permit = Object.freeze({ phase: result.phase, key: result.key, fingerprint: result.fingerprint,
    assertFresh: result.assertFresh.bind(result) });
  await lease.assertHeld();
  assertLiveExecutionPermit(permit, phase, intent, record);
  return permit;
}

export function assertSignedOrderMatches(order: SignedLiveOrder, record: LiveExecutionRecord): void {
  if (!order || Object.keys(order).sort().join(",") !== "action,expiresAfter,nonce,signature" ||
    !isDeepStrictEqual(order.action, record.action) || order.nonce !== record.nonce || order.expiresAfter !== record.expiresAfter) {
    throw new LiveBoundaryError("signed_order_payload_mismatch");
  }
}

/** The transport may throw this only before initiating an exchange request. */
export class LiveSubmissionBlockedError extends LiveBoundaryError {}
