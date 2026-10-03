import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Dec } from '../../common/decimal/dec.js';
import { legsOf } from '../copy-math.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';
import { LIVE_PERP_COIN } from './live-market-resolver.js';
import type { copyLiveSourceFills } from '@trading-dashboard/shared/database';
export interface LiveSourceFillContext {
  network: 'testnet'; leaderAddress: string; from: number; to: number; receivedAt: number; kind: 'fills' | 'twap';
}
export interface NormalizedLiveSourceFill {
  version: 1; kind: 'fills' | 'twap'; network: 'testnet'; leaderAddress: string; tid: string; oid: string; twapId: string | null;
  time: number; coin: string; px: string; sz: string; side: 'B' | 'A'; startPosition: string; tradeKey: string;
}
export interface LiveSourceFillEvidence {
  id: string; streamId: string; network: 'testnet'; leaderAddress: string; tid: string; oid: string;
  providerTime: number; receivedAt: number; coin: string; tradeKey: string; px: string; sz: string;
  side: 'B' | 'A'; startPosition: string; normalized: NormalizedLiveSourceFill;
  raw: Record<string, unknown>; sourceDigest: string; originVersion: 1;
}
export interface CanonicalLiveSourceLeg {
  leg: 'open' | 'close'; sign: 1 | -1; size: string; fraction: string | null; tradeKey: string;
}

const SOURCE = 'https://api.hyperliquid-testnet.xyz/info';
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const unsignedId = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v => BigInt(v) <= 18446744073709551615n);
const signedDecimal = z.string().max(81).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/).transform(v => Dec.from(v).toString());
const positiveDecimal = signedDecimal.refine(v => Dec.from(v).isPositive);
const normalizedSchema = z.object({ version: z.literal(1), kind: z.enum(['fills', 'twap']), network: z.literal('testnet'),
  leaderAddress: z.string().regex(/^0x[0-9a-f]{40}$/), tid: unsignedId, oid: unsignedId, twapId: unsignedId.nullable(),
  time: integer, coin: z.string().min(1).max(129).regex(LIVE_PERP_COIN), px: positiveDecimal, sz: positiveDecimal,
  side: z.enum(['B', 'A']), startPosition: signedDecimal, tradeKey: z.string().regex(/^(?:oid|twap):[1-9][0-9]{0,19}$/),
}).strict();
function fail(): never { throw new LiveBoundaryError('invalid_live_source_evidence'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  const input = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  const parsed = unsignedId.safeParse(input); if (!parsed.success) fail(); return parsed.data;
}
export function liveSourceDigest(value: unknown): string {
  function canonical(input: unknown, depth = 0): string {
    if (depth > 16) fail();
    if (Array.isArray(input)) return `[${input.map(v => canonical(v, depth + 1)).join(',')}]`;
    if (input && typeof input === 'object') return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    if (input === null || typeof input === 'string' || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) return JSON.stringify(input);
    fail();
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
/** The context is supplied by the fixed-origin reader, never by a provider row.
 * Raw unknown fields remain immutable duplicate evidence. */
export function parseLiveSourceFill(value: unknown, context: LiveSourceFillContext): LiveSourceFillEvidence {
  try {
    const captured = structuredClone(context), raw = object(structuredClone(value)), leaderAddress = address(captured.leaderAddress);
    if (captured.network !== 'testnet' || !['fills', 'twap'].includes(captured.kind) ||
      ![captured.from, captured.to, captured.receivedAt].every(v => Number.isSafeInteger(v) && v >= 0) || captured.from > captured.to || captured.to > captured.receivedAt) fail();
    const row = captured.kind === 'twap' ? object(raw.fill) : raw;
    for (const entry of [raw, row]) {
      if ((entry.user !== undefined && (typeof entry.user !== 'string' || address(entry.user) !== leaderAddress)) ||
          (entry.network !== undefined && entry.network !== 'testnet')) fail();
    }
    const twapId = captured.kind === 'twap' ? id(raw.twapId) : row.twapId === undefined || row.twapId === null ? null : id(row.twapId);
    if (captured.kind === 'twap' && row.twapId !== undefined && row.twapId !== null && id(row.twapId) !== twapId) fail();
    const oid = id(row.oid), tid = id(row.tid);
    const normalized = normalizedSchema.parse({ version: 1, kind: captured.kind, network: 'testnet', leaderAddress, tid, oid, twapId,
      time: row.time, coin: row.coin, px: row.px, sz: row.sz, side: row.side, startPosition: row.startPosition,
      tradeKey: twapId === null ? `oid:${oid}` : `twap:${twapId}` });
    if (normalized.time < captured.from || normalized.time > captured.to) fail();
    const streamId = `testnet:${leaderAddress}`;
    return { id: `${streamId}:${tid}`, streamId, network: 'testnet', leaderAddress, tid, oid, providerTime: normalized.time, receivedAt: captured.receivedAt,
      coin: normalized.coin, tradeKey: normalized.tradeKey, px: normalized.px, sz: normalized.sz, side: normalized.side, startPosition: normalized.startPosition,
      normalized, raw, sourceDigest: liveSourceDigest({ source: SOURCE, normalized, raw }), originVersion: 1 };
  } catch { fail(); }
}
/** Verify provider evidence against every DB mirror before taking a leg claim. */
export function decodeLiveSourceFill(row: typeof copyLiveSourceFills.$inferSelect): LiveSourceFillEvidence {
  try {
    const normalized = normalizedSchema.parse(row.normalized), time = row.providerTime.getTime(), receivedAt = row.receivedAt.getTime();
    const fill = parseLiveSourceFill(row.raw, { network: 'testnet', leaderAddress: row.leaderAddress, from: time, to: time, receivedAt, kind: normalized.kind });
    if (liveSourceDigest(normalized) !== liveSourceDigest(fill.normalized)) fail();
    for (const [key, expected] of Object.entries(fill)) {
      if (key === 'raw' || key === 'normalized') continue;
      const actual = key === 'providerTime' ? time : key === 'receivedAt' ? receivedAt : row[key as keyof typeof row];
      if (actual !== expected) fail();
    }
    return fill;
  } catch { fail(); }
}
export function canonicalLiveSourceLegs(fill: LiveSourceFillEvidence): CanonicalLiveSourceLeg[] {
  const certified = decodeLiveSourceFill({ ...fill, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt), normalized: { ...fill.normalized } });
  return (legsOf({ tid: BigInt(certified.tid), coin: certified.coin, time: certified.providerTime, px: Dec.from(certified.px), sz: Dec.from(certified.sz),
    side: certified.side, startPosition: Dec.from(certified.startPosition), tradeKey: certified.tradeKey }) ?? []).map(leg => ({ leg: leg.leg, sign: leg.sign,
      size: leg.size.toString(), fraction: leg.leg === 'close' ? leg.fraction.toString() : null, tradeKey: leg.tradeKey }));
}
export function liveSourceLegId(mandateId: string, fillId: string, leg: 'open' | 'close'): string {
  if (typeof mandateId !== 'string' || mandateId.length < 1 || mandateId.length > 128 || typeof fillId !== 'string' || fillId.length < 1 || fillId.length > 160 || !['open', 'close'].includes(leg)) fail();
  return `leg:${liveSourceDigest({ mandateId, fillId, leg })}`;
}
