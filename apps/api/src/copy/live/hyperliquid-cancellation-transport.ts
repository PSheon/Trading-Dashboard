import { isDeepStrictEqual } from 'node:util';
import { createL1ActionHash } from '@nktkas/hyperliquid/signing';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { boundedLiveRead } from './live-market-resolver.js';
import { LiveBoundaryError } from './wallet-authorization.js';
import { PrivyTrackedCancellationSigner } from './privy-cancellation-signer.js';
import {
  assertCancellationPermit,
  assertTrackedCancellation,
  synchronousCancellationGuard,
  type CancellationAttemptEvidence,
  type PreparedTrackedCancellation,
} from './live-tracked-cancellation.js';

// Evidence journals accept reviewed codes only; provider payloads/errors are
// never a source of diagnostic strings or authorization/signature material.
const attemptIssueCodes = new Set([
  'cancel_response_invalid',
  'cancel_response_too_large',
  'cancel_response_deadline',
  'cancel_operation_invalid_or_expired',
  'cancel_operation_outside_scope',
  'cancel_network_mismatch',
  'cancel_target_identity_mismatch',
  'cancel_authorization_outside_scope',
  'cancel_operation_fingerprint_mismatch',
  'cancel_guard_missing',
  'cancel_guard_must_be_synchronous',
  'cancel_original_context_lost',
  'cancel_current_authority_invalid',
  'cancel_privy_wallet_identity_mismatch',
  'cancel_privy_wallet_identity_stale',
  'cancel_privy_signature_invalid',
  'cancel_privy_signature_scope_mismatch',
  'cancel_signer_payload_outside_scope',
  'cancel_signing_ambiguous',
  'privy_order_wallet_unavailable',
  'privy_order_signing_unavailable',
  'live_read_deadline_exceeded',
]);

/** Bound both bytes and the whole response deadline, including a stalled body. */
async function readCancellationJson(
  response: Response,
  signal: AbortSignal,
  deadline: number,
  now: () => number,
): Promise<unknown> {
  if (!response.body) throw new LiveBoundaryError('cancel_response_invalid');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  try {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 64 * 1024)
      throw new LiveBoundaryError('cancel_response_too_large');
    for (;;) {
      if (signal.aborted || now() >= deadline)
        throw new LiveBoundaryError('cancel_response_deadline');
      const { done, value } = await boundedLiveRead(() => 
        reader.read(),
        Math.max(1, deadline - now()),
      );
      // Abort cancellation can resolve a stalled read as done:true. A complete
      // buffered JSON document still cannot turn that expired read into ACK.
      if (signal.aborted || now() >= deadline)
        throw new LiveBoundaryError('cancel_response_deadline');
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024)
        throw new LiveBoundaryError('cancel_response_too_large');
      chunks.push(value);
    }
    if (signal.aborted || now() >= deadline)
      throw new LiveBoundaryError('cancel_response_deadline');
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', abort);
    await boundedLiveRead(() => reader.cancel(), 100).catch(() => undefined);
    reader.releaseLock();
  }
}

/** Unregistered testnet cancellation port. The parent must atomically persist
 * and exclusively claim an operation BEFORE invoking this port, use the shared
 * signer nonce allocator, and retain liability on every result. No ACK, error,
 * not-found or local expiry can reconcile the original target. */
export class HyperliquidTrackedCancellationTransport {
  readonly #attempted = new Set<string>();
  constructor(
    private readonly signer: PrivyTrackedCancellationSigner,
    private readonly global: HyperliquidGlobalTransport,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {
    if (!(global instanceof HyperliquidGlobalTransport))
      throw new LiveBoundaryError('cancel_global_quota_missing');
  }
  async attempt(
    supplied: PreparedTrackedCancellation,
    callerGuard: () => void,
  ): Promise<CancellationAttemptEvidence> {
    const operation = structuredClone(supplied);
    assertTrackedCancellation(operation, this.now());
    synchronousCancellationGuard(callerGuard);
    if (!this.global.isOriginal())
      throw new LiveBoundaryError('cancel_original_context_missing');
    const original = this.global.contextIdentity();
    const scopedGuard = () => {
      synchronousCancellationGuard(callerGuard);
      if (
        !this.global.isOriginal() ||
        this.global.contextIdentity() !== original
      )
        throw new LiveBoundaryError('cancel_original_context_lost');
      assertTrackedCancellation(operation, this.now());
    };
    if (this.#attempted.has(operation.operationId))
      throw new LiveBoundaryError('cancel_attempt_already_invoked');
    this.#attempted.add(operation.operationId);
    const actionHash = createL1ActionHash({
      action: { ...operation.action },
      nonce: operation.nonce,
      expiresAfter: operation.expiresAfter,
    });
    let signingRequested = false,
      exchangeRequestBegan = false;
    const evidence = (
      state: 'accepted' | 'unknown',
      issue: string | null,
      response?: unknown,
    ): CancellationAttemptEvidence => ({
      state,
      operationId: operation.operationId,
      operationFingerprint: operation.fingerprint,
      targetExecutionKey: operation.target.record.key,
      actionHash,
      nonce: operation.nonce,
      expiresAfter: operation.expiresAfter,
      signingRequested,
      exchangeRequestBegan,
      observedAt: this.now(),
      issue,
      ...(response === undefined ? {} : { response }),
    });
    try {
      const signed = await this.signer.sign(operation, scopedGuard, () => {
        signingRequested = true;
      });
      scopedGuard();
      // Quota is durably prepaid before the final current permission read.
      const quota = await boundedLiveRead(() => 
        this.global
          .currentQuota()
          .acquireRest(1, Math.min(this.now() + 5000, operation.expiresAfter)),
        5000,
      );
      const permit = await this.signer.current(operation, 'submit');
      const timeout = Math.max(
        1,
        Math.min(10_000, operation.expiresAfter - this.now()),
      );
      const deadline = this.now() + timeout,
        signal = AbortSignal.timeout(timeout);
      const request: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
        redirect: 'error',
        signal,
      };
      const pending = quota.dispatch(() => {
        // No awaits remain after this guard, including SDK/serialization/quota waits.
        scopedGuard();
        quota.assertFresh();
        assertCancellationPermit(permit, operation, 'submit', this.now());
        exchangeRequestBegan = true;
        return this.fetcher(
          'https://api.hyperliquid-testnet.xyz/exchange',
          request,
        );
      });
      const response = await boundedLiveRead(() => pending, timeout);
      if (!response.ok) {
        await boundedLiveRead(() => 
          response.body?.cancel() ?? Promise.resolve(),
          100,
        ).catch(() => undefined);
        return evidence('unknown', 'cancel_exchange_http_ambiguous');
      }
      const body = await readCancellationJson(
        response,
        signal,
        deadline,
        this.now,
      );
      // Exact success is ACK only. Per-order error, already-filled/not-found,
      // top-level errors, future response shapes and EOF all retain uncertainty.
      if (
        isDeepStrictEqual(body, {
          status: 'ok',
          response: { type: 'cancel', data: { statuses: ['success'] } },
        })
      )
        return evidence('accepted', null, body);
      return evidence('unknown', 'cancel_exchange_response_ambiguous');
    } catch (error) {
      return evidence(
        'unknown',
        error instanceof LiveBoundaryError && attemptIssueCodes.has(error.code)
          ? error.code
          : 'cancel_attempt_ambiguous',
      );
    }
  }
}
