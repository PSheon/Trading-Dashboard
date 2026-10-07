import { createHash } from 'node:crypto';
import { settleListAnswer } from '../../hyperliquid/hyperliquid-global-transport.js';
import { z } from 'zod';
import { isHyperliquidNetwork, WALLET_NETWORKS, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { parseFollowerFill, parseFollowerFunding, type ParsedFollowerFill, type ParsedFollowerFunding } from './actual-fill-accounting.js';
import { boundedLiveRead } from './live-market-resolver.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';

export type FollowerReceiptKind = 'fills' | 'funding';
export interface FollowerReceiptWindow {
  readonly kind: FollowerReceiptKind; readonly from: number; readonly to: number; readonly depth: number;
}
export type FollowerWindowReason = 'same_ms_cap' | 'depth_limit' | 'request_budget' | 'receipt_budget' |
  'evidence_expired' | 'read_timeout' | 'read_unavailable';
export interface UnresolvedFollowerWindow extends FollowerReceiptWindow { readonly reason: FollowerWindowReason; }
export interface FollowerWindowObservation extends FollowerReceiptWindow {
  readonly observedAt: number; readonly completedAt: number; readonly count: number;
  readonly minReceiptTime: number | null; readonly maxReceiptTime: number | null;
  readonly saturated: boolean; readonly saturationReasons: readonly ('response_cap' | 'general_time_range_cap')[];
  readonly retained: boolean; readonly responseDigest: string;
}
export interface FollowerFillEvidence { readonly parsed: Readonly<ParsedFollowerFill>; readonly raw: Readonly<Record<string, unknown>>; }
export interface FollowerFundingEvidence { readonly parsed: Readonly<ParsedFollowerFunding>; readonly raw: Readonly<Record<string, unknown>>; }
export interface FollowerReceiptReadInput {
  readonly accountAddress: string; readonly from: number; readonly to: number; readonly maxRequests: number;
  readonly maxDepth?: number; readonly maxReceipts?: number; readonly resumeWindows?: readonly FollowerReceiptWindow[];
}
export interface FollowerReceiptReadResult {
  readonly network: HyperliquidNetwork; readonly accountAddress: string; readonly from: number; readonly to: number;
  readonly observedAt: number; readonly completedAt: number; readonly fresh: boolean;
  readonly requestsUsed: number; readonly requestedWindows: readonly FollowerReceiptWindow[];
  readonly fills: readonly FollowerFillEvidence[]; readonly funding: readonly FollowerFundingEvidence[];
  readonly observations: readonly FollowerWindowObservation[]; readonly unresolvedWindows: readonly UnresolvedFollowerWindow[];
  readonly historicalCompleteness: 'unproven';
  readonly completenessReasons: readonly ('latest_10000_fills_limit' | 'provider_history_unproven' | 'unresolved_windows' | 'response_cap_observed')[];
}
const millisecond = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const windowSchema = z.object({ kind: z.enum(['fills', 'funding']), from: millisecond, to: millisecond,
  depth: z.number().int().nonnegative().max(53) });
const inputSchema = z.object({ accountAddress: z.string(), from: millisecond, to: millisecond,
  maxRequests: z.number().int().min(1).max(64), maxDepth: z.number().int().min(0).max(53).default(48),
  maxReceipts: z.number().int().min(1).max(10000).default(10000), resumeWindows: z.array(windowSchema).min(1).max(256).optional() });
// Time-range docs also describe 500 elements/distinct blocks. Without an
// authoritative block count, >=500 rows is conservatively possibly capped.
const GENERAL_TIME_RANGE_CAP = 500;
const MAX_RESPONSE_ROWS = 2000;
export const RESPONSE_WEIGHT = 20 + MAX_RESPONSE_ROWS / 20;
const DEADLINE_MS = 5000;
function fail(code: string): never { throw new LiveBoundaryError(code); }
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
/** Canonical key ordering with a depth bound; unknown raw fields remain part of
 * duplicate semantics rather than silently hiding changed source receipts. */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 16) fail('follower_receipt_invalid_evidence');
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
  if (value && typeof value === 'object') return Object.keys(value).sort().map((key) =>
    [key, canonical((value as Record<string, unknown>)[key], depth + 1)]);
  return value;
}
function semantic(evidence: FollowerFillEvidence | FollowerFundingEvidence): string {
  const { parsed: p, raw } = evidence;
  const source = { ...raw, user: p.accountAddress, network: p.network, time: p.time,
    ...(typeof raw.hash === 'string' ? { hash: raw.hash.toLowerCase() } : {}) };
  if ('tid' in p) {
    return JSON.stringify(canonical({ ...source, tid: p.tid, oid: p.oid, coin: p.coin, side: p.side,
      px: p.price, sz: p.size, closedPnl: p.closedPnl, fee: p.totalFee, builderFee: p.builderFee, feeToken: p.feeToken }));
  }
  const delta = raw.delta as Record<string, unknown>;
  return JSON.stringify(canonical({ ...source, hash: p.hash,
    delta: { ...delta, type: 'funding', coin: p.coin, usdc: p.amount, feeToken: p.feeToken } }));
}

/** Fixed-network read evidence only. Short/empty arrays are uncapped fetched
 * windows, never a certificate of retained historical data or gap-free history.
 * Root persists immutable receipts and unresolved windows before advancing any
 * operational checkpoint; this reader deliberately exports no global cursor. */
export class HyperliquidFollowerReceiptReader {
  /** `refund` gives back acquired weight an answer didn't use (the budget's
   * `adjust(-weight)`); the shared per-IP meter is settled the same way. */
  constructor(readonly network: HyperliquidNetwork, private readonly acquire: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now, private readonly refund?: (weight: number) => void,
    private readonly prepayment?: { readonly acquire: (weight: number) => Promise<unknown>; readonly maxWaitMs: number }) {
    if (prepayment && (typeof prepayment.acquire !== 'function' || !Number.isSafeInteger(prepayment.maxWaitMs) || prepayment.maxWaitMs < 1 || prepayment.maxWaitMs > 182000 || typeof refund !== 'function')) fail('follower_reader_invalid_configuration');
    if (!isHyperliquidNetwork(network) || typeof acquire !== 'function') fail('follower_reader_invalid_configuration');
  }
  async read(input: FollowerReceiptReadInput): Promise<FollowerReceiptReadResult> {
    if (!this.prepayment) return this.readCaptured(input, this.acquire);
    // Capture and validate historical windows before waiting; no provider
    // evidence exists yet. Their source clocks start only after admission.
    let captured: z.infer<typeof inputSchema>;
    try {
      captured = inputSchema.parse(structuredClone(input)); address(captured.accountAddress);
      const at = this.now();
      if (!Number.isSafeInteger(at) || at < 0 || captured.from > captured.to || captured.to > at ||
        captured.resumeWindows?.some(w => w.from < captured.from || w.to > captured.to || w.from > w.to)) fail('follower_reader_invalid_request');
    } catch { fail('follower_reader_invalid_request'); }
    const weight = captured.maxRequests * RESPONSE_WEIGHT;
    await boundedLiveRead(() => this.prepayment!.acquire(weight), this.prepayment.maxWaitMs);
    let credit = weight;
    const acquire = async (wanted: number) => {
      const paid = Math.min(credit, wanted); credit -= paid;
      try { if (wanted > paid) await this.acquire(wanted - paid); }
      catch (error) { credit += paid; throw error; }
    };
    try { return await this.readCaptured(captured, acquire); }
    finally { if (credit > 0) this.refund!(credit); }
  }

  private async readCaptured(input: FollowerReceiptReadInput, acquire: (weight: number) => Promise<unknown>): Promise<FollowerReceiptReadResult> {
    let request: z.infer<typeof inputSchema>;
    let user: string;
    const started = this.now();
    try {
      // Capture bounds before waiting on shared budgets/providers.
      request = inputSchema.parse(structuredClone(input)); user = address(request.accountAddress);
      if (!Number.isSafeInteger(started) || started < 0 || request.from > request.to || request.to > started)
        fail('follower_reader_invalid_request');
      for (const window of request.resumeWindows ?? []) {
        if (window.from < request.from || window.to > request.to || window.from > window.to)
          fail('follower_reader_invalid_request');
      }
    } catch { fail('follower_reader_invalid_request'); }
    const requestedWindows: FollowerReceiptWindow[] = request.resumeWindows ??
      [{ kind: 'fills', from: request.from, to: request.to, depth: 0 }, { kind: 'funding', from: request.from, to: request.to, depth: 0 }];
    const queue = [...requestedWindows];
    const fills = new Map<string, FollowerFillEvidence>(), funding = new Map<string, FollowerFundingEvidence>();
    const semantics = new Map<string, string>();
    const observations: FollowerWindowObservation[] = [], unresolvedWindows: UnresolvedFollowerWindow[] = [];
    let requestsUsed = 0;
    const remaining = () => {
      if (!this.fresh(started)) fail('follower_reader_evidence_expired');
      return Math.max(1, DEADLINE_MS - (this.now() - started));
    };
    const unresolvedRest = (window: FollowerReceiptWindow, reason: FollowerWindowReason) => {
      for (const next of [window, ...queue]) unresolvedWindows.push({ ...next, reason });
      queue.length = 0;
    };
    while (queue.length) {
      const window = queue.shift()!;
      if (!this.fresh(started)) { unresolvedRest(window, 'evidence_expired'); break; }
      if (requestsUsed >= request.maxRequests) { unresolvedRest(window, 'request_budget'); break; }
      requestsUsed++;
      let rows: unknown;
      const observedAt = this.now();
      try {
        // Admit a bounded worst-case surcharge before any HTTP request. Funding
        // has the same physical row bound because general docs mention blocks.
        await boundedLiveRead(() => acquire(RESPONSE_WEIGHT), remaining());
        const body = { type: window.kind === 'fills' ? 'userFillsByTime' : 'userFunding', user,
          startTime: window.from, endTime: window.to, ...(window.kind === 'fills' ? { aggregateByTime: false } : {}) };
        const response = await boundedLiveRead(() => this.fetcher(WALLET_NETWORKS[this.network].infoUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          redirect: 'error', signal: AbortSignal.timeout(remaining()),
        }), remaining());
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); fail('follower_reader_read_unavailable'); }
        rows = await boundedLiveRead(() => readInfoJson(response, 'follower receipts', 2 * 1024 * 1024), remaining());
        if (Array.isArray(rows)) {
          // A list's real weight is 20 + 1 per 20 rows; the rest goes back.
          settleListAnswer(response, rows.length);
          try { this.refund?.(RESPONSE_WEIGHT - Math.min(RESPONSE_WEIGHT, 20 + Math.ceil(rows.length / 20))); } catch { /* accounting only */ }
        }
        remaining();
      } catch (error) {
        const reason = !this.fresh(started) ? 'evidence_expired' : error instanceof LiveBoundaryError && error.code === 'live_read_deadline_exceeded'
          ? 'read_timeout' : 'read_unavailable';
        unresolvedRest(window, reason); break;
      }
      if (!Array.isArray(rows) || rows.length > MAX_RESPONSE_ROWS) fail('follower_receipt_invalid_evidence');
      const additions = new Map<string, { evidence: FollowerFillEvidence | FollowerFundingEvidence; semantic: string }>();
      let minReceiptTime: number | null = null, maxReceiptTime: number | null = null;
      for (const row of rows) {
        let evidence: FollowerFillEvidence | FollowerFundingEvidence;
        try {
          const context = { network: this.network, accountAddress: user, minTime: window.from, maxTime: window.to };
          const raw = structuredClone(row) as Record<string, unknown>;
          evidence = window.kind === 'fills' ? { parsed: parseFollowerFill(row, context), raw }
            : { parsed: parseFollowerFunding(row, context), raw };
        } catch { fail('follower_receipt_invalid_evidence'); }
        const key = `${window.kind}:${evidence.parsed.key}`, fingerprint = semantic(evidence);
        const previous = semantics.get(key) ?? additions.get(key)?.semantic;
        if (previous !== undefined && previous !== fingerprint) fail('follower_receipt_conflict');
        if (previous === undefined) additions.set(key, { evidence, semantic: fingerprint });
        minReceiptTime = Math.min(minReceiptTime ?? evidence.parsed.time, evidence.parsed.time);
        maxReceiptTime = Math.max(maxReceiptTime ?? evidence.parsed.time, evidence.parsed.time);
      }
      const saturated = rows.length >= GENERAL_TIME_RANGE_CAP;
      const saturationReasons: ('response_cap' | 'general_time_range_cap')[] = saturated ? ['general_time_range_cap'] : [];
      if (rows.length === MAX_RESPONSE_ROWS) saturationReasons.push('response_cap');
      const retained = fills.size + funding.size + additions.size <= request.maxReceipts;
      observations.push({ ...window, observedAt, completedAt: this.now(), count: rows.length, minReceiptTime, maxReceiptTime,
        saturated, saturationReasons, retained, responseDigest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') });
      if (!retained) { unresolvedRest(window, 'receipt_budget'); break; }
      for (const [key, addition] of additions) {
        semantics.set(key, addition.semantic);
        if (window.kind === 'fills') fills.set(addition.evidence.parsed.key, addition.evidence as FollowerFillEvidence);
        else funding.set(addition.evidence.parsed.key, addition.evidence as FollowerFundingEvidence);
      }
      if (!this.fresh(started)) { unresolvedRest(window, 'evidence_expired'); break; }
      if (saturated) {
        if (window.from === window.to) unresolvedWindows.push({ ...window, reason: 'same_ms_cap' });
        else if (window.depth >= request.maxDepth) unresolvedWindows.push({ ...window, reason: 'depth_limit' });
        else {
          const mid = window.from + Math.floor((window.to - window.from) / 2);
          queue.push({ ...window, to: mid, depth: window.depth + 1 }, { ...window, from: mid + 1, depth: window.depth + 1 });
        }
      }
    }
    const completenessReasons: FollowerReceiptReadResult['completenessReasons'][number][] =
      ['latest_10000_fills_limit', 'provider_history_unproven'];
    if (unresolvedWindows.length) completenessReasons.push('unresolved_windows');
    if (observations.some((o) => o.saturated)) completenessReasons.push('response_cap_observed');
    const sorted = <T extends FollowerFillEvidence | FollowerFundingEvidence>(values: Iterable<T>): T[] =>
      [...values].sort((a, b) => a.parsed.time - b.parsed.time || a.parsed.key.localeCompare(b.parsed.key));
    return frozen({ network: this.network, accountAddress: user, from: request.from, to: request.to,
      observedAt: started, completedAt: this.now(), fresh: this.fresh(started), requestsUsed, requestedWindows,
      fills: sorted(fills.values()), funding: sorted(funding.values()), observations, unresolvedWindows,
      historicalCompleteness: 'unproven', completenessReasons });
  }
  private fresh(at: number): boolean {
    const now = this.now();
    return Number.isSafeInteger(now) && now >= at && now - at <= DEADLINE_MS;
  }
}
