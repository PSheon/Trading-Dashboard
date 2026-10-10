import type { LiveExecutionGate, LiveExecutionPermit } from './live-execution-gate.js';
import { assessLiveAccountRisk, type LiveAccountRiskInput } from './live-account-risk.js';
import { LiveBoundaryError, assertWalletAuthorization } from './wallet-authorization.js';
import { buildOrderAction, executionKey, intentFingerprint } from './live-order.js';
import { isDeepStrictEqual } from 'node:util';

export interface LiveAccountRiskProofSource {
  /** The per-read callback belongs to the original account/user serialization
   * scope, held through the financial boundary. It must never reacquire a
   * replacement scope or look up the latest owner by execution key. */
  read(input: Parameters<LiveExecutionGate['assertReady']>[0]): Promise<{
    proof: LiveAccountRiskInput;
    assertHeld(): void;
  }>;
}
export class AccountRiskExecutionGate implements LiveExecutionGate {
  constructor(private readonly source: LiveAccountRiskProofSource, private readonly now = Date.now) {}
  async assertReady(supplied: Parameters<LiveExecutionGate['assertReady']>[0]): Promise<LiveExecutionPermit> {
    try {
      const input = structuredClone(supplied);
      if (!this.source || typeof this.source.read !== 'function')
        throw new LiveBoundaryError('live_risk_source_unavailable');
      const evidence = await this.source.read(structuredClone(input));
      if (!evidence || typeof evidence.assertHeld !== 'function') throw new LiveBoundaryError('live_risk_source_unavailable');
      const held = evidence.assertHeld.bind(evidence);
      const proof = structuredClone(evidence.proof);
      const { phase, intent, record } = input;
      if (!['sign', 'submit'].includes(phase) || (phase === 'sign' ? record.state !== 'prepared' : record.state !== 'submitting') ||
          record.key !== executionKey(intent) || record.fingerprint !== intentFingerprint(intent, record.action) ||
          !isDeepStrictEqual(record.action, buildOrderAction(intent)) ||
          executionKey(proof.intent) !== record.key || intentFingerprint(proof.intent, proof.action) !== record.fingerprint ||
          !isDeepStrictEqual(proof.action, record.action) ||
          proof.identity.authorizationVersion !== record.authorization.version ||
          proof.identity.authorizationId !== record.authorization.id ||
          proof.identity.userId !== record.authorization.userId || proof.identity.strategyId !== record.authorization.strategyId ||
          proof.identity.walletId !== record.authorization.walletId || proof.identity.network !== record.authorization.network ||
          proof.identity.accountAddress !== record.authorization.accountAddress)
        throw new LiveBoundaryError('live_risk_record_mismatch');
      const snapshot = proof.accountSource.snapshot;
      const oldest = Math.min(proof.localSource.checkedAt, proof.accountSource.checkedAt,
        snapshot.observedAt, snapshot.completedAt, snapshot.coverage.earliestProviderTime,
        ...snapshot.dexes.map(d => d.providerTime), proof.market.observedAt, proof.intent.market?.observedAt ?? NaN,
        proof.quote.observedAt, proof.quote.market.observedAt, proof.fees.observedAt,
        ...proof.leverageProofs.map(p => p.observedAt), proof.reservations.checkedAt, proof.userExposureProof.checkedAt);
      const heldUntil = Math.min(proof.reservations.own.expiresAt,
        ...proof.reservations.others.filter(r => r.state === 'held').map(r => r.expiresAt));
      const signalUntil = !intent.reduceOnly && proof.signal?.kind === 'fill'
        ? proof.signal.at + proof.policy.limits.maxSignalAgeSeconds * 1000 : Infinity;
      let validatedAt: number | undefined;
      const assertFresh = () => {
        try { if (held() !== undefined) throw new Error(); }
        catch (error) {
          // The original callback also checks evidence age. Preserve its
          // reviewed expiry codes so an expired proof is not reported as a
          // vanished SQL session. Every case still refuses the boundary.
          if (error instanceof LiveBoundaryError &&
              ['live_risk_stale', 'live_risk_serialization_stale'].includes(error.code)) throw error;
          throw new LiveBoundaryError('live_risk_serialization_lost');
        }
        const now = this.now();
        if (!Number.isSafeInteger(now) || (validatedAt !== undefined && now < validatedAt))
          throw new LiveBoundaryError('live_risk_stale');
        if (!Number.isSafeInteger(record.expiresAfter) || record.expiresAfter <= now)
          throw new LiveBoundaryError('signing_order_expired');
        assertWalletAuthorization(record.authorization, intent, now);
        // This closure owns a detached proof; no caller can mutate it. Validate
        // its full coverage, economics and bindings once per source read, then
        // recheck every time-dependent condition and the original held scope
        // at each boundary. A new assertReady still reloads current authority.
        if (validatedAt === undefined) {
          const result = assessLiveAccountRisk({ ...proof, now });
          if (!result.ok) throw new LiveBoundaryError(result.reason);
          if (result.key !== record.key || result.fingerprint !== record.fingerprint)
            throw new LiveBoundaryError('live_risk_record_mismatch');
        }
        // Assessment can itself consume the last millisecond of a valid proof.
        // This final constant-time check uses the completion clock, not the
        // earlier time supplied to the pure assessor.
        const completed = this.now();
        if (!Number.isSafeInteger(completed) || completed < now || !Number.isSafeInteger(oldest) ||
            completed < oldest || completed - oldest > 5000) throw new LiveBoundaryError('live_risk_stale');
        if (record.expiresAfter <= completed) throw new LiveBoundaryError('signing_order_expired');
        if (record.authorization.expiresAt <= completed) throw new LiveBoundaryError('wallet_authorization_expired');
        if (heldUntil <= completed) throw new LiveBoundaryError('live_risk_reservation');
        if (signalUntil < completed) throw new LiveBoundaryError('stale_signal');
        validatedAt = completed;
      };
      assertFresh();
      return Object.freeze({ phase, key: record.key, fingerprint: record.fingerprint, assertFresh });
    } catch (error) {
      if (error instanceof LiveBoundaryError) throw error;
      throw new LiveBoundaryError('live_risk_source_unavailable');
    }
  }
}
