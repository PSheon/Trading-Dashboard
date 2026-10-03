import { isDeepStrictEqual } from 'node:util';
import { assessLiveReservationSettlement, type LiveReservationSettlementInput, type LiveReservationSettlementCertificate } from './live-reservation-settlement.js';
import { digestLiveEvidence } from './live-order-evidence.js';
import { freezeLiveReservation } from './live-risk-reservation.js';
import { LiveBoundaryError } from './wallet-authorization.js';

export interface LiveSettlementProof {
  readonly version: 1;
  readonly input: LiveReservationSettlementInput;
  readonly certificate: LiveReservationSettlementCertificate;
}
const MAX_BYTES = 16 * 1024 * 1024;
function fail(): never { throw new LiveBoundaryError('live_settlement_proof_invalid'); }
function jsonValue(value: unknown, depth = 0): void {
  if (depth > 16) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) fail();
    for (const child of value) jsonValue(child, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail();
  if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value')) fail();
    jsonValue(descriptor.value, depth + 1);
  }
}
function capture(raw: unknown): LiveSettlementProof {
  jsonValue(raw);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_BYTES) fail();
  const proof = structuredClone(raw) as LiveSettlementProof;
  if (Object.keys(proof).sort().join(',') !== 'certificate,input,version' || proof.version !== 1 || !proof.input || !proof.certificate) fail();
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
    const proof = capture(raw);
    if (digestLiveEvidence(proof) !== claimedDigest) fail();
    return proof;
  } catch { return fail(); }
}
