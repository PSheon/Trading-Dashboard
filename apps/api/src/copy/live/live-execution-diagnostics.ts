import { HyperliquidBudgetWait } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { LiveBoundaryError, type LiveNetwork } from './wallet-authorization.js';

export type LiveDiagnosticStage = 'transport_local_budget' | 'transport_shared_quota' | 'transport_final_check' |
  'transport_dispatch' | 'executor_final_check' | 'executor_submit';
export interface LiveExecutionDiagnostic {
  readonly network: LiveNetwork;
  readonly stage: LiveDiagnosticStage;
  readonly elapsedMs: number;
  readonly errorCode: string;
  readonly budgetReason?: 'local_budget' | 'shared_capacity';
  readonly retryMs?: number;
}
export type LiveExecutionDiagnosticHook = (event: Readonly<LiveExecutionDiagnostic>) => void;
// Exact reviewed codes only. Even a typed boundary error can carry an
// unreviewed adapter string; neither its message nor arbitrary code is logged.
const codes = new Set(['wallet_authorization_missing', 'wallet_authorization_expired', 'wallet_authorization_revoked',
  'wallet_authorization_changed', 'wallet_owner_or_strategy_mismatch', 'wallet_network_mismatch', 'wallet_account_mismatch',
  'wallet_scope_denied', 'exchange_approval_missing', 'exchange_approval_evidence_invalid', 'exchange_approval_verifier_missing',
  'transport_network_mismatch', 'persisted_order_payload_mismatch', 'signed_order_payload_mismatch', 'signed_order_expired',
  'signing_order_expired', 'live_execution_gate_missing', 'live_execution_permit_invalid', 'execution_lease_missing',
  'live_risk_stale', 'market_evidence_expired', 'privy_wallet_identity_stale', 'privy_wallet_identity_mismatch',
  'live_market_proof_invalid', 'builder_approval_proof_invalid', 'live_boundary_evidence_expired', 'live_market_identity_mismatch',
  'live_market_resolver_missing', 'live_market_identity_missing', 'live_read_deadline_exceeded', 'market_evidence_unavailable',
  'builder_fee_not_approved', 'live_risk_serialization_lost', 'live_risk_serialization_stale',
  'live_risk_source_unavailable', 'live_risk_record_mismatch', 'live_risk_reservation', 'live_risk_platform_disabled', 'stale_signal',
  'live_budget_over_capacity', 'hyperliquid_quota_exhausted', 'hyperliquid_quota_expired', 'hyperliquid_quota_invalid',
  'hyperliquid_quota_clock_skew', 'exchange_submission_ambiguous', 'exchange_http_failure', 'final_execution_check_failed']);

/** Observation must never change execution or leak authorization/order data. */
export function observeLiveExecutionFailure(hook: LiveExecutionDiagnosticHook | undefined, network: LiveNetwork,
  stage: LiveDiagnosticStage, startedAt: number, now: () => number, error: unknown): void {
  if (!hook) return;
  try {
    const elapsed = now() - startedAt;
    const event: LiveExecutionDiagnostic = { network, stage, elapsedMs: Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : 0,
      errorCode: error instanceof HyperliquidBudgetWait ? 'hyperliquid_busy' :
        error instanceof LiveBoundaryError && codes.has(error.code) ? error.code : 'unclassified_error',
      ...(error instanceof HyperliquidBudgetWait ? {
        ...(error.reason === 'local_budget' || error.reason === 'shared_capacity' ? { budgetReason: error.reason } : {}),
        ...(Number.isFinite(error.retryMs) && error.retryMs >= 0 && error.retryMs <= Number.MAX_SAFE_INTEGER ? { retryMs: Math.ceil(error.retryMs) } : {}),
      } : {}) };
    const result: unknown = hook(Object.freeze(event));
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch { /* diagnostics cannot veto, retry or reclassify a financial action */ }
}
