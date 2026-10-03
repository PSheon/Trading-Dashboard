import type { LiveExecutionRecord, SignedLiveOrder } from "./live-execution.js";
import type { LiveOrderIntent } from "./live-order.js";
import { isDeepStrictEqual } from "node:util";
import { LiveBoundaryError } from "./wallet-authorization.js";

export interface LiveExecutionLease {
  /** Check the original lock session, never acquire a replacement lock. */
  assertHeld(): Promise<void>;
}

export interface LiveExecutionGate {
  /** Authoritative, uncached final check of current strategy/owner/platform controls,
   * risk policy, reservation ownership, funded collateral, quotes and market identity.
   * Reject unavailable dependencies as well as denied risk. No permissive default.
   * Integration must use exact record.action/nonce, without resizing the order. */
  assertReady(input: { phase: "sign" | "submit"; intent: LiveOrderIntent; record: LiveExecutionRecord }): Promise<void>;
}

export async function assertLiveExecutionReady(gate: LiveExecutionGate, lease: LiveExecutionLease,
  phase: "sign" | "submit", intent: LiveOrderIntent, record: LiveExecutionRecord): Promise<void> {
  if (!gate || typeof gate.assertReady !== "function") throw new LiveBoundaryError("live_execution_gate_missing");
  if (!lease || typeof lease.assertHeld !== "function") throw new LiveBoundaryError("execution_lease_missing");
  await gate.assertReady({ phase, intent: structuredClone(intent), record: structuredClone(record) });
  await lease.assertHeld();
}

export function assertSignedOrderMatches(order: SignedLiveOrder, record: LiveExecutionRecord): void {
  if (!order || Object.keys(order).sort().join(",") !== "action,expiresAfter,nonce,signature" ||
    !isDeepStrictEqual(order.action, record.action) || order.nonce !== record.nonce || order.expiresAfter !== record.expiresAfter) {
    throw new LiveBoundaryError("signed_order_payload_mismatch");
  }
}

/** The transport may throw this only before initiating an exchange request. */
export class LiveSubmissionBlockedError extends LiveBoundaryError {}
