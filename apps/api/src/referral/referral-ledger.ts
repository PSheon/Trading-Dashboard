import { createHash } from 'node:crypto';

/** Pure correspondence and arithmetic only. Collection/payout envelopes MUST
 * come from trusted adapters and be bound to immutable DAL receipts. A digest
 * supplied by a caller is not proof of collection or permission to pay.
 * No function here ingests platform snapshots, books credits or calls a provider.
 * Persistence must lock the owner, enforce source/key uniqueness and atomically
 * write ledger movements, events and attempts. Policy is disabled until those
 * integrations and a funded treasury are configured. No business defaults. */
export interface ReferralPolicy {
  version: string; enabled: boolean; rewardBps: number; minClaimUnits: string;
  network: string; token: string; treasuryAddress: string;
  effectiveFrom: number; effectiveUntil: number | null;
}
export interface FeeInput {
  policy: ReferralPolicy;
  attribution: { id: string; ownerId: string; referredUserId: string; boundAt: number };
  charged: { receiptId: string; proofDigest: string; mode: string; network: string; token: string; userId: string; builderAddress: string; feeUnits: string; filledAt: number };
  collected: { receiptId: string; chargedProofDigest: string; proofDigest: string; network: string; token: string; userId: string; treasuryAddress: string; collectedFeeUnits: string; collectedAt: number };
}
const MAX = (1n << 128n) - 1n;
function requireCondition(ok: unknown): asserts ok { if (!ok) throw new Error('invalid_referral_domain_input'); }
function id(value: string): string { requireCondition(typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value)); return value; }
function units(value: string): bigint {
  requireCondition(typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value));
  const n = BigInt(value); requireCondition(n <= MAX); return n;
}
function address(value: string): string { requireCondition(typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) && value !== `0x${'0'.repeat(40)}`); return value; }
function digest(value: string): string { requireCondition(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); return value; }
function time(value: number): void { requireCondition(Number.isSafeInteger(value) && value >= 0); }
function mainnet(value: { network: string; token: string }): void { requireCondition(value.network === 'mainnet' && value.token === 'USDC'); }
function validatePolicy(p: ReferralPolicy): void {
  id(p.version); mainnet(p); address(p.treasuryAddress); units(p.minClaimUnits); time(p.effectiveFrom);
  requireCondition(typeof p.enabled === 'boolean' && Number.isInteger(p.rewardBps) && p.rewardBps >= 0 && p.rewardBps <= 10000);
  if (p.effectiveUntil !== null) { time(p.effectiveUntil); requireCondition(p.effectiveUntil > p.effectiveFrom); }
}

export function calculateReferralEarning(input: FeeInput) {
  const { policy: p, attribution: a, charged: c, collected: r } = input;
  validatePolicy(p); requireCondition(p.enabled); mainnet(c); mainnet(r);
  id(a.id); id(a.ownerId); id(a.referredUserId); id(c.receiptId); id(r.receiptId);
  digest(c.proofDigest); digest(r.chargedProofDigest); digest(r.proofDigest);
  time(a.boundAt); time(c.filledAt); time(r.collectedAt);
  requireCondition(c.mode === 'live' && a.ownerId !== a.referredUserId && c.userId === a.referredUserId && r.userId === c.userId);
  requireCondition(address(c.builderAddress) === address(r.treasuryAddress) && r.treasuryAddress === p.treasuryAddress);
  requireCondition(c.receiptId === r.receiptId && r.chargedProofDigest === c.proofDigest);
  requireCondition(a.boundAt <= c.filledAt && c.filledAt >= p.effectiveFrom && (p.effectiveUntil === null || c.filledAt < p.effectiveUntil) && r.collectedAt >= c.filledAt);
  const charged = units(c.feeUnits), collected = units(r.collectedFeeUnits);
  requireCondition(collected <= charged);
  const numerator = collected * BigInt(p.rewardBps);
  return Object.freeze({ ownerId: a.ownerId, referredUserId: a.referredUserId, attributionId: a.id,
    receiptId: c.receiptId, chargedProofDigest: c.proofDigest, collectionProofDigest: r.proofDigest,
    policyVersion: p.version, rewardBps: p.rewardBps, treasuryAddress: p.treasuryAddress,
    chargedFeeUnits: charged.toString(), filledAt: c.filledAt, collectedAt: r.collectedAt,
    network: 'mainnet' as const, token: 'USDC' as const,
    collectedFeeUnits: collected.toString(), rewardUnits: (numerator / 10000n).toString(),
    remainderNumerator: (numerator % 10000n).toString(), remainderDenominator: '10000' as const });
}

export interface ClaimRequest { id: string; ownerId: string; key: string; destination: string; amountUnits: string }
export type ClaimStatus = 'requested' | 'approved' | 'sending' | 'unknown' | 'paid' | 'rejected' | 'failed';
export interface PayoutEvidence {
  claimId: string; ownerId: string; attemptId: string; network: string; token: string;
  destination: string; amountUnits: string; proofDigest: string; reference: string;
}
export interface ReferralClaim extends ClaimRequest {
  network: string; token: string; requestHash: string; policyVersion: string;
  status: ClaimStatus; attemptId: string | null; settlementHash: string | null;
}
/** Complete owner state, not a paginated claims view. Historical claim totals
 * are needed to verify reservations and paid balances. DAL is authoritative. */
export interface ReferralState {
  ownerId: string; network: string; token: string;
  balances: { earned: string; available: string; pending: string; claimed: string };
  claims: ReferralClaim[];
}
export type ClaimAction = { type: 'approve' | 'reject' | 'uncertain' }
  | { type: 'submit'; attemptId: string }
  | { type: 'paid' | 'not_executed'; proof: PayoutEvidence };

export function claimIntentHash(r: ClaimRequest & { network: string; token: string }): string {
  mainnet(r); id(r.id); id(r.ownerId); id(r.key); address(r.destination); units(r.amountUnits);
  return hash(['referral-claim-v1', r.id, r.ownerId, r.key, r.network, r.token, r.destination, r.amountUnits]);
}
function hash(values: string[]): string { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }
function open(c: ReferralClaim): boolean { return ['requested', 'approved', 'sending', 'unknown'].includes(c.status); }
function validateState(s: ReferralState): void {
  id(s.ownerId); mainnet(s);
  const b = s.balances;
  requireCondition(units(b.earned) === units(b.available) + units(b.pending) + units(b.claimed));
  requireCondition(Array.isArray(s.claims));
  const keys = new Set<string>(), ids = new Set<string>(), attempts = new Set<string>();
  let pending = 0n, paid = 0n, active = 0;
  for (const c of s.claims) {
    requireCondition(c.ownerId === s.ownerId && c.network === s.network && c.token === s.token && units(c.amountUnits) > 0n);
    requireCondition(c.requestHash === claimIntentHash(c)); id(c.policyVersion);
    requireCondition(!keys.has(c.key) && !ids.has(c.id)); keys.add(c.key); ids.add(c.id);
    requireCondition(['requested', 'approved', 'sending', 'unknown', 'paid', 'rejected', 'failed'].includes(c.status));
    const attempted = ['sending', 'unknown', 'paid', 'failed'].includes(c.status);
    requireCondition(attempted ? c.attemptId !== null : c.attemptId === null);
    if (c.attemptId !== null) { id(c.attemptId); requireCondition(!attempts.has(c.attemptId)); attempts.add(c.attemptId); }
    if (c.status === 'paid' || c.status === 'failed') digest(c.settlementHash!);
    else requireCondition(c.settlementHash === null);
    if (open(c)) { pending += units(c.amountUnits); active++; }
    if (c.status === 'paid') paid += units(c.amountUnits);
  }
  requireCondition(active <= 1 && pending === units(b.pending) && paid === units(b.claimed));
}

/** Caller chooses a stable claim ID before first request. Persist/replay this
 * exact identity, including destination, even if the currently linked wallet
 * changes. No capability/balance revalidation may hide an existing result. */
export function requestReferralClaim(state: ReferralState, request: ClaimRequest, policy: ReferralPolicy): ReferralState {
  validateState(state); requireCondition(request.ownerId === state.ownerId);
  const requestHash = claimIntentHash({ ...request, network: state.network, token: state.token });
  const existing = state.claims.find(c => c.key === request.key);
  if (existing) { requireCondition(existing.requestHash === requestHash); return structuredClone(state); }
  validatePolicy(policy); requireCondition(policy.enabled);
  const amount = units(request.amountUnits);
  requireCondition(amount > 0n && amount >= units(policy.minClaimUnits) && amount <= units(state.balances.available));
  requireCondition(!state.claims.some(c => open(c) || c.id === request.id));
  const next = structuredClone(state);
  next.balances.available = (units(next.balances.available) - amount).toString();
  next.balances.pending = (units(next.balances.pending) + amount).toString();
  next.claims.push({ ...request, network: state.network, token: state.token, requestHash, policyVersion: policy.version, status: 'requested', attemptId: null, settlementHash: null });
  validateState(next); return next;
}

/** Returned submit state is an intent to persist, NEVER permission to resend.
 * The adapter must atomically acquire first-attempt dispatch outside this pure
 * model. Recovery of sending/unknown must query provider status, not submit. */
export function transitionReferralClaim(state: ReferralState, ownerId: string, claimId: string, action: ClaimAction): ReferralState {
  validateState(state); requireCondition(ownerId === state.ownerId);
  const next = structuredClone(state), c = next.claims.find(row => row.id === claimId);
  requireCondition(c);
  if (action.type === 'approve') {
    requireCondition(c.status === 'requested' || c.status === 'approved'); c.status = 'approved';
  } else if (action.type === 'submit') {
    requireCondition(c.status === 'approved'); c.attemptId = id(action.attemptId); c.status = 'sending';
  } else if (action.type === 'uncertain') {
    requireCondition(c.status === 'sending' || c.status === 'unknown'); c.status = 'unknown';
  } else if (action.type === 'reject') {
    if (c.status === 'rejected') return next;
    requireCondition(c.status === 'requested' || c.status === 'approved');
    release(next, c, false); c.status = 'rejected';
  } else {
    requireCondition(action.type === 'paid' || action.type === 'not_executed');
    const p = action.proof; digest(p.proofDigest); id(p.reference);
    requireCondition(p.claimId === c.id && p.ownerId === c.ownerId && p.attemptId === c.attemptId && p.network === c.network && p.token === c.token && p.destination === c.destination && p.amountUnits === c.amountUnits);
    const settlementHash = hash([action.type, c.requestHash, p.attemptId, p.proofDigest, p.reference]);
    const target = action.type === 'paid' ? 'paid' : 'failed';
    if (c.status === target) { requireCondition(c.settlementHash === settlementHash); return next; }
    requireCondition(c.status === 'sending' || c.status === 'unknown');
    release(next, c, target === 'paid'); c.status = target; c.settlementHash = settlementHash;
  }
  validateState(next); return next;
}
function release(s: ReferralState, c: ReferralClaim, paid: boolean): void {
  const amount = units(c.amountUnits), b = s.balances;
  b.pending = (units(b.pending) - amount).toString();
  const target = paid ? 'claimed' : 'available'; b[target] = (units(b[target]) + amount).toString();
}
