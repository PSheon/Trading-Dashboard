import { describe, expect, it } from 'vitest';
import { calculateReferralEarning, claimIntentHash, requestReferralClaim, transitionReferralClaim, type FeeInput, type ReferralState } from '../src/referral/referral-ledger.js';

const address = `0x${'a'.repeat(40)}`;
const digest = 'b'.repeat(64);
function fee(): FeeInput {
  return {
    policy: { version: 'v1', enabled: true, rewardBps: 2000, minClaimUnits: '10000000', network: 'mainnet', token: 'USDC', treasuryAddress: address, effectiveFrom: 100, effectiveUntil: 1000 },
    attribution: { id: 'a1', ownerId: 'owner', referredUserId: 'friend', boundAt: 100 },
    charged: { receiptId: 'r1', proofDigest: digest, mode: 'live', network: 'mainnet', token: 'USDC', userId: 'friend', builderAddress: address, feeUnits: '50000003', filledAt: 200 },
    collected: { receiptId: 'r1', chargedProofDigest: digest, proofDigest: 'c'.repeat(64), network: 'mainnet', token: 'USDC', userId: 'friend', treasuryAddress: address, collectedFeeUnits: '50000003', collectedAt: 300 },
  };
}
function state(): ReferralState { return { ownerId: 'owner', network: 'mainnet', token: 'USDC', balances: { earned: '10000000', available: '10000000', pending: '0', claimed: '0' }, claims: [] }; }
const request = () => ({ id: 'c1', ownerId: 'owner', key: 'k1', destination: address, amountUnits: '10000000' });
function created() { return requestReferralClaim(state(), request(), fee().policy); }
function sending() {
  const approved = transitionReferralClaim(created(), 'owner', 'c1', { type: 'approve' });
  return transitionReferralClaim(approved, 'owner', 'c1', { type: 'submit', attemptId: 'attempt1' });
}

describe('collected referral arithmetic', () => {
  it('floors exact bps, retains remainder, and never mutates evidence', () => {
    const input = fee(), original = structuredClone(input);
    expect(calculateReferralEarning(input)).toMatchObject({ rewardUnits: '10000000', remainderNumerator: '6000', collectedFeeUnits: '50000003', policyVersion: 'v1', ownerId: 'owner' });
    expect(input).toEqual(original);
  });
  it.each(['paper', 'testnet', 'non-usdc', 'self', 'retroactive', 'late-policy', 'wrong-builder', 'wrong-receipt', 'wrong-proof', 'wrong-user', 'overcollection', 'early-collection', 'overflow', 'negative', 'fractional', 'disabled'])('rejects %s evidence', reason => {
    const x = fee();
    switch (reason) {
      case 'paper': x.charged.mode = 'paper'; break;
      case 'testnet': x.charged.network = 'testnet'; break;
      case 'non-usdc': x.collected.token = 'USDT'; break;
      case 'self': x.attribution.ownerId = 'friend'; break;
      case 'retroactive': x.attribution.boundAt = 201; break;
      case 'late-policy': x.policy.effectiveFrom = 201; break;
      case 'wrong-builder': x.charged.builderAddress = `0x${'d'.repeat(40)}`; break;
      case 'wrong-receipt': x.collected.receiptId = 'r2'; break;
      case 'wrong-proof': x.collected.chargedProofDigest = 'd'.repeat(64); break;
      case 'wrong-user': x.collected.userId = 'other'; break;
      case 'overcollection': x.collected.collectedFeeUnits = '50000004'; break;
      case 'early-collection': x.collected.collectedAt = 199; break;
      case 'overflow': x.charged.feeUnits = '1'.repeat(80); break;
      case 'negative': x.charged.feeUnits = '-1'; break;
      case 'fractional': x.policy.rewardBps = 0.5; break;
      case 'disabled': x.policy.enabled = false; break;
    }
    expect(() => calculateReferralEarning(x)).toThrow();
  });
  it('uses collected rather than charged gross as reward base', () => {
    const x = fee(); x.collected.collectedFeeUnits = '100';
    expect(calculateReferralEarning(x).rewardUnits).toBe('20');
  });
  it('returns the immutable policy and receipt basis needed to audit the earning', () => {
    expect(calculateReferralEarning(fee())).toMatchObject({ rewardBps: 2000, chargedFeeUnits: '50000003', treasuryAddress: address, filledAt: 200, collectedAt: 300 });
  });
  it('preserves every atomic unit in reward plus remainder up to the bounded maximum', () => {
    for (const amount of ['0', '1', '49999', '9007199254740993', ((1n << 128n) - 1n).toString()]) {
      for (const rate of [0, 1, 1999, 10000]) {
        const x = fee(); x.charged.feeUnits = x.collected.collectedFeeUnits = amount; x.policy.rewardBps = rate;
        const result = calculateReferralEarning(x);
        expect(BigInt(result.rewardUnits) * 10000n + BigInt(result.remainderNumerator)).toBe(BigInt(amount) * BigInt(rate));
        expect(BigInt(result.rewardUnits) <= BigInt(amount)).toBe(true);
      }
    }
  });
});

describe('referral claims', () => {
  it('reserves once and replays before zero balance, changed minimum, disabled policy and open-claim checks', () => {
    const x = created();
    expect(x.balances).toEqual({ earned: '10000000', available: '0', pending: '10000000', claimed: '0' });
    expect(requestReferralClaim(x, request(), { ...fee().policy, enabled: false, minClaimUnits: '99999999' })).toEqual(x);
    expect(state().balances.available).toBe('10000000');
  });
  it('rejects foreign owner and same key changed amount or destination', () => {
    const x = created();
    for (const patch of [{ ownerId: 'foreign' }, { amountUnits: '1' }, { destination: `0x${'d'.repeat(40)}` }, { id: 'other-id' }]) {
      expect(() => requestReferralClaim(x, { ...request(), ...patch }, fee().policy)).toThrow();
    }
    expect(() => transitionReferralClaim(x, 'foreign', 'c1', { type: 'approve' })).toThrow();
  });
  it('rejects fabricated hash, inconsistent balance, duplicate claim and overflow snapshots', () => {
    const x = created();
    x.claims[0]!.requestHash = 'f'.repeat(64);
    expect(() => requestReferralClaim(x, request(), fee().policy)).toThrow();
    const y = state(); y.balances.available = '1';
    expect(() => requestReferralClaim(y, request(), fee().policy)).toThrow();
    const z = created(); z.claims.push(structuredClone(z.claims[0]!));
    expect(() => transitionReferralClaim(z, 'owner', 'c1', { type: 'approve' })).toThrow();
    const huge = state(); huge.balances.earned = huge.balances.available = '9'.repeat(100);
    expect(() => requestReferralClaim(huge, request(), fee().policy)).toThrow();
  });
  it('cannot open a second claim even with sufficient available balance', () => {
    const x = created(); x.balances.earned = '20000000'; x.balances.available = '10000000';
    expect(() => requestReferralClaim(x, { ...request(), id: 'c2', key: 'k2' }, fee().policy)).toThrow();
  });
  it('unknown never releases or resends; exact paid proof settles once', () => {
    const sent = sending();
    const unknown = transitionReferralClaim(sent, 'owner', 'c1', { type: 'uncertain' });
    expect(unknown.balances.pending).toBe('10000000');
    expect(() => transitionReferralClaim(unknown, 'owner', 'c1', { type: 'reject' })).toThrow();
    expect(() => transitionReferralClaim(unknown, 'owner', 'c1', { type: 'submit', attemptId: 'attempt2' })).toThrow();
    const proof = { claimId: 'c1', ownerId: 'owner', attemptId: 'attempt1', network: 'mainnet', token: 'USDC', destination: address, amountUnits: '10000000', proofDigest: digest, reference: 'tx1' };
    for (const change of [{ ownerId: 'foreign' }, { amountUnits: '1' }, { attemptId: 'other' }, { destination: `0x${'d'.repeat(40)}` }]) {
      expect(() => transitionReferralClaim(unknown, 'owner', 'c1', { type: 'paid', proof: { ...proof, ...change } })).toThrow();
    }
    const paid = transitionReferralClaim(unknown, 'owner', 'c1', { type: 'paid', proof });
    expect(paid.balances).toEqual({ earned: '10000000', available: '0', pending: '0', claimed: '10000000' });
    expect(transitionReferralClaim(paid, 'owner', 'c1', { type: 'paid', proof })).toEqual(paid);
    expect(() => transitionReferralClaim(paid, 'owner', 'c1', { type: 'paid', proof: { ...proof, reference: 'tx2' } })).toThrow();
  });
  it('rejection before submission releases exactly once', () => {
    const rejected = transitionReferralClaim(created(), 'owner', 'c1', { type: 'reject' });
    expect(rejected.balances).toEqual(state().balances);
    expect(transitionReferralClaim(rejected, 'owner', 'c1', { type: 'reject' })).toEqual(rejected);
  });
  it('unknown releases only with exact trusted not-executed evidence', () => {
    const proof = { claimId: 'c1', ownerId: 'owner', attemptId: 'attempt1', network: 'mainnet', token: 'USDC', destination: address, amountUnits: '10000000', proofDigest: digest, reference: 'definitive-not-executed1' };
    const failed = transitionReferralClaim(sending(), 'owner', 'c1', { type: 'not_executed', proof });
    expect(failed.balances).toEqual(state().balances);
    expect(transitionReferralClaim(failed, 'owner', 'c1', { type: 'not_executed', proof })).toEqual(failed);
    expect(() => transitionReferralClaim(failed, 'owner', 'c1', { type: 'paid', proof })).toThrow();
  });
  it('binds canonical intent hash to every economic identity field', () => {
    const x = { ...request(), network: 'mainnet', token: 'USDC' };
    expect(claimIntentHash(x)).toMatch(/^[a-f0-9]{64}$/);
    expect(claimIntentHash(x)).not.toBe(claimIntentHash({ ...x, key: 'k2' }));
  });
});
