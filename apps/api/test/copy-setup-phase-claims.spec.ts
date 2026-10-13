import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_MODE_ABSENCE_REST_WEIGHT } from '../src/copy/copy-account-mode-evidence.js';
import { ATTEMPT_REST_WEIGHT, ATTEMPT_STEP_REST_WEIGHT, EXCHANGE_POST_WEIGHT, PREFLIGHT_REST_WEIGHT } from '../src/copy/copy-account-mode.service.js';
import { ACCOUNT_MODE_OBSERVE_WEIGHT } from '../src/copy/live/privy-account-mode-client.js';
import { infoWeight } from '../src/hyperliquid/info-weights.js';
import { Meter, T0, Testnet, database, setupIntent, worker } from './copy-setup-capacity-test-utils.js';

/**
 * The account-mode step claims what it really charges the shared meter
 * (635: both preflights, the POST and the observation after it), derived
 * from the reads it makes. Before, it claimed 613 (the local bucket's
 * figure: it counted the absence proofs' socket reads and not the
 * observation after the POST) and charged 635 under it: its last 22 were
 * past its grant, refused partway when the window was full.
 */
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the account-mode step\'s claim matches its real charges', () => {
  it('derives the claim from the reads it makes', () => {
    expect(ACCOUNT_MODE_OBSERVE_WEIGHT).toBe(infoWeight({ type: 'userRole' }) + infoWeight({ type: 'userAbstraction' }) + infoWeight({ type: 'userDexAbstraction' }) + infoWeight({ type: 'spotClearinghouseState' }));
    expect(ACCOUNT_MODE_ABSENCE_REST_WEIGHT).toBe(2 * infoWeight({ type: 'perpDexs' }) + infoWeight({ type: 'spotClearinghouseState' }) + infoWeight({ type: 'extraAgents' }));
    expect(PREFLIGHT_REST_WEIGHT).toBe(2 * ACCOUNT_MODE_OBSERVE_WEIGHT + ACCOUNT_MODE_ABSENCE_REST_WEIGHT);
    expect(ATTEMPT_REST_WEIGHT).toBe(2 * PREFLIGHT_REST_WEIGHT + EXCHANGE_POST_WEIGHT);
    expect(ATTEMPT_STEP_REST_WEIGHT).toBe(ATTEMPT_REST_WEIGHT + ACCOUNT_MODE_OBSERVE_WEIGHT);
    expect(ATTEMPT_STEP_REST_WEIGHT).toBe(635);
  });

  it('claims 635 and charges exactly that under its grant; the agent step then claims its own 81', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms); return c.signal; });
    const setupId = randomUUID(), intent = setupIntent(setupId), meter = new Meter(), testnet = new Testnet(), db = database(intent, setupId), signed: string[] = [];
    const { service } = worker(meter, testnet, db, signed);
    let done = false;
    void service.tick().finally(() => { done = true; });
    for (let i = 0; i < 1200 && !done; i++) await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
    expect(db.rows.stages[0]?.stage).toBe('mode_set');
    const rest = meter.state.events.filter(e => e.kind === 'rest').sort((a, b) => a.reservedAt - b.reservedAt);
    const claims = rest.filter(e => e.id.startsWith('setup-demand:')).slice(0, 2).map(e => ({ need: Number(e.id.split(':')[1]), granted: e.id.endsWith(':g'), at: e.reservedAt }));
    expect(claims.map(c => [c.need, c.granted])).toEqual([[635, true], [81, true]]);
    // Under the mode step's claim: its two preflights, the POST and the observation after it, no more.
    const charged = rest.filter(e => e.id.startsWith('setup:') && e.reservedAt >= claims[0]!.at && e.reservedAt < claims[1]!.at).reduce((sum, e) => sum + e.units, 0);
    expect(charged).toBe(ATTEMPT_STEP_REST_WEIGHT);
    expect(testnet.posts).toBe(1);
  }, 60_000);
});
