import { describe, expect, it } from 'vitest';
import { LiveSharedReads, type LiveInfoBatch } from '../src/copy/live/live-shared-reads.js';

const now = () => 1_800_000_000_000;
// Eighteen ordinary reads: 360 weight, split at the sixteen-body limit.
const bodies = Array.from({ length: 18 }, (_, index) => ({
  type: 'userAbstraction', user: `0x${(index + 1).toString(16).padStart(40, '0')}`,
}));
const answers = (requests: readonly Readonly<Record<string, unknown>>[]) => requests.map(() => Response.json('disabled'));
const forbiddenFetch: typeof fetch = async () => { throw new Error('batch must own dispatch'); };
function reader(batch: LiveInfoBatch) {
  return new LiveSharedReads('testnet', forbiddenFetch, batch, now, 5000, async () => undefined);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('provider dispatch accounting for prepaid evidence', () => {
  it('uses the admission-aware dispatch boundary for a single paid read too', async () => {
    const refusal = new Error('single read admission refused');
    const shared = reader(async () => { throw refusal; });
    await shared.pay(20);
    await expect(shared.wave([bodies[0]!])).rejects.toBe(refusal);
    expect(shared.sentWeight).toBe(0);
    expect(shared.paidWeight - shared.sentWeight).toBe(20);
  });

  it('returns all prepaid weight when every chunk is refused before provider dispatch', async () => {
    const refusal = new Error('shared admission refused');
    const shared = reader(async () => { throw refusal; });
    await shared.pay(360);
    await expect(shared.wave(bodies)).rejects.toBe(refusal);
    expect(shared.sentWeight).toBe(0);
    expect(shared.paidWeight - shared.sentWeight).toBe(360);
  });

  it('retains only the sent chunk when another chunk is refused before dispatch', async () => {
    const refusal = new Error('second chunk admission refused');
    const shared = reader(async (requests, onDispatch) => {
      if (requests.length === 2) throw refusal;
      onDispatch();
      return answers(requests);
    });
    await shared.pay(360);
    await expect(shared.wave(bodies)).rejects.toBe(refusal);
    expect(shared.sentWeight).toBe(320);
    expect(shared.paidWeight - shared.sentWeight).toBe(40);
  });

  it('waits for a late chunk before exposing a failure and its final refundable weight', async () => {
    const refusal = new Error('first chunk admission refused'), late = deferred(), entered = deferred();
    const shared = reader(async (requests, onDispatch) => {
      if (requests.length === 16) throw refusal;
      entered.resolve();
      await late.promise;
      onDispatch();
      return answers(requests);
    });
    await shared.pay(360);
    let finished = false;
    const wave = shared.wave(bodies).then(() => { finished = true; }, error => { finished = true; return error; });
    await entered.promise;
    // Drain the already-rejected chunk's promise chain without completing the late one.
    await new Promise<void>(resolve => setImmediate(resolve));
    const finishedBeforeLateDispatch = finished;
    late.resolve();
    expect(await wave).toBe(refusal);
    expect(finishedBeforeLateDispatch).toBe(false);
    expect(shared.sentWeight).toBe(40);
    expect(shared.paidWeight - shared.sentWeight).toBe(320);
  });

  it('does not refund any dispatched chunk when its HTTP request fails', async () => {
    const failure = new Error('provider disconnected after dispatch');
    const shared = reader(async (_requests, onDispatch) => { onDispatch(); throw failure; });
    await shared.pay(360);
    await expect(shared.wave(bodies)).rejects.toBe(failure);
    expect(shared.sentWeight).toBe(360);
    expect(shared.paidWeight - shared.sentWeight).toBe(0);
  });

  it('preserves the first observed refusal while waiting for another chunk to finish', async () => {
    const late = deferred(), entered = deferred();
    const firstRefusal = new Error('second chunk refused first'), lateRefusal = new Error('first chunk refused later');
    const shared = reader(async requests => {
      if (requests.length === 2) throw firstRefusal;
      entered.resolve();
      await late.promise;
      throw lateRefusal;
    });
    await shared.pay(360);
    const outcome = shared.wave(bodies).catch(error => error);
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    late.resolve();
    expect(await outcome).toBe(firstRefusal);
    expect(shared.sentWeight).toBe(0);
  });

  it('rereads the final wave and refunds its weight when that new dispatch is refused', async () => {
    let admitted = true;
    const refusal = new Error('final wave admission refused');
    const shared = reader(async (requests, onDispatch) => {
      if (!admitted) throw refusal;
      onDispatch();
      return answers(requests);
    });
    await shared.pay(80);
    await shared.wave(bodies.slice(0, 2));
    admitted = false;
    await expect(shared.unchanged(bodies.slice(0, 2), 'changed')).rejects.toBe(refusal);
    expect(shared.sentWeight).toBe(40);
    expect(shared.paidWeight - shared.sentWeight).toBe(40);
  });
});
