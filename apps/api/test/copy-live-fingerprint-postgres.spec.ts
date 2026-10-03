import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { copyLiveExecutions } from '@trading-dashboard/shared/database';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';
import { fixture, now } from './copy-live-risk-test-utils.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { PostgresLiveExecutionJournal } from '../src/copy/live/postgres-live-journal.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { AccountRiskExecutionGate } from '../src/copy/live/account-risk-execution-gate.js';
import { assertLiveExecutionReady, assertLiveExecutionPermit } from '../src/copy/live/live-execution-gate.js';
import type { WalletAuthorization } from '../src/copy/live/wallet-authorization.js';
import type { LiveAccountRiskInput } from '../src/copy/live/live-account-risk.js';

let db: TestDb, pool: Pool, journal: PostgresLiveExecutionJournal, proof: LiveAccountRiskInput;
beforeAll(() => {
  db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  journal = new PostgresLiveExecutionJournal(db, pool, new UnitOfWork(db));
});
beforeEach(async () => {
  await truncateAll(db);
  const user = await insertUser(db); expect(user.id).toBe(1); proof = fixture();
});
afterAll(async () => { await pool?.end(); await closeTestDb(); });
async function prepare() {
  const authorization: WalletAuthorization = { id: 'grant', version: 4, userId: 1, strategyId: 9, walletId: 'agent', privyOwnerId: 'owner',
    accountAddress: proof.intent.accountAddress, signerAddress: `0x${'33'.repeat(20)}`, network: 'testnet',
    scopes: ['copy:trade', 'copy:reduce'], validFrom: now - 1, expiresAt: now + 60000, revokedAt: null, exchangeApprovedAt: now - 1 };
  return journal.prepare({ key: proof.reservations.own.key, fingerprint: proof.reservations.own.fingerprint,
    action: proof.action, market: proof.market, authorization, now });
}
it('passes real JSONB journal actions through both risk-gate phases without changing the original fingerprint', async () => {
  const prepared = await prepare(), persisted = (await journal.get(prepared.key))!;
  expect(persisted.action).toEqual(proof.action);
  expect(JSON.stringify(persisted.action)).not.toBe(JSON.stringify(proof.action));
  await new PostgresLiveRiskScope(pool, () => now).run({ userId: 1, network: 'testnet', accountAddress: proof.intent.accountAddress }, async scope => {
    // Public synthetic proofs test binding only; they are not provider money/ownership evidence.
    const gate = new AccountRiskExecutionGate({ read: async () => {
      await scope.assertHeld(); return { proof: structuredClone(proof), assertHeld: scope.assertFresh };
    } }, () => now);
    await journal.withOrderLock(prepared.key, async lease => {
      const sign = await assertLiveExecutionReady(gate, lease, 'sign', proof.intent, persisted);
      expect(sign.fingerprint).toBe(prepared.fingerprint);
      assertLiveExecutionPermit(sign, 'sign', proof.intent, persisted);
      await journal.save({ ...persisted, state: 'submitting' });
      const submitting = (await journal.get(prepared.key))!;
      const submit = await assertLiveExecutionReady(gate, lease, 'submit', proof.intent, submitting);
      expect(submit.fingerprint).toBe(prepared.fingerprint);
      assertLiveExecutionPermit(submit, 'submit', proof.intent, submitting);
    });
  });
});
it('still refuses a changed persisted action before returning a risk permit', async () => {
  const prepared = await prepare();
  const changed = structuredClone(prepared); changed.action.orders[0].s = '2';
  await db.update(copyLiveExecutions).set({ record: changed as unknown as Record<string, unknown> }).where(eq(copyLiveExecutions.key, prepared.key));
  const persisted = (await journal.get(prepared.key))!;
  const gate = new AccountRiskExecutionGate({ read: async () => ({ proof: structuredClone(proof), assertHeld: () => {} }) }, () => now);
  await expect(gate.assertReady({ phase: 'sign', intent: proof.intent, record: persisted })).rejects.toThrow('live_risk_record_mismatch');
});
