import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CancelByCloidRequest } from '@nktkas/hyperliquid/api/exchange';
import { canonicalize } from '@nktkas/hyperliquid/signing';
import {
  buildOrderAction,
  executionKey,
  intentFingerprint,
  type LiveOrderIntent,
} from './live-order.js';
import type { LiveExecutionRecord } from './live-execution.js';
import {
  address,
  LiveBoundaryError,
  type ExchangeApprovalEvidence,
} from './wallet-authorization.js';

export interface TrackedCancellationAction {
  type: 'cancelByCloid';
  cancels: [{ asset: number; cloid: `0x${string}` }];
}
/** Separate current cancellation authority: an old order grant and copy:reduce
 * never imply permission to cancel protective/manual orders. */
export interface CancellationAuthorization {
  id: string;
  version: number;
  userId: number;
  strategyId: number;
  walletId: string;
  privyOwnerId: string;
  signerAddress: `0x${string}`;
  accountAddress: `0x${string}`;
  network: 'testnet';
  scope: 'copy:cancel';
  validFrom: number;
  expiresAt: number;
  revokedAt: null;
}
export interface PreparedTrackedCancellation {
  operationId: string;
  stopId: string;
  claimToken: string;
  /** Persisted by the parent before this one-attempt port is invoked. */
  state: 'claimed';
  createdAt: number;
  target: { record: LiveExecutionRecord; intent: LiveOrderIntent };
  authorization: CancellationAuthorization;
  ownerConsentDigest: string;
  nonce: number;
  expiresAfter: number;
  action: TrackedCancellationAction;
  fingerprint: string;
}
export interface CancellationPermit {
  phase: 'sign' | 'submit';
  operationId: string;
  operationFingerprint: string;
  claimToken: string;
  targetExecutionKey: string;
  targetFingerprint: string;
  authorization: CancellationAuthorization;
  ownerConsentDigest: string;
  ownerEnabled: true;
  checkedAt: number;
  exchangeApproval: ExchangeApprovalEvidence;
  /** Synchronous original-session/epoch and owner/master/consent fence. */
  assertFresh(): void;
}
/** The parent must independently load the durable claim + original target and
 * signed wind-down consent, stable current owner/master, current setup/grant/
 * Privy policy and uncached actual exchange approval. Never trust HTTP targets.
 * No transaction may span the remote signing/POST work. */
export interface TrackedCancellationAuthority {
  authorize(
    operation: Readonly<PreparedTrackedCancellation>,
    phase: 'sign' | 'submit',
  ): Promise<CancellationPermit>;
}
export interface CancellationAttemptEvidence {
  state: 'accepted' | 'unknown';
  operationId: string;
  operationFingerprint: string;
  targetExecutionKey: string;
  actionHash: `0x${string}`;
  nonce: number;
  expiresAfter: number;
  signingRequested: boolean;
  exchangeRequestBegan: boolean;
  observedAt: number;
  issue: string | null;
  response?: unknown;
}
const fail = (code: string): never => {
  throw new LiveBoundaryError(code);
};
export function synchronousCancellationGuard(guard: () => void): void {
  if (typeof guard !== 'function') fail('cancel_guard_missing');
  const result: unknown = guard();
  if (result !== undefined) {
    if (
      result &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result
    )
      void Promise.resolve(result).catch(() => undefined);
    fail('cancel_guard_must_be_synchronous');
  }
}
export function trackedCancellationAction(
  target: PreparedTrackedCancellation['target'],
): TrackedCancellationAction {
  const { intent, record } = target;
  if (
    intent.network !== 'testnet' ||
    record.authorization.network !== 'testnet'
  )
    fail('cancel_network_mismatch');
  const original = buildOrderAction(intent);
  if (
    record.key !== executionKey(intent) ||
    record.fingerprint !== intentFingerprint(intent, original) ||
    !isDeepStrictEqual(record.action, original) ||
    record.authorization.userId !== intent.userId ||
    record.authorization.strategyId !== intent.strategyId ||
    record.authorization.id !== intent.authorizationId ||
    record.authorization.walletId !== intent.walletId ||
    address(record.authorization.accountAddress) !==
      address(intent.accountAddress)
  )
    fail('cancel_target_identity_mismatch');
  return canonicalize(CancelByCloidRequest.entries.action, {
    type: 'cancelByCloid',
    cancels: [{ asset: intent.asset, cloid: intent.cloid }],
  }) as TrackedCancellationAction;
}
function cancellationIdentity(operation: PreparedTrackedCancellation): unknown {
  const a = operation.authorization;
  return {
    operationId: operation.operationId,
    stopId: operation.stopId,
    claimToken: operation.claimToken,
    createdAt: operation.createdAt,
    targetExecutionKey: operation.target.record.key,
    targetFingerprint: operation.target.record.fingerprint,
    authorization: {
      id: a.id,
      version: a.version,
      userId: a.userId,
      strategyId: a.strategyId,
      walletId: a.walletId,
      privyOwnerId: a.privyOwnerId,
      signerAddress: address(a.signerAddress),
      accountAddress: address(a.accountAddress),
      network: a.network,
      scope: a.scope,
      validFrom: a.validFrom,
      expiresAt: a.expiresAt,
      revokedAt: a.revokedAt,
    },
    ownerConsentDigest: operation.ownerConsentDigest,
    nonce: operation.nonce,
    expiresAfter: operation.expiresAfter,
    action: trackedCancellationAction(operation.target),
  };
}
export function trackedCancellationFingerprint(
  operation: PreparedTrackedCancellation,
): string {
  return createHash('sha256')
    .update(JSON.stringify(cancellationIdentity(operation)))
    .digest('hex');
}
export function assertTrackedCancellation(
  operation: PreparedTrackedCancellation,
  now: number,
): void {
  const auth = operation.authorization;
  const id = (v: string) =>
    typeof v === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(v);
  if (
    !id(operation.operationId) ||
    !id(operation.stopId) ||
    !id(operation.claimToken) ||
    operation.state !== 'claimed' ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(operation.createdAt) ||
    operation.createdAt <= 0 ||
    operation.createdAt > now ||
    !Number.isSafeInteger(operation.nonce) ||
    operation.nonce < operation.createdAt ||
    operation.nonce > operation.createdAt + 30_000 ||
    !Number.isSafeInteger(operation.expiresAfter) ||
    operation.expiresAfter <= now ||
    operation.expiresAfter <= operation.nonce ||
    operation.expiresAfter > auth.expiresAt ||
    operation.expiresAfter > operation.createdAt + 60_000
  )
    fail('cancel_operation_invalid_or_expired');
  if (
    Object.keys(operation).sort().join(',') !==
    'action,authorization,claimToken,createdAt,expiresAfter,fingerprint,nonce,operationId,ownerConsentDigest,state,stopId,target'
  )
    fail('cancel_operation_outside_scope');
  if (
    !Number.isSafeInteger(auth.userId) ||
    auth.userId < 1 ||
    !Number.isSafeInteger(auth.strategyId) ||
    auth.strategyId < 1 ||
    /^0x0{40}$/.test(address(auth.accountAddress)) ||
    auth.network !== 'testnet' ||
    auth.scope !== 'copy:cancel' ||
    auth.revokedAt !== null ||
    !id(auth.id) ||
    !id(auth.walletId) ||
    !id(auth.privyOwnerId) ||
    !Number.isSafeInteger(auth.version) ||
    auth.version < 1 ||
    !Number.isSafeInteger(auth.validFrom) ||
    auth.validFrom > now ||
    !Number.isSafeInteger(auth.expiresAt) ||
    auth.expiresAt <= now ||
    auth.userId !== operation.target.intent.userId ||
    auth.strategyId !== operation.target.intent.strategyId ||
    address(auth.accountAddress) !==
      address(operation.target.intent.accountAddress) ||
    /^0x0{40}$/.test(address(auth.signerAddress))
  )
    fail('cancel_authorization_outside_scope');
  if (
    !/^[0-9a-f]{64}$/.test(operation.ownerConsentDigest) ||
    !isDeepStrictEqual(
      operation.action,
      trackedCancellationAction(operation.target),
    ) ||
    operation.fingerprint !== trackedCancellationFingerprint(operation)
  )
    fail('cancel_operation_fingerprint_mismatch');
}
export function assertCancellationPermit(
  permit: CancellationPermit,
  operation: PreparedTrackedCancellation,
  phase: 'sign' | 'submit',
  now: number,
): void {
  assertTrackedCancellation(operation, now);
  synchronousCancellationGuard(() => permit.assertFresh());
  const approval = permit.exchangeApproval,
    auth = operation.authorization;
  const fresh = (at: number) =>
    Number.isSafeInteger(at) && at <= now && now - at <= 5000;
  if (
    permit.phase !== phase ||
    permit.operationId !== operation.operationId ||
    permit.operationFingerprint !== operation.fingerprint ||
    permit.claimToken !== operation.claimToken ||
    permit.targetExecutionKey !== operation.target.record.key ||
    permit.targetFingerprint !== operation.target.record.fingerprint ||
    permit.ownerConsentDigest !== operation.ownerConsentDigest ||
    permit.ownerEnabled !== true ||
    !fresh(permit.checkedAt) ||
    !isDeepStrictEqual(permit.authorization, auth) ||
    !approval ||
    approval.network !== 'testnet' ||
    address(approval.accountAddress) !== address(auth.accountAddress) ||
    address(approval.signerAddress) !== address(auth.signerAddress) ||
    !fresh(approval.checkedAt) ||
    (approval.expiresAt !== null &&
      (!Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= now))
  )
    fail('cancel_current_authority_invalid');
}
