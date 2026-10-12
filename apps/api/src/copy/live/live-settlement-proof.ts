import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assessLiveReservationSettlement, type LiveReservationSettlementInput, type LiveReservationSettlementCertificate } from './live-reservation-settlement.js';
import { canonicalLiveEvidence, digestLiveEvidence } from './live-order-evidence.js';
import { freezeLiveReservation } from './live-risk-reservation.js';
import { LiveBoundaryError } from './wallet-authorization.js';

export interface LiveSettlementProof {
  readonly version: 1;
  readonly input: LiveReservationSettlementInput;
  readonly certificate: LiveReservationSettlementCertificate;
}
const MAX_BYTES = 16 * 1024 * 1024;
function fail(): never { throw new LiveBoundaryError('live_settlement_proof_invalid'); }
/** Plain JSON data only; returns whether it holds a negative zero (which the
 * canonical digest cannot tell from 0). */
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 16) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return false;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return Object.is(value, -0); }
  let negativeZero = false;
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) fail();
    for (const child of value) negativeZero = jsonValue(child, depth + 1) || negativeZero;
    return negativeZero;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail();
  if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value')) fail();
    negativeZero = jsonValue(descriptor.value, depth + 1) || negativeZero;
  }
  return negativeZero;
}
function capture(raw: unknown): LiveSettlementProof {
  jsonValue(raw);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_BYTES) fail();
  const proof = structuredClone(raw) as LiveSettlementProof;
  if (Object.keys(proof).sort().join(',') !== 'certificate,input,version' || proof.version !== 1 || !proof.input || !proof.certificate) fail();
  assessments++;
  // Historical replay uses the original assessment time. No current-time
  // freshness permit is minted by decoding this immutable certificate.
  const replay = assessLiveReservationSettlement(proof.input);
  if (replay.kind !== 'release' || !isDeepStrictEqual(replay.certificate, proof.certificate)) fail();
  return freezeLiveReservation(proof);
}

/** Capture the complete input once, alongside the atomic release and evidence
 * update. The producing DAL, not incoming HTTP arrays, supplies this input. */
export function captureLiveSettlementProof(input: LiveReservationSettlementInput, certificate: LiveReservationSettlementCertificate):
  Readonly<{ proof: Readonly<LiveSettlementProof>; digest: string }> {
  try {
    const proof = capture({ version: 1, input, certificate });
    return Object.freeze({ proof, digest: digestLiveEvidence(proof) });
  } catch { return fail(); }
}

/** Content verification only: caller must additionally bind every SQL mirror,
 * original immutable journal/reservation and current booked receipt manifest.
 * Older certificates without retained inputs remain unproven. */
export function decodeLiveSettlementProof(raw: unknown, claimedDigest: string): Readonly<LiveSettlementProof> {
  try {
    if (typeof claimedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(claimedDigest)) fail();
    const cached = verifiedProof(raw, claimedDigest);
    if (cached) return cached;
    const proof = capture(raw);
    if (digestLiveEvidence(proof) !== claimedDigest) fail();
    remember(claimedDigest, proof, Buffer.byteLength(JSON.stringify(proof), 'utf8'));
    return proof;
  } catch { return fail(); }
}

/**
 * Verified settlement proofs by content digest, bounded (least recently used
 * first out). Every settled order's proof was re-assessed by every projection
 * of every later order (its preparation's and each risk gate check's, about
 * fourteen), so each order took ~100 ms longer per settled order before it
 * until the copy's orders outlived the 5 s evidence window (CI 2026-10-13:
 * live_risk_stale at the final check, the order never placed).
 *
 * Sound because decoding is a pure function of the proof's content: capture()
 * reads no clock, configuration or database (the assessment's `now` is the
 * proof's own input.now; identity is bound by the caller after decoding, on
 * every call). The digest names that content (canonical JSON, SHA-256), so a
 * proof whose content hashes to a cached digest is content the full check
 * already accepted. Only a proof that passed the full check is cached; on a
 * hit the supplied content is still checked as plain JSON and hashed again,
 * and anything that does not hash to the claimed digest is refused. A
 * negative zero (which the digest reads as 0) skips the cache.
 */
export const LIVE_SETTLEMENT_PROOF_CACHE_ENTRIES = 512;
export const LIVE_SETTLEMENT_PROOF_CACHE_BYTES = 32 * 1024 * 1024;
const verified = new Map<string, { readonly proof: Readonly<LiveSettlementProof>; readonly bytes: number }>();
let verifiedBytes = 0, verifiedHits = 0, assessments = 0;
function verifiedProof(raw: unknown, claimedDigest: string): Readonly<LiveSettlementProof> | null {
  const entry = verified.get(claimedDigest);
  if (!entry || jsonValue(raw)) return null;
  const canonical = canonicalLiveEvidence(raw);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_BYTES || createHash('sha256').update(canonical).digest('hex') !== claimedDigest) fail();
  verified.delete(claimedDigest); verified.set(claimedDigest, entry); verifiedHits++;
  return entry.proof;
}
function remember(digest: string, proof: Readonly<LiveSettlementProof>, bytes: number): void {
  if (verified.has(digest) || bytes > LIVE_SETTLEMENT_PROOF_CACHE_BYTES) return;
  verified.set(digest, { proof, bytes }); verifiedBytes += bytes;
  for (const [oldest, entry] of verified) {
    if (verified.size <= LIVE_SETTLEMENT_PROOF_CACHE_ENTRIES && verifiedBytes <= LIVE_SETTLEMENT_PROOF_CACHE_BYTES) break;
    verified.delete(oldest); verifiedBytes -= entry.bytes;
  }
}
/** Observability and tests: the cache's size, its hits and the full
 * assessments (captures and cache misses) since the last clear. */
export function liveSettlementProofCacheStats(): Readonly<{ entries: number; bytes: number; hits: number; assessments: number }> {
  return Object.freeze({ entries: verified.size, bytes: verifiedBytes, hits: verifiedHits, assessments });
}
export function clearLiveSettlementProofCache(): void { verified.clear(); verifiedBytes = 0; verifiedHits = 0; assessments = 0; }
