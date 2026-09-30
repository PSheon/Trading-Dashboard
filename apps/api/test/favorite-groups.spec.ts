import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  favoriteGroups,
  favoriteGroupMembers,
  userFavorites,
} from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import {
  FAVORITE_GROUP_COLORS,
  favoriteGroupSchema,
  favoriteGroupsSchema,
} from '@trading-dashboard/shared/contracts';
import { FavoriteGroupsController } from '../src/users/favorite-groups.controller.js';
import { FavoriteGroupsRepository } from '../src/users/favorite-groups.repository.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import {
  getTestDb,
  closeTestDb,
  truncateAll,
  insertUser,
} from './db-test-utils.js';
const db = getTestDb();
let app: INestApplication;
const address = '0x' + '12'.repeat(20);
beforeAll(async () => {
  await truncateAll(db);
  const a = await insertUser(db, { privyUserId: 'did:privy:groups-a' });
  await insertUser(db, { privyUserId: 'did:privy:groups-b' });
  await db
    .insert(userFavorites)
    .values({ userId: a.id, address, alertEnabled: true });
  ({ app } = await createAuthedApp({
    db,
    privy: stubPrivy({
      a: { privyUserId: 'did:privy:groups-a' },
      b: { privyUserId: 'did:privy:groups-b' },
    }),
    controllers: [FavoriteGroupsController],
    providers: [FavoriteGroupsRepository],
  }));
});
afterAll(async () => {
  await app?.close();
  await truncateAll(db);
  await closeTestDb();
});
it('isolates ownership, deduplicates members and preserves favorites/alerts when a group is removed', async () => {
  const http = app.getHttpServer();
  await request(http).get('/me/favorite-groups').expect(401);
  const created = await request(http)
    .post('/me/favorite-groups')
    .auth('a', { type: 'bearer' })
    .send({ name: '  Research  ' })
    .expect(201);
  const id = created.body.data.id;
  expect(created.body.data.name).toBe('Research');
  await request(http)
    .post('/me/favorite-groups')
    .auth('a', { type: 'bearer' })
    .send({ name: 'research' })
    .expect(409);
  for (const method of ['patch', 'delete'] as const)
    await request(http)
      [method](`/me/favorite-groups/${id}`)
      .auth('b', { type: 'bearer' })
      .send({ name: 'stolen' })
      .expect(404);
  await request(http)
    .put(`/me/favorite-groups/${id}/members/${address}`)
    .auth('b', { type: 'bearer' })
    .expect(404);
  for (let i = 0; i < 2; i++)
    await request(http)
      .put(`/me/favorite-groups/${id}/members/${address}`)
      .auth('a', { type: 'bearer' })
      .expect(204);
  const own = await request(http)
    .get('/me/favorite-groups')
    .auth('a', { type: 'bearer' })
    .expect(200);
  expect(own.body.data[0].addresses).toEqual([address]);
  expect(
    (
      await request(http)
        .get('/me/favorite-groups')
        .auth('b', { type: 'bearer' })
        .expect(200)
    ).body.data,
  ).toEqual([]);
  await request(http)
    .patch(`/me/favorite-groups/${id}`)
    .auth('a', { type: 'bearer' })
    .send({ name: 'Keep' })
    .expect(200);
  await request(http)
    .put(`/me/favorite-groups/${id}/members/0x${'34'.repeat(20)}`)
    .auth('a', { type: 'bearer' })
    .expect(404);
  await request(http)
    .delete(`/me/favorite-groups/${id}`)
    .auth('a', { type: 'bearer' })
    .expect(204);
  expect(await db.select().from(userFavorites)).toMatchObject([
    { address, alertEnabled: true },
  ]);
});
it('enforces name and count bounds under concurrent creates', async () => {
  const http = app.getHttpServer();
  await request(http)
    .post('/me/favorite-groups')
    .auth('b', { type: 'bearer' })
    .send({ name: '  ' })
    .expect(400);
  await request(http)
    .post('/me/favorite-groups')
    .auth('b', { type: 'bearer' })
    .send({ name: 'x'.repeat(41) })
    .expect(400);
  const responses = await Promise.all(
    Array.from({ length: 21 }, (_, i) =>
      request(http)
        .post('/me/favorite-groups')
        .auth('b', { type: 'bearer' })
        .send({ name: `Group ${i}` }),
    ),
  );
  expect(responses.filter((r) => r.status === 201)).toHaveLength(20);
  expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
});
it('allows multiple groups, enforces ownership in SQL and cascades only membership on unfavorite', async () => {
  const owner = await insertUser(db);
  const other = await insertUser(db);
  await db.insert(userFavorites).values([
    { userId: owner.id, address },
    { userId: other.id, address },
  ]);
  const repo = app.get(FavoriteGroupsRepository);
  const one = await repo.save(owner.id, { name: 'One' });
  const two = await repo.save(owner.id, { name: 'Two' });
  await repo.member(owner.id, one.id, address, true);
  await repo.member(owner.id, two.id, address, true);
  expect((await repo.list(owner.id)).map((g) => g.addresses)).toEqual([
    [address],
    [address],
  ]);
  await expect(
    db
      .insert(favoriteGroupMembers)
      .values({ userId: other.id, groupId: one.id, address }),
  ).rejects.toThrow();
  await repo.member(owner.id, one.id, address, false);
  expect((await repo.list(owner.id)).map((g) => g.addresses)).toEqual([
    [],
    [address],
  ]);
  await db.delete(userFavorites).where(eq(userFavorites.userId, owner.id));
  expect((await repo.list(owner.id)).map((g) => g.addresses)).toEqual([[], []]);
  expect(
    await db
      .select()
      .from(favoriteGroups)
      .where(eq(favoriteGroups.userId, owner.id)),
  ).toHaveLength(2);
});
it('assigns chip colours and order, recolours, reorders and lists in order (favorites page)', async () => {
  const user = await insertUser(db, { privyUserId: 'did:privy:groups-c' });
  await db.insert(userFavorites).values({ userId: user.id, address });
  const { app: appC } = await createAuthedApp({
    db,
    privy: stubPrivy({ c: { privyUserId: 'did:privy:groups-c' } }),
    controllers: [FavoriteGroupsController],
    providers: [FavoriteGroupsRepository],
  });
  try {
    const c = appC.getHttpServer();
    const first = favoriteGroupSchema.parse(
      (await request(c).post('/me/favorite-groups').auth('c', { type: 'bearer' }).send({ name: 'Whales' }).expect(201)).body.data,
    );
    expect(first).toMatchObject({ name: 'Whales', color: FAVORITE_GROUP_COLORS[0], sortOrder: 0, addresses: [] });
    const second = (
      await request(c).post('/me/favorite-groups').auth('c', { type: 'bearer' }).send({ name: 'Scalpers', color: '#123456' }).expect(201)
    ).body.data;
    expect(second).toMatchObject({ color: '#123456', sortOrder: 1 });
    await request(c).post('/me/favorite-groups').auth('c', { type: 'bearer' }).send({ name: 'Bad', color: 'red' }).expect(400);
    await request(c).post('/me/favorite-groups').auth('c', { type: 'bearer' }).send({ name: 'Bad', sortOrder: 1 }).expect(400);
    await request(c).patch(`/me/favorite-groups/${first.id}`).auth('c', { type: 'bearer' }).send({}).expect(400);
    // Recolour / reorder without renaming.
    const moved = (
      await request(c).patch(`/me/favorite-groups/${first.id}`).auth('c', { type: 'bearer' }).send({ sortOrder: 5, color: '#abcdef' }).expect(200)
    ).body.data;
    expect(moved).toMatchObject({ name: 'Whales', sortOrder: 5, color: '#abcdef' });
    await request(c).put(`/me/favorite-groups/${first.id}/members/${address}`).auth('c', { type: 'bearer' }).expect(204);
    const list = favoriteGroupsSchema.parse(
      (await request(c).get('/me/favorite-groups').auth('c', { type: 'bearer' }).expect(200)).body.data,
    );
    expect(list.map((g) => [g.name, g.addresses])).toEqual([
      ['Scalpers', []],
      ['Whales', [address]],
    ]);
    // A rename that only changes case is not a conflict with itself.
    await request(c).patch(`/me/favorite-groups/${first.id}`).auth('c', { type: 'bearer' }).send({ name: 'WHALES' }).expect(200);
    await request(c).patch(`/me/favorite-groups/${first.id}`).auth('c', { type: 'bearer' }).send({ name: 'scalpers' }).expect(409);
    // The 20-group limit reports its code and limit.
    for (let i = 0; i < 18; i++)
      await request(c).post('/me/favorite-groups').auth('c', { type: 'bearer' }).send({ name: `g${i}` }).expect(201);
    const over = await request(c).post('/me/favorite-groups').auth('c', { type: 'bearer' }).send({ name: 'one more' }).expect(409);
    expect(over.body.error).toMatchObject({ code: 'group_limit' });
  } finally {
    await appC.close();
  }
});
