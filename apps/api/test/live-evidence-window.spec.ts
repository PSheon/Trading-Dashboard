import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveEvidenceMaxAgeMs, liveFillScanMarginMs, liveSnapshotMaxAgeMs, registerLiveEvidenceWindow } from '../src/config/live-evidence-window.js';
import { INDEX_LAG_MS } from '../src/config/constants/background.js';
import { LIVE_EVIDENCE_MAX_AGE_MS, LIVE_FILL_SCAN_MARGIN_MS, LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS } from '../src/config/constants/timings.js';
import { LiveSharedReads } from '../src/copy/live/live-shared-reads.js';
import { planLiveReservation, type LiveReservationBoundsInput } from '../src/copy/live/live-risk-reservation.js';
import { LiveProviderReadEpoch } from '../src/copy/live/live-provider-read-epoch.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { fixture, now } from './copy-live-risk-test-utils.js';

/**
 * The testnet-only evidence window (COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS,
 * approved by Paul 2026-10-16). Testnet lists 273 perp dexes (mainnet 11):
 * its fan-out alone took 1.5–1.6 s and order evidence 4.7–5.1 s (gate 11), so
 * every attempt was `live_risk_stale`. Mainnet stays at 5000 ms.
 */
afterEach(() => registerLiveEvidenceWindow('testnet', undefined));

describe('one resolver for the live evidence window', () => {
  it('is 5000 unless a testnet deployment set it; mainnet evidence is 5000 whatever was set', () => {
    expect(LIVE_EVIDENCE_MAX_AGE_MS).toBe(5000);
    expect(liveEvidenceMaxAgeMs()).toBe(5000);
    expect(liveEvidenceMaxAgeMs('testnet')).toBe(5000);
    registerLiveEvidenceWindow('testnet', 7000);
    expect([liveEvidenceMaxAgeMs(), liveEvidenceMaxAgeMs('testnet'), liveEvidenceMaxAgeMs('mainnet')]).toEqual([7000, 7000, 5000]);
    registerLiveEvidenceWindow('mainnet', undefined);
    expect([liveEvidenceMaxAgeMs(), liveEvidenceMaxAgeMs('testnet'), liveEvidenceMaxAgeMs('mainnet')]).toEqual([5000, 5000, 5000]);
  });
  it('refuses a window on a mainnet deployment and outside 5000..10000', () => {
    expect(() => registerLiveEvidenceWindow('mainnet', 7000)).toThrow('testnet only');
    expect(() => registerLiveEvidenceWindow('mainnet', 5000)).toThrow('testnet only');
    for (const bad of [4999, 10_001, 6000.5, Number.NaN]) expect(() => registerLiveEvidenceWindow('testnet', bad)).toThrow('COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS');
    expect(LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS).toBe(10_000);
    expect(liveEvidenceMaxAgeMs()).toBe(5000);
  });
  it('derives the close snapshot bound and the fill-scan margin from the window in force (mainnet: the constants)', () => {
    expect(liveFillScanMarginMs()).toBe(LIVE_FILL_SCAN_MARGIN_MS);
    expect(liveSnapshotMaxAgeMs()).toBe(4000);
    registerLiveEvidenceWindow('testnet', 7000);
    expect(liveFillScanMarginMs()).toBe(INDEX_LAG_MS + 7000);
    expect(liveFillScanMarginMs('mainnet')).toBe(LIVE_FILL_SCAN_MARGIN_MS);
    expect(liveSnapshotMaxAgeMs()).toBe(6000);
  });
  it('nothing on the live path reads the mainnet constants directly: every bound goes through the resolver', () => {
    const src = resolve(import.meta.dirname, '../src');
    const files = (dir: string): string[] => readdirSync(dir).flatMap(entry => {
      const path = join(dir, entry); return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
    const direct = ['copy', 'hyperliquid', 'traders', 'wallet', 'watcher'].flatMap(dir => files(join(src, dir))).flatMap(path =>
      readFileSync(path, 'utf8').split('\n').map((line, i) => ({ line, at: `${relative(src, path)}:${i + 1}` }))
        .filter(({ line }) => !/^\s*(\*|\/\/|\/\*\*)/.test(line) && /\b(LIVE_EVIDENCE_MAX_AGE_MS|LIVE_FILL_SCAN_MARGIN_MS|SNAPSHOT_MAX_AGE_MS)\b/.test(line))
        .map(({ at }) => at));
    expect(direct).toEqual([]);
    // 5000 is written once, as LIVE_EVIDENCE_MAX_AGE_MS (the cap is derived from it).
    const timings = readFileSync(join(src, 'config/constants/timings.ts'), 'utf8');
    expect(timings).toContain('export const LIVE_EVIDENCE_MAX_AGE_MS = 5_000;');
    expect(timings).toContain('export const LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS = 2 * LIVE_EVIDENCE_MAX_AGE_MS;');
  });
  it('is registered right after the environment is validated, before either role starts', () => {
    const main = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8');
    const validated = main.indexOf('const config = validateEnvironment();'), registered = main.indexOf('registerLiveEvidenceWindow(config.hyperliquid.wallet.network, config.copy.testnetEvidenceMaxAgeMs)');
    expect(validated).toBeGreaterThan(0);
    expect(registered).toBeGreaterThan(validated);
    expect(main.indexOf('startWorker(config, logger)')).toBeGreaterThan(registered);
    expect(main.indexOf('startApi(config, logger)')).toBeGreaterThan(registered);
  });
});

describe('the window on the order path: shared reads, reservation planning, the read epoch', () => {
  /** One epoch's two reads: the first starts the clock at `now`, the second goes out `ageMs` later. */
  async function sharedReadAt(network: 'testnet' | 'mainnet', ageMs: number) {
    let clock = now;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { type: string };
      return Response.json(body.type === 'perpDexs' ? [null] : { role: 'user' });
    }) as unknown as typeof fetch;
    const shared = new LiveSharedReads(network, fetcher, undefined, () => clock);
    await shared.get({ type: 'userRole', user: `0x${'11'.repeat(20)}` });
    clock = now + ageMs;
    return shared.get({ type: 'perpDexs' });
  }
  it('shared reads (default bound: the window) accept a 6 s-old epoch at 7000 and refuse 7.001 s; mainnet refuses 5.001 s', async () => {
    await expect(sharedReadAt('testnet', 5001)).rejects.toThrow('live_risk_stale');
    registerLiveEvidenceWindow('testnet', 7000);
    await expect(sharedReadAt('testnet', 6000)).resolves.toEqual([null]);
    await expect(sharedReadAt('testnet', 7001)).rejects.toThrow('live_risk_stale');
    await expect(sharedReadAt('mainnet', 5001)).rejects.toThrow('live_risk_stale');
  });

  type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
  function reservation(ageMs: number): Mutable<LiveReservationBoundsInput> {
    const f = fixture();
    const input: Mutable<LiveReservationBoundsInput> = { now: f.now, identity: f.identity, localSource: f.localSource, intent: f.intent,
      action: f.action, market: f.market, quote: f.quote, leverage: f.leverageProofs[0]!, fees: f.fees, policy: f.policy, expiresAt: now + 60000 };
    input.quote.observedAt = now - ageMs;
    return input;
  }
  it('reservation planning (testnet fixture) accepts 6 s-old evidence at 7000 and refuses 7.001 s; unset refuses 5.001 s', () => {
    expect(() => planLiveReservation(reservation(5001))).toThrow();
    expect(() => planLiveReservation(reservation(4999))).not.toThrow();
    registerLiveEvidenceWindow('testnet', 7000);
    expect(() => planLiveReservation(reservation(6000))).not.toThrow();
    expect(() => planLiveReservation(reservation(7001))).toThrow();
  });

  function epochFresh(network: 'testnet' | 'mainnet', clock: () => number) {
    const acquire = async () => {}, fetcher = vi.fn<typeof fetch>(async () => { throw Error('no remote reads'); });
    const epoch = new LiveProviderReadEpoch(new HyperliquidLiveAccountObserver(network, acquire, fetcher, clock),
      new HyperliquidLiveMarketResolver(network, acquire, fetcher, clock), new HyperliquidLiveRiskProvider(network, acquire, fetcher, clock),
      { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, clock);
    // The epoch's clock check (`live_risk_stale`), white-box: every frame and the final check go through it.
    return (at: number) => (epoch as unknown as { fresh(at: number): void }).fresh(at);
  }
  it('the read epoch accepts a 6 s-old frame at 7000 and refuses 7.001 s; a mainnet epoch refuses 5.001 s', () => {
    expect(() => epochFresh('testnet', () => now)(now - 5001)).toThrow('live_risk_stale');
    registerLiveEvidenceWindow('testnet', 7000);
    expect(() => epochFresh('testnet', () => now)(now - 6000)).not.toThrow();
    expect(() => epochFresh('testnet', () => now)(now - 7001)).toThrow('live_risk_stale');
    expect(() => epochFresh('mainnet', () => now)(now - 5001)).toThrow('live_risk_stale');
    expect(() => epochFresh('mainnet', () => now)(now - 5000)).not.toThrow();
  });
});
