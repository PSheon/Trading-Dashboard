import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { copyFollowerActivitySchema } from '@trading-dashboard/shared/contracts';
import { copyExecutionAccounts, copyStrategies, copyFollowerLedger, copyFollowerReceipts, users } from '@trading-dashboard/shared/database';
import { CopyFollowerController } from '../src/copy/copy-follower.controller.js';
import { CopyFollowerStatementRepository } from '../src/copy/copy-follower-statement.repository.js';
import { CopyFollowerStatementService } from '../src/copy/copy-follower-statement.service.js';
import { CopyFollowerActivityRepository } from '../src/copy/copy-follower-activity.repository.js';
import { CopyFollowerActivityService } from '../src/copy/copy-follower-activity.service.js';
import { CopyFollowerLedger } from '../src/copy/live/copy-follower-ledger.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll } from './db-test-utils.js';
import type { AuthService } from '../src/common/auth/auth.service.js';
const db = getTestDb(), accountId = 'activity-account', address = `0x${'11'.repeat(20)}`, otherAddress = `0x${'22'.repeat(20)}`;
const privy = stubPrivy({ alice: { privyUserId: 'did:privy:activity-alice' }, bob: { privyUserId: 'did:privy:activity-bob' } });
let app: INestApplication, auth: AuthService, uid: number, ledger: CopyFollowerLedger;
const get = (query: Record<string, unknown> = {}, id = accountId, token: string | null = 'alice') => {
  const call = request(app.getHttpServer()).get(`/me/copy/execution-wallets/${id}/activity`).query(query); return token ? call.set('Authorization', `Bearer ${token}`) : call;
};
beforeAll(async () => {
  vi.stubEnv('AUTH_SERVICE_TOKEN', 'activity-service-token-0123456789012345');
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyFollowerController], providers: [CopyFollowerStatementService, CopyFollowerStatementRepository, CopyFollowerActivityService, CopyFollowerActivityRepository] }));
  ledger = new CopyFollowerLedger(db, new UnitOfWork(db));
});
beforeEach(async () => {
  await truncateAll(db); auth.clearCache(); uid = (await insertUser(db, { privyUserId: 'did:privy:activity-alice' })).id;
  await insertUser(db, { privyUserId: 'did:privy:activity-bob' });
  const strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: otherAddress, allocated: '100', cash: '100', activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: 'testnet', privyUserId: 'did:privy:activity-alice', externalId: 'private-provider-id', state: 'ready', address, privyWalletId: 'private-wallet', ownerQuorumId: 'private-quorum' });
});
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });
const funding = (n: number, time: number, amount = '-0.000000000000000001') => ({ hash: `0x${n.toString(16).padStart(64, '0')}`, time, delta: { type: 'funding', coin: 'BTC', usdc: amount } });

it('reads only an enabled owner and hides foreign money and metadata', async () => {
  for (const token of [null, 'invalid', 'activity-service-token-0123456789012345']) await get({}, accountId, token).expect(token?.startsWith('activity-service') ? 403 : 401);
  const response = await get({}, accountId, 'bob').expect(404); expect(JSON.stringify(response.body)).not.toContain(address);
  await get({}, 'missing').expect(404); await get().expect(200); await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid)); await get().expect(401);
});
it('returns actual empty booked history without equity, ROI, secrets or a completeness claim', async () => {
  const response = await get().expect(200).expect('Cache-Control', 'no-store'), page = copyFollowerActivitySchema.parse(response.body.data);
  expect(page).toMatchObject({ mode: 'actual', items: [], hasMore: false, previousCursor: null, coverage: { historicalCompleteness: 'unproven', scannedThrough: null, unresolvedWindows: null } });
  expect(JSON.stringify(response.body)).not.toMatch(/equity|roi|private-provider|did:privy|"raw"/);
});
it('paginates tied exchange timestamps without duplicates using exact receipt keys and account-bound cursors', async () => {
  const time = Date.now() - 1000; for (const n of [1, 2, 3]) await ledger.bookFunding(accountId, funding(n, time));
  const first = copyFollowerActivitySchema.parse((await get({ limit: 2 }).expect(200)).body.data);
  expect(first.items.map(r => r.kind === 'funding' ? r.hash : '')).toEqual([`0x${'3'.padStart(64, '0')}`, `0x${'2'.padStart(64, '0')}`]); expect(first.hasMore).toBe(true);
  const second = copyFollowerActivitySchema.parse((await get({ limit: 2, before: first.previousCursor }).expect(200)).body.data);
  expect(second.items).toHaveLength(1); expect(second.hasMore).toBe(false); expect(second.items[0].tradingCashDelta).toBe('-0.000000000000000001');
  expect(new Set([...first.items, ...second.items].map(r => r.key)).size).toBe(3);
  await db.insert(copyExecutionAccounts).values({ id: 'other-account', userId: uid, strategyId: first.strategyId, network: 'mainnet', privyUserId: 'did:privy:activity-alice', externalId: 'other', state: 'ready', address: otherAddress, privyWalletId: 'other-wallet', ownerQuorumId: 'other-quorum' });
  await get({ before: first.previousCursor }, 'other-account').expect(400);
  await db.update(copyExecutionAccounts).set({ address: `0x${'33'.repeat(20)}` }).where(eq(copyExecutionAccounts.id, accountId)); await get({ before: first.previousCursor }).expect(400);
});
it('makes late old-timestamp receipts visible on a first-page read without claiming forward replay', async () => {
  const time = Date.now() - 10000; await ledger.bookFunding(accountId, funding(1, time)); await get().expect(200);
  await ledger.bookFunding(accountId, funding(2, time - 1000));
  const page = copyFollowerActivitySchema.parse((await get().expect(200)).body.data); expect(page.items).toHaveLength(2); expect(page.items[1].time).toBe(new Date(time - 1000).toISOString());
  await get({ after: '0' }).expect(400);
});
it('shows mainnet booked receipts after stop without borrowing testnet or paper equity', async () => {
  await db.update(copyExecutionAccounts).set({ network: 'mainnet' }).where(eq(copyExecutionAccounts.id, accountId)); await ledger.bookFunding(accountId, funding(1, Date.now() - 1000, '0.25'));
  await db.update(copyStrategies).set({ status: 'stopped', stoppedAt: new Date() }).where(eq(copyStrategies.userId, uid));
  const page = copyFollowerActivitySchema.parse((await get().expect(200)).body.data); expect(page.network).toBe('mainnet'); expect(page.items[0].tradingCashDelta).toBe('0.25');
});
it('never silently fills missing booked fees with zero and redacts invalid persisted evidence', async () => {
  await ledger.bookFill(accountId, { coin: 'BTC', tid: 1, oid: 7, side: 'B', time: Date.now() - 1000, px: '100', sz: '1', closedPnl: '2', fee: '0.06', builderFee: '0.02', feeToken: 'USDC', secret: 'private-provider-material' });
  let response = await get().expect(200); expect(response.body.data.items[0]).toMatchObject({ exchangeFee: '-0.04', builderFee: '-0.02', tradingCashDelta: '1.94' }); expect(JSON.stringify(response.body)).not.toContain('private-provider-material');
  await db.delete(copyFollowerLedger).where(eq(copyFollowerLedger.component, 'builder_fee'));
  response = await get().expect(503); expect(JSON.stringify(response.body)).not.toMatch(/private-provider-material|"raw"|"record"/); expect(response.body).not.toHaveProperty('data.items');
  expect(await db.select().from(copyFollowerReceipts)).toHaveLength(1);
});
it.each(['exchange_fee', 'builder_fee', 'funding'] as const)('reads canonical zero %s from intentional sparse booking and redacts tampered evidence', async component => {
  if (component === 'funding') await ledger.bookFunding(accountId, funding(1, Date.now() - 1000, '0'));
  else await ledger.bookFill(accountId, { coin: 'BTC', tid: 1, oid: 7, side: 'B', time: Date.now() - 1000, px: '100', sz: '1', closedPnl: '0', fee: '0', builderFee: '0', feeToken: 'USDC', secret: 'private-provider-material' });
  await get().expect(200); await db.delete(copyFollowerLedger).where(eq(copyFollowerLedger.component, component));
  const valid = await get().expect(200); expect(valid.body.data.items[0].tradingCashDelta).toBe('0');
  const [stored] = await db.select().from(copyFollowerReceipts);
  await db.update(copyFollowerReceipts).set({ record: { ...stored.record, raw: { altered: 'private-provider-material' } } }).where(eq(copyFollowerReceipts.key, stored.key));
  const response = await get().expect(503); expect(JSON.stringify(response.body)).not.toMatch(/private-provider-material|"raw"|"record"/); expect(response.body).not.toHaveProperty('data.items');
});
it.each([{ limit: 51 }, { limit: 0 }, { before: 'not_base64_valid_json' }, { before: 'x'.repeat(2049) }, { userId: 1 }])('refuses malformed, unbounded or ownership-overriding query %j', async query => { await get(query).expect(400); });
