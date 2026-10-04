import { createHash } from 'node:crypto';
import { Dec } from '../common/decimal/dec.js';
import { followerReceiptDigestV1, parseFollowerFill } from '../copy/live/actual-fill-accounting.js';
import { decodeLz4Frames } from '../ingest/lz4-frame.js';

/** Sources: official Hyperliquid /trading/builder-codes and installed SDK
 * userNonFundingLedgerUpdates schema. The CSV header/ISO-second timestamps and
 * rewardsClaim {amount,token} were independently read from official endpoints
 * 2026-10-04. CSV has NO tid/oid/feeToken; reward claims have NO constituent-fill
 * allocation. Consequently this module cannot mint a collection certificate,
 * credit a referral ledger, establish available treasury cash or enable payouts.
 * The caller must retain these observations before using them for reconciliation.
 */
const STATS = 'https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/';
const INFO = 'https://api.hyperliquid.xyz/info';
const HEADER = 'time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee';
const DAY = 86400000;
const MAX = { maxCompressedBytes: 4 * 1024 * 1024, maxDecodedBytes: 16 * 1024 * 1024, maxRows: 25000, maxInfoBytes: 2 * 1024 * 1024, timeoutMs: 15000 };
type Limits = typeof MAX;
function check(value: unknown): asserts value { if (!value) throw new Error('invalid_builder_fee_evidence'); }
function addr(value: string): string { check(typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) && value !== `0x${'0'.repeat(40)}`); return value; }
function sha(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function decimal(value: unknown, signed = false): string {
  check(typeof value === 'string' && value.length <= 80 && (signed ? /^-?(0|[1-9]\d*)(\.\d{1,18})?$/ : /^(0|[1-9]\d*)(\.\d{1,18})?$/).test(value));
  return Dec.from(value).toString();
}
function object(value: unknown): Record<string, unknown> { check(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function utcDay(day: string): number {
  check(typeof day === 'string' && /^\d{8}$/.test(day));
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`, ms = Date.parse(iso);
  check(Number.isSafeInteger(ms) && ms >= 0 && new Date(ms).toISOString() === iso); return ms;
}
function frozen<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }

export interface BuilderCsvRow {
  row: number; time: number; user: string; coin: string; side: 'B' | 'A'; price: string; size: string;
  crossed: boolean; specialTradeType: string; tif: string; isTrigger: boolean; counterparty: string;
  closedPnl: string; twapId: string; builderFee: string;
}
export interface BuilderCsvEvidence {
  builder: string; day: string; digest: string; rows: BuilderCsvRow[];
  timeResolutionMs: 1000; feeAsset: 'unspecified'; canonicalFillIds: false;
}
/** Bounded RFC-style quoting, including embedded quoted commas/newlines. Header
 * and numeric/time domains remain strict; new provider columns require review. */
function records(text: string, maxRows: number): string[][] {
  const result: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const endField = () => { row.push(field); check(row.length <= 14); field = ''; closed = false; };
  const endRow = () => { endField(); result.push(row); check(result.length <= maxRows + 1); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += c;
    } else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c === '\r') { check(text[i + 1] === '\n'); endRow(); i++; }
    else if (c === '"') { check(!field.length && !closed); quoted = true; }
    else { check(!closed); field += c; }
    check(field.length <= 2048);
  }
  check(!quoted);
  if (field.length || row.length || closed) endRow();
  return result;
}
export function parseBuilderCsv(text: string, input: { builder: string; day: string }, maxRows = MAX.maxRows): BuilderCsvEvidence {
  const builder = addr(input.builder), start = utcDay(input.day);
  check(typeof text === 'string' && Buffer.byteLength(text) <= MAX.maxDecodedBytes && Number.isSafeInteger(maxRows) && maxRows > 0 && maxRows <= MAX.maxRows);
  const data = records(text, maxRows); check(data.shift()?.join(',') === HEADER);
  const rows = data.map((v, i): BuilderCsvRow => {
    check(v.length === 14 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v[0]!));
    const time = Date.parse(v[0]!); check(Number.isSafeInteger(time) && time >= start && time < start + DAY && new Date(time).toISOString() === v[0]!.replace('Z', '.000Z'));
    check(v[3] === 'Bid' || v[3] === 'Ask');
    check(v[2]!.length > 0 && v[2]!.length <= 80 && /^[A-Za-z0-9_:@./-]+$/.test(v[2]!));
    check(['true', 'false'].includes(v[6]!) && ['true', 'false'].includes(v[9]!));
    check(v[7]!.length <= 64 && v[8]!.length <= 64 && /^(0|[1-9]\d{0,19})$/.test(v[12]!) && BigInt(v[12]!) <= 18446744073709551615n);
    const price = decimal(v[4]), size = decimal(v[5]); check(Dec.from(price).isPositive && Dec.from(size).isPositive);
    return { row: i + 1, time, user: addr(v[1]!), coin: v[2]!, side: v[3] === 'Bid' ? 'B' : 'A', price, size,
      crossed: v[6] === 'true', specialTradeType: v[7]!, tif: v[8]!, isTrigger: v[9] === 'true', counterparty: addr(v[10]!),
      closedPnl: decimal(v[11], true), twapId: v[12]!, builderFee: decimal(v[13]) };
  });
  return frozen({ builder, day: input.day, digest: sha(text), rows, timeResolutionMs: 1000, feeAsset: 'unspecified', canonicalFillIds: false });
}

/** Load these bindings from the immutable account/receipt/execution DAL. An
 * HTTP caller presenting matching strings is NOT a trusted journal source. */
export interface BuilderFillBinding {
  userId: number; network: string; accountAddress: string;
  receipt: { key: string; digest: string; raw: Record<string, unknown> };
  journal: { key: string; userId: number; network: string; accountAddress: string; exchangeOrderId: string;
    action: { type: 'order'; builder: { b: string; f: number } } };
}
export function correlateBuilderFill(archive: BuilderCsvEvidence, input: BuilderFillBinding) {
  const b = structuredClone(input), j = b.journal;
  check(Number.isSafeInteger(b.userId) && b.userId > 0 && b.network === 'mainnet' && j.network === b.network && j.userId === b.userId);
  check(addr(b.accountAddress) === addr(j.accountAddress) && typeof j.key === 'string' && j.key.length > 0 && j.key.length <= 200);
  check(j.action.type === 'order' && addr(j.action.builder.b) === addr(archive.builder) && Number.isInteger(j.action.builder.f) && j.action.builder.f >= 0 && j.action.builder.f <= 100);
  check(Buffer.byteLength(JSON.stringify(b.receipt.raw)) <= 256 * 1024 && b.receipt.digest === followerReceiptDigestV1(b.receipt.raw));
  const start = utcDay(archive.day), fill = parseFollowerFill(b.receipt.raw, { network: 'mainnet', accountAddress: b.accountAddress, minTime: start, maxTime: start + DAY - 1, oid: j.exchangeOrderId });
  check(fill.key === b.receipt.key && fill.oid === j.exchangeOrderId);
  const fee = decimal(fill.builderFee); check(/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(fee));
  const [whole, fraction = ''] = fee.split('.'); const feeUnits = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  check(feeUnits <= (1n << 128n) - 1n);
  // Exact rational cap, rounded UP by at most one micro-USDC. This rejects
  // fees impossible under the recorded builder rate without pretending to
  // reproduce an undocumented provider rounding policy or prove collection.
  const parts = [fill.price, fill.size].map(value => { const [w, f = ''] = value.split('.'); return { n: BigInt(w! + f), scale: f.length }; });
  const numerator = parts[0]!.n * parts[1]!.n * BigInt(j.action.builder.f) * 1000000n;
  const denominator = 100000n * 10n ** BigInt(parts[0]!.scale + parts[1]!.scale);
  check(feeUnits <= (numerator + denominator - 1n) / denominator);
  const candidates = archive.rows.filter(r => r.user === fill.accountAddress && r.coin === fill.coin && r.side === fill.side && r.time === Math.floor(fill.time / 1000) * 1000
    && Dec.from(r.price).eq(fill.price) && Dec.from(r.size).eq(fill.size) && Dec.from(r.closedPnl).eq(fill.closedPnl) && Dec.from(r.builderFee).eq(fill.builderFee));
  return frozen({ kind: candidates.length === 0 ? 'unmatched' as const : candidates.length === 1 ? 'single_candidate' as const : 'ambiguous' as const,
    candidateRows: candidates.map(r => r.row), userId: b.userId, accountAddress: fill.accountAddress, receiptKey: fill.key, receiptDigest: b.receipt.digest,
    executionKey: j.key, builder: archive.builder, archiveDigest: archive.digest, chargedBuilderFeeUnits: feeUnits.toString(),
    creditable: false as const, collectionStatus: 'unproven' as const });
}

function within<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('builder_evidence_timeout'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('builder_evidence_timeout'));
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function bytes(response: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) { void response.body?.cancel().catch(() => undefined); throw new Error('builder_evidence_size_limit'); }
  check(response.body); const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await within(reader.read(), signal); if (part.done) break; size += part.value.byteLength; check(size <= max); chunks.push(part.value); }
    return Buffer.concat(chunks);
  } finally { void reader.cancel().catch(() => undefined); }
}

export class BuilderEvidenceCollector {
  private busy = false;
  private readonly limits: Limits;
  constructor(private readonly acquire: (weight: number) => Promise<unknown>, private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now, limits: Partial<Limits> = {}) {
    this.limits = { ...MAX, ...limits };
    for (const key of Object.keys(this.limits) as Array<keyof Limits>) check(key in MAX && Number.isSafeInteger(this.limits[key]) && this.limits[key] > 0 && this.limits[key] <= MAX[key]);
  }
  async read(input: { builder: string; day: string }) {
    const builder = addr(input.builder), day = input.day, start = utcDay(day), observedAt = this.now();
    check(Number.isSafeInteger(observedAt) && start <= observedAt && !this.busy); this.busy = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.limits.timeoutMs), signal = controller.signal;
    try {
      const get = async (url: string, weight: number, body?: object) => {
        await within(this.acquire(weight), signal); check(!signal.aborted);
        const response = await within(this.fetcher(url, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), redirect: 'error', signal }), signal);
        check(!response.redirected && (!response.url || response.url === url)); return response;
      };
      const archiveUrl = `${STATS}${builder}/${day}.csv.lz4`, response = await get(archiveUrl, 20);
      let archive: { status: 'missing'; url: string } | { status: 'observed'; url: string; compressedDigest: string; evidence: BuilderCsvEvidence };
      if (response.status === 404) { void response.body?.cancel().catch(() => undefined); archive = { status: 'missing', url: archiveUrl }; }
      else {
        check(response.ok); const compressed = await bytes(response, this.limits.maxCompressedBytes, signal);
        async function* source() { yield compressed; }
        const parts: Buffer[] = []; let size = 0;
        for await (const part of decodeLz4Frames(source())) { size += part.length; check(size <= this.limits.maxDecodedBytes && !signal.aborted); parts.push(part); }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
        archive = { status: 'observed', url: archiveUrl, compressedDigest: sha(compressed), evidence: parseBuilderCsv(text, { builder, day }, this.limits.maxRows) };
      }
      const referralResponse = await get(INFO, 20, { type: 'referral', user: builder }); check(referralResponse.ok);
      const referralBytes = await bytes(referralResponse, this.limits.maxInfoBytes, signal), rawReferral = object(JSON.parse(referralBytes.toString('utf8')));
      const referral = { builderRewards: decimal(rawReferral.builderRewards), claimedRewards: decimal(rawReferral.claimedRewards), unclaimedRewards: decimal(rawReferral.unclaimedRewards), digest: sha(referralBytes) };
      const endTime = Math.min(start + DAY - 1, observedAt), ledgerResponse = await get(INFO, 120, { type: 'userNonFundingLedgerUpdates', user: builder, startTime: start, endTime });
      check(ledgerResponse.ok); const ledgerBytes = await bytes(ledgerResponse, this.limits.maxInfoBytes, signal), rawLedger: unknown = JSON.parse(ledgerBytes.toString('utf8'));
      check(Array.isArray(rawLedger) && rawLedger.length <= 2000);
      const rewardsClaims: Array<{ time: number; hash: string; amount: string; token: string }> = [];
      const identities = new Map<string, string>();
      for (const raw of rawLedger) {
        const row = object(raw), delta = object(row.delta); check(Number.isSafeInteger(row.time) && (row.time as number) >= start && (row.time as number) <= endTime);
        check(typeof row.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(row.hash));
        if (delta.type !== 'rewardsClaim') continue;
        check(typeof delta.token === 'string' && delta.token.length > 0 && delta.token.length <= 64);
        const claim = { time: row.time as number, hash: row.hash.toLowerCase(), amount: decimal(delta.amount), token: delta.token };
        const key = `${claim.hash}:${claim.token}`, serialized = JSON.stringify(claim), previous = identities.get(key);
        check(previous === undefined || previous === serialized);
        if (previous === undefined) { rewardsClaims.push(claim); identities.set(key, serialized); }
      }
      return frozen({ network: 'mainnet' as const, builder, day, observedAt, completedAt: this.now(), archive, referral, rewardsClaims,
        ledgerDigest: sha(ledgerBytes), ledgerCoverage: 'unproven' as const, possiblyCapped: rawLedger.length >= 500,
        creditable: false as const, collectionStatus: 'unproven' as const,
        reasons: ['csv_missing_canonical_fill_ids', 'aggregate_claims_not_allocated', 'treasury_spendable_balance_not_established'] as const });
    } finally { clearTimeout(timer); controller.abort(); this.busy = false; }
  }
}
