import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { LiveAllDexsAccountSource, LiveAllDexsStateEvidence } from '../../src/copy/live/live-account-ws-source.js';

/**
 * Replays a recording made by scripts/ops/hl-record.mjs (test/fixtures/hyperliquid/
 * <network>/<date>/, see its README) as the `fetcher: typeof fetch` every live
 * reader takes in its constructor (HyperliquidLiveSourceClient,
 * HyperliquidLiveAccountObserver, HyperliquidFollowerReceiptReader,
 * HyperliquidLiveMarketResolver, HyperliquidLiveRiskProvider), so the decoders
 * see the provider's own shapes. Every answer is the recorded file parsed as
 * is; a time-windowed list (userFillsByTime, userTwapSliceFillsByTime,
 * userFunding) is filtered to the requested window, as the provider would,
 * and a window the recording does not cover is refused. A request no file
 * answers throws UnrecordedInfoRequest naming it: nothing is ever invented.
 */
export interface RecordedEntry {
  file: string; type: string; request: Record<string, unknown>; recordedAt: string; bytes: number; rows?: number;
  /** Windowed lists: the time range the file can answer for (narrowed to the kept rows after a cut). */
  coverage?: { from: number; to: number; rows: number };
  truncated?: { originalRows: number; keptRows: number };
}
export interface RecordedIndex {
  network: HyperliquidNetwork; endpoint: string; date: string; recordedAt: string;
  window: { startTime: number; endTime: number; hours: number }; maxFills: number; addresses: string[]; totalBytes: number; entries: RecordedEntry[];
}
export interface RecordedRequestMatch { type: string; user?: string; dex?: string; coin?: string; oid?: number; builder?: string }

export const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/hyperliquid', import.meta.url));
const WINDOWED_TYPES = new Set(['userFillsByTime', 'userTwapSliceFillsByTime', 'userFunding']);
/** The request fields a recording is keyed by (the window and `aggregateByTime` are answered, not matched). */
const KEYS = ['user', 'dex', 'coin', 'oid', 'builder'] as const;

export class UnrecordedInfoRequest extends Error {
  constructor(readonly body: Record<string, unknown>, dir: string, why: string) {
    super(`recordedHyperliquidInfo: ${why} for ${JSON.stringify(body)} (recording: ${dir}; re-record with scripts/ops/hl-record.mjs)`);
  }
}

/** The newest recording of a network (its date directory). */
export function latestRecording(network: HyperliquidNetwork, root = FIXTURES_ROOT): string {
  const dir = join(root, network);
  const dates = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && statSync(join(dir, name)).isDirectory()).sort();
  if (!dates.length) throw new Error(`no recording under ${dir}`);
  return join(dir, dates[dates.length - 1]!);
}

const same = (a: unknown, b: unknown) => (a === undefined || a === '' ? '' : typeof a === 'string' ? a.toLowerCase() : a) === (b === undefined || b === '' ? '' : typeof b === 'string' ? b.toLowerCase() : b);
const timeOf = (row: unknown): number | null => {
  const r = row as { time?: unknown; fill?: { time?: unknown } } | null;
  return Number.isSafeInteger(r?.time) ? (r!.time as number) : Number.isSafeInteger(r?.fill?.time) ? (r!.fill!.time as number) : null;
};

export class RecordedHyperliquidInfo {
  readonly index: RecordedIndex;
  readonly network: HyperliquidNetwork;
  private readonly texts = new Map<string, string>();
  constructor(readonly dir: string) {
    this.index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as RecordedIndex;
    this.network = this.index.network;
  }
  entries(type?: string): RecordedEntry[] { return this.index.entries.filter(e => type === undefined || e.type === type); }
  /** The entries answering a request shape (type and its identifying fields). */
  matching(match: RecordedRequestMatch): RecordedEntry[] {
    return this.index.entries.filter(e => e.type === match.type && KEYS.every(key => same(e.request[key], match[key])));
  }
  entry(match: RecordedRequestMatch): RecordedEntry {
    const found = this.matching(match);
    if (found.length !== 1) throw new UnrecordedInfoRequest({ ...match }, this.dir, found.length ? `${found.length} recordings` : 'no recording');
    return found[0]!;
  }
  /** The recorded bytes of one answer. */
  text(match: RecordedRequestMatch): string {
    const { file } = this.entry(match);
    let text = this.texts.get(file);
    if (text === undefined) { text = readFileSync(join(this.dir, file), 'utf8'); this.texts.set(file, text); }
    return text;
  }
  /** One recorded answer, parsed. */
  raw<T = unknown>(match: RecordedRequestMatch): T { return JSON.parse(this.text(match)) as T; }
  /** The answer to a request body: the recorded bytes, or the recorded list filtered to the body's window. */
  answer(body: Record<string, unknown>): string {
    if (typeof body.type !== 'string') throw new UnrecordedInfoRequest(body, this.dir, 'no type');
    const match = { type: body.type, ...Object.fromEntries(KEYS.filter(key => body[key] !== undefined).map(key => [key, body[key]])) } as RecordedRequestMatch;
    const text = this.text(match);
    if (!WINDOWED_TYPES.has(body.type)) return text;
    const { coverage } = this.entry(match);
    const from = body.startTime, to = body.endTime ?? coverage?.to;
    if (!coverage || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || (from as number) < coverage.from || (to as number) > coverage.to)
      throw new UnrecordedInfoRequest(body, this.dir, `window outside the recorded coverage ${JSON.stringify(coverage)}`);
    const rows = (JSON.parse(text) as unknown[]).filter(row => { const t = timeOf(row); return t !== null && t >= (from as number) && t <= (to as number); });
    return JSON.stringify(rows);
  }
  /** `typeof fetch` for the live readers: POSTs to the recorded network's info endpoint only. */
  readonly fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== this.index.endpoint) throw new Error(`recordedHyperliquidInfo: ${url} is not the recorded endpoint ${this.index.endpoint}`);
    if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('recordedHyperliquidInfo: expected a POST with a JSON body');
    init.signal?.throwIfAborted();
    const text = this.answer(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  /** The provider `time` of every recorded clearinghouseState of an address (main dex first). */
  stateTimes(address: string): number[] {
    return this.states(address).map(([, state]) => (state as { time: number }).time);
  }
  /** `[dex, clearinghouseState]` for the main dex and every listed dex, as the aggregate carries them. */
  states(address: string, mutate: (dex: string, state: Record<string, unknown>) => Record<string, unknown> = (_dex, state) => state): [string, Record<string, unknown>][] {
    const dexes = this.raw<({ name: string } | null)[]>({ type: 'perpDexs' });
    return dexes.flatMap((row, i) => i === 0 || row ? [i === 0 ? '' : row!.name] : []).map(dex => [dex, mutate(dex, this.raw({ type: 'clearinghouseState', user: address, dex }))]);
  }
  /**
   * The observer's all-venue source (its WebSocket `allDexsClearinghouseState`
   * aggregate), composed from the recorded REST clearinghouseState of each
   * venue; `observedAt` is the test's clock. `mutate` lets a property test
   * perturb a venue's state (a float-noise size) while everything else stays real.
   */
  accountSource(address: string, now: () => number, mutate?: (dex: string, state: Record<string, unknown>) => Record<string, unknown>): LiveAllDexsAccountSource {
    const user = address.toLowerCase();
    return { read: async (accountAddress: string): Promise<LiveAllDexsStateEvidence> => {
      if (accountAddress.toLowerCase() !== user) throw new Error(`recordedHyperliquidInfo: no clearinghouse recording for ${accountAddress}`);
      return { network: this.network, accountAddress: user, observedAt: now(), data: { user, clearinghouseStates: this.states(user, mutate) } };
    } };
  }
}

export function recordedHyperliquidInfo(dir: string): RecordedHyperliquidInfo { return new RecordedHyperliquidInfo(dir); }
