// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { createLiveSetupJournal } from '@/lib/copy-live-setup';

const request = 'a'.repeat(64), key = 'original-request-key-0001';
const setupId = '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c';
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
it('a freshly created journal recovers only original opaque request and setup identifiers after reload', () => {
  const disk = storage(), first = createLiveSetupJournal('owner#1', disk);
  first.save({ request, key, setupId, network: 'testnet', confirmationPending: true });
  const reloaded = createLiveSetupJournal('owner#1', disk);
  expect(reloaded.find(request)).toEqual({ request, key, setupId, network: 'testnet', confirmationPending: true });
  expect([...disk.data.values()].join('')).not.toMatch(/signature|consent|token|settings|budget|leaderAddress/);
});
it('different owners and authentication modes cannot recover another journal’s request', () => {
  const disk = storage();
  createLiveSetupJournal('privy:alice', disk).save({ request, key, setupId, network: 'testnet', confirmationPending: false });
  expect(createLiveSetupJournal('privy:bob', disk).find(request)).toBeUndefined();
  expect(createLiveSetupJournal('fixture:alice', disk).find(request)).toBeUndefined();
});
it('clearing a completed attempt survives reload and leaves other original requests intact', () => {
  const disk = storage(), journal = createLiveSetupJournal('owner#1', disk);
  journal.save({ request, key, setupId, network: 'testnet', confirmationPending: false });
  journal.save({ request: 'b'.repeat(64), key: 'other-request-key-0001', setupId: null, network: null, confirmationPending: false });
  journal.forget(request);
  const reloaded = createLiveSetupJournal('owner#1', disk);
  expect(reloaded.find(request)).toBeUndefined();
  expect(reloaded.find('b'.repeat(64))?.key).toBe('other-request-key-0001');
});
it('blocked or corrupted recovery storage fails before a new operation can be admitted', () => {
  const blocked = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
  expect(() => createLiveSetupJournal('owner#1', blocked).save({ request, key, setupId: null, network: null, confirmationPending: false })).toThrow('setup_recovery_unavailable');
  const corrupted = { getItem: () => '{broken', setItem() {} };
  expect(() => createLiveSetupJournal('owner#1', corrupted).find(request)).toThrow('setup_recovery_unavailable');
});
