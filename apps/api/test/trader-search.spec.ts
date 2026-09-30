import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { kolTraders, traderStats } from '@trading-dashboard/shared/database';
import { TraderSearchController } from '../src/traders/trader-search.controller.js';
import { TraderSearchRepository } from '../src/traders/trader-search.repository.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { getTestDb, closeTestDb, truncateAll } from './db-test-utils.js';
const db = getTestDb();
let app: INestApplication;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
beforeAll(async () => {
  await truncateAll(db);
  await db.insert(kolTraders).values([
    { address: addr(1), displayName: 'Alice Whale', xHandle: 'alice_hl' },
    { address: addr(2), displayName: 'Alice Research', xHandle: 'alice_r' },
    { address: addr(3), displayName: 'Literal %_ Name', xHandle: 'literal' },
  ]);
  await db
    .insert(traderStats)
    .values({
      address: addr(1),
      displayName: 'Old Alias',
      accountValue: '0',
      pnlDay: '0',
      pnlWeek: '0',
      pnlMonth: '0',
      pnlAllTime: '0',
      roiDay: '0',
      roiWeek: '0',
      roiMonth: '0',
      roiAllTime: '0',
      volumeDay: '0',
      volumeWeek: '0',
      volumeMonth: '0',
      volumeAllTime: '0',
      updatedAt: new Date(),
    });
  ({ app } = await createAuthedApp({
    db,
    privy: stubPrivy({}),
    controllers: [TraderSearchController],
    providers: [TraderSearchRepository],
  }));
});
afterAll(async () => {
  await app?.close();
  await truncateAll(db);
  await closeTestDb();
});
it('finds registered KOLs without leaderboard data and preserves literal search characters', async () => {
  const get = (q: string) =>
    request(app.getHttpServer()).get('/trader-search').query({ q });
  const result = await get('ALICE').expect(200);
  expect(
    result.body.data.items.map((r: { address: string }) => r.address),
  ).toEqual([addr(2), addr(1)]);
  expect(result.body.data.items).toMatchObject([
    { hasLeaderboardData: false, source: 'kol' },
    { displayName: 'Alice Whale', hasLeaderboardData: true },
  ]);
  expect((await get('@ALICE_HL').expect(200)).body.data.items).toHaveLength(1);
  expect((await get('Old Alias').expect(200)).body.data.items[0].address).toBe(
    addr(1),
  );
  expect(
    (await get('%_').expect(200)).body.data.items.map(
      (r: { address: string }) => r.address,
    ),
  ).toEqual([addr(3)]);
  await get('@').expect(400);
  await get('a'.repeat(65)).expect(400);
  expect((await get('unknown-person').expect(200)).body.data.items).toEqual([]);
});
it('bounds identity results and marks truncation without inventing financial data', async () => {
  await db
    .insert(kolTraders)
    .values(
      Array.from({ length: 23 }, (_, i) => ({
        address: addr(10 + i),
        displayName: 'Bounded ' + i,
      })),
    );
  const res = await request(app.getHttpServer())
    .get('/trader-search?q=Bounded')
    .expect(200);
  expect(res.body.data.items).toHaveLength(20);
  expect(res.body.data.hasMore).toBe(true);
  expect(res.body.data.items[0]).not.toHaveProperty('pnl');
});
