import { z } from 'zod';
import { parseLiveSourceFill, liveSourceDigest, reconcileLiveSourceFills, type LiveSourceFillEvidence } from './live/copy-live-source-evidence.js';
import { address, LiveBoundaryError } from './live/wallet-authorization.js';
import { boundedLiveRead } from './live/live-market-resolver.js';
export interface LiveSourceReadRequest { leaderAddress: string; from: number; to: number; maxRequests: number; maxDepth?: number; maxFills?: number; }
export interface LiveSourceWindow { kind: 'fills' | 'twap'; from: number; to: number; depth: number; }
export interface LiveSourceWindowObservation extends LiveSourceWindow { observedAt: number; completedAt: number; count: number; responseDigest: string; saturated: boolean; }
export interface LiveSourceReadResult {
  network: 'testnet'; leaderAddress: string; from: number; to: number; observedAt: number; completedAt: number; fresh: boolean;
  complete: boolean; historicalCompleteness: 'unproven'; requestsUsed: number; fills: LiveSourceFillEvidence[];
  observations: LiveSourceWindowObservation[]; unresolved: (LiveSourceWindow & { reason: 'same_ms_cap' | 'depth_limit' | 'request_budget' | 'fill_budget' | 'read_unavailable' | 'evidence_expired' | 'twap_identity_unproven' })[];
  sourceDigest: string;
}

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.object({ leaderAddress: z.string(), from: integer, to: integer,
  maxRequests: z.number().int().min(1).max(64), maxDepth: z.number().int().min(0).max(48).default(24),
  maxFills: z.number().int().min(1).max(10000).default(10000),
}).strict();
const DEADLINE = 5000, ROW_CAP = 2000, POSSIBLE_CAP = 500, BODY_CAP = 2 * 1024 * 1024;
function fail(code: string): never { throw new LiveBoundaryError(code); }
async function json(response: Response, remaining: () => number, signal: AbortSignal) {
  const declared = Number(response.headers.get('content-length'));
  if (!response.body || (Number.isFinite(declared) && declared > BODY_CAP)) { void response.body?.cancel().catch(() => undefined); fail('live_source_response_invalid'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await boundedLiveRead(reader.read(), remaining());
      if (next.done) break;
      bytes += next.value.byteLength; if (bytes > BODY_CAP) fail('live_source_response_invalid'); chunks.push(next.value);
    }
    signal.throwIfAborted(); remaining();
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    await boundedLiveRead(reader.cancel(), 100).catch(() => undefined); reader.releaseLock();
  }
}
/** Fixed public testnet source reads. Operational window completeness never
 * certifies the API's retained history beyond the most recent 10000 fills. */
export class HyperliquidLiveSourceClient {
  readonly network = 'testnet' as const;
  constructor(network: 'testnet', private readonly acquire: (weight: number) => Promise<unknown>, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    if (network !== 'testnet' || typeof acquire !== 'function') fail('live_source_configuration_invalid');
  }
  async read(input: LiveSourceReadRequest): Promise<LiveSourceReadResult> {
    const started = this.now(), controller = new AbortController();
    let request: z.infer<typeof requestSchema>;
    try {
      request = requestSchema.parse(structuredClone(input)); request.leaderAddress = address(request.leaderAddress);
      if (!Number.isSafeInteger(started) || started < 1 || request.from > request.to || request.to > started) fail('live_source_request_invalid');
    } catch { fail('live_source_request_invalid'); }
    const queue: LiveSourceWindow[] = [{ kind: 'fills', from: request.from, to: request.to, depth: 0 }, { kind: 'twap', from: request.from, to: request.to, depth: 0 }];
    const unresolved: LiveSourceReadResult['unresolved'] = [], observations: LiveSourceWindowObservation[] = [];
    const fills = new Map<string, LiveSourceFillEvidence>(); let requestsUsed = 0;
    const timer = setTimeout(() => controller.abort(), DEADLINE); timer.unref();
    const fresh = () => Number.isSafeInteger(this.now()) && this.now() >= started && this.now() - started <= DEADLINE && !controller.signal.aborted;
    const remaining = () => { if (!fresh()) fail('live_source_evidence_expired'); return Math.max(1, DEADLINE - (this.now() - started)); };
    const rest = (window: LiveSourceWindow, reason: LiveSourceReadResult['unresolved'][number]['reason']) => {
      unresolved.push(...[window, ...queue].map(w => ({ ...w, reason }))); queue.length = 0;
    };
    try {
      while (queue.length) {
        const window = queue.shift()!;
        if (!fresh()) { rest(window, 'evidence_expired'); break; }
        if (requestsUsed >= request.maxRequests) { rest(window, 'request_budget'); break; }
        requestsUsed++;
        const observedAt = this.now(); let rows: unknown;
        try {
          await boundedLiveRead(this.acquire(120), remaining()); remaining();
          const body = { type: window.kind === 'fills' ? 'userFillsByTime' : 'userTwapSliceFillsByTime', user: request.leaderAddress,
            startTime: window.from, endTime: window.to, ...(window.kind === 'fills' ? { aggregateByTime: false } : {}) };
          const response = await boundedLiveRead(this.fetcher('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), redirect: 'error', signal: controller.signal }), remaining());
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); fail('live_source_read_unavailable'); }
          rows = await json(response, remaining, controller.signal); remaining();
        } catch { rest(window, fresh() ? 'read_unavailable' : 'evidence_expired'); break; }
        if (!Array.isArray(rows) || rows.length > ROW_CAP) fail('live_source_response_invalid');
        const additions = new Map<string, LiveSourceFillEvidence>();
        for (const raw of rows) {
          const parsed = parseLiveSourceFill(raw, { network: 'testnet', leaderAddress: request.leaderAddress, from: window.from, to: window.to, receivedAt: this.now(), kind: window.kind });
          const old = fills.get(parsed.id) ?? additions.get(parsed.id);
          if (old) additions.set(parsed.id, reconcileLiveSourceFills(old,parsed,'acquisition'));
          else additions.set(parsed.id, parsed);
        }
        const saturated = rows.length >= POSSIBLE_CAP;
        observations.push({ ...window, observedAt, completedAt: this.now(), count: rows.length, responseDigest: liveSourceDigest(rows), saturated });
        if (fills.size + [...additions.keys()].filter(id=>!fills.has(id)).length > request.maxFills) { rest(window, 'fill_budget'); break; }
        for (const [id, parsed] of additions) fills.set(id, parsed);
        if (!fresh()) { rest(window, 'evidence_expired'); break; }
        if (saturated) {
          if (window.from === window.to) { unresolved.push({ ...window, reason: 'same_ms_cap' }); continue; }
          if (window.depth >= request.maxDepth) { unresolved.push({ ...window, reason: 'depth_limit' }); continue; }
          const mid = window.from + Math.floor((window.to - window.from) / 2);
          queue.push({ kind: window.kind, from: window.from, to: mid, depth: window.depth + 1 }, { kind: window.kind, from: mid + 1, to: window.to, depth: window.depth + 1 });
        }
      }
      for(const [id,fill]of fills)if(fill.normalized.kind==='fills'&&fill.normalized.twapId===null&&fill.raw.hash===`0x${'00'.repeat(32)}`){
        fills.delete(id);unresolved.push({kind:'fills',from:fill.providerTime,to:fill.providerTime,depth:0,reason:'twap_identity_unproven'});
      }
      const completedAt = this.now(), result = { network: 'testnet' as const, leaderAddress: request.leaderAddress, from: request.from, to: request.to,
        observedAt: started, completedAt, fresh: fresh(), complete: unresolved.length === 0 && fresh(), historicalCompleteness: 'unproven' as const, requestsUsed,
        fills: [...fills.values()].sort((a, b) => a.providerTime - b.providerTime || (BigInt(a.tid) < BigInt(b.tid) ? -1 : BigInt(a.tid) > BigInt(b.tid) ? 1 : 0)), observations, unresolved };
      return { ...result, sourceDigest: liveSourceDigest(result) };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
