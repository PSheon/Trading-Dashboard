import type { INestApplication } from "@nestjs/common";
import { copyExecutionAccounts, copyFundingOperations, copyLedger, copyStrategies, users, walletWithdrawals } from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import { CopyFundsController } from "../src/copy/copy-funds.controller.js";
import { CopyFundsService } from "../src/copy/copy-funds.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const LEADER = "0x" + "a1".repeat(20);
const HUB = "0x" + "c3".repeat(20);
const COPY_WALLET = "0x" + "d4".repeat(20);
const DAY = 86_400_000;

describe("GET /me/funds/history: one money-flow history of copies, fees, funding and hub withdrawals", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": { privyUserId: "did:privy:alice" },
    "bob-token": { privyUserId: "did:privy:bob" },
  });
  let app: INestApplication;
  let auth: AuthService;
  beforeAll(async () => {
    ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyFundsController], providers: [CopyFundsService] }));
  });
  beforeEach(async () => { await truncateAll(db); auth.clearCache(); });
  afterAll(async () => { await app.close(); await closeTestDb(); });

  const get = (path: string, token?: string) => {
    const r = request(app.getHttpServer()).get(path);
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };
  async function userId(token: string, did: string) {
    await get("/me/funds/history", token).expect(200);
    return (await db.select().from(users).where(eq(users.privyUserId, did)))[0]!.id;
  }

  it("lists copy transfers, per-day fees and funding, hub-to-copy funding and hub withdrawals, newest first, the owner's only, paged without splitting a millisecond", async () => {
    await get("/me/funds/history").expect(401);
    const alice = await userId("alice-token", "did:privy:alice");
    const bob = await userId("bob-token", "did:privy:bob");
    const base = Date.UTC(2026, 9, 1, 10);
    const [s] = await db.insert(copyStrategies).values({ userId: alice, leaderAddress: LEADER, allocated: "1000", cash: "0", status: "stopped", activatedAt: new Date(base), createdAt: new Date(base), stoppedAt: new Date(base + 2 * DAY) }).returning();
    const [other] = await db.insert(copyStrategies).values({ userId: bob, leaderAddress: LEADER, allocated: "500", cash: "500", activatedAt: new Date(base), createdAt: new Date(base) }).returning();
    const at = (ms: number) => new Date(base + ms);
    await db.insert(copyLedger).values([
      { strategyId: s!.id, userId: alice, kind: "allocate", amount: "1000", createdAt: at(0) },
      { strategyId: s!.id, userId: alice, kind: "realized_pnl", amount: "12", coin: "BTC", orderId: 1n, createdAt: at(60_000) },
      { strategyId: s!.id, userId: alice, kind: "fee", amount: "-0.45", coin: "BTC", orderId: 1n, createdAt: at(60_000) },
      { strategyId: s!.id, userId: alice, kind: "builder_fee", amount: "-0.1", coin: "BTC", orderId: 1n, createdAt: at(60_000) },
      { strategyId: s!.id, userId: alice, kind: "fee", amount: "-0.3", coin: "ETH", orderId: 2n, createdAt: at(3_600_000) },
      { strategyId: s!.id, userId: alice, kind: "funding", amount: "-0.2", coin: "BTC", createdAt: at(4_000_000) },
      { strategyId: s!.id, userId: alice, kind: "fee", amount: "-0.25", coin: "BTC", orderId: 3n, createdAt: at(DAY) },
      { strategyId: s!.id, userId: alice, kind: "withdraw", amount: "-200", createdAt: at(DAY + 1000) },
      { strategyId: s!.id, userId: alice, kind: "liquidation", amount: "5", createdAt: at(2 * DAY - 1000) },
      { strategyId: s!.id, userId: alice, kind: "release", amount: "-810", createdAt: at(2 * DAY) },
      { strategyId: other!.id, userId: bob, kind: "allocate", amount: "500", createdAt: at(0) },
    ]);
    const [account] = await db.insert(copyExecutionAccounts).values({ id: randomUUID(), userId: alice, strategyId: s!.id, network: "testnet", privyUserId: "did:privy:alice", externalId: randomUUID() }).returning();
    await db.insert(copyFundingOperations).values({
      id: randomUUID(), userId: alice, accountId: account!.id, strategyId: s!.id, idempotencyKey: randomUUID(), network: "testnet", address: HUB, destination: COPY_WALLET,
      amount: "100", nonce: 1, status: "credited", evidenceHash: "a".repeat(64), transactionHash: `0x${"b".repeat(64)}`, creditedAmount: "99.5", fee: "0.5", createdAt: at(3 * DAY),
    });
    await db.insert(walletWithdrawals).values({ id: randomUUID(), userId: alice, network: "testnet", address: HUB, destination: "0x" + "e5".repeat(20), amount: "25", nonce: 9, status: "accepted", origin: "client", evidenceHash: "c".repeat(64), createdAt: at(4 * DAY) });

    const page = (await get("/me/funds/history", "alice-token").expect(200)).body.data;
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i: { kind: string }) => i.kind)).toEqual([
      "hub_withdrawal", "copy_funding", "copy_sweep", "copy_write_off", "copy_withdrawal", "fees", "funding", "fees", "copy_deposit",
    ]);
    const by = (kind: string) => page.items.filter((i: { kind: string }) => i.kind === kind);
    expect(by("hub_withdrawal")[0]).toMatchObject({ mode: "testnet", amount: -25, status: "accepted", strategyId: null });
    expect(by("copy_funding")[0]).toMatchObject({ mode: "testnet", amount: 100, fee: 0.5, status: "credited", txHash: `0x${"b".repeat(64)}`, counterparty: COPY_WALLET, strategyId: s!.id, leaderAddress: LEADER });
    expect(by("copy_deposit")[0]).toMatchObject({ mode: "paper", amount: 1000, strategyId: s!.id, counterparty: "paper" });
    expect(by("copy_withdrawal")[0]).toMatchObject({ amount: -200 });
    expect(by("copy_sweep")[0]).toMatchObject({ amount: -810 });
    expect(by("copy_write_off")[0]).toMatchObject({ amount: 5 });
    // Day 1: two orders' fees (0.45 + 0.1 + 0.3), day 2: one; funding apart. Realized PnL is not a money flow.
    expect(by("fees").map((f: { amount: number; count: number }) => [f.amount, f.count])).toEqual([[-0.25, 1], [-0.85, 2]]);
    expect(by("funding")[0]).toMatchObject({ amount: -0.2 });
    expect(page.items.some((i: { amount: number }) => i.amount === 500)).toBe(false);

    // Paged: 3 at a time, following the cursor, nothing repeated or lost.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const body: { items: Array<{ id: string }>; nextCursor: string | null } = (await get(`/me/funds/history?limit=3${cursor ? `&before=${cursor}` : ""}`, "alice-token").expect(200)).body.data;
      seen.push(...body.items.map((i: { id: string }) => i.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(page.items.map((i: { id: string }) => i.id));
    expect((await get("/me/funds/history", "bob-token").expect(200)).body.data.items.map((i: { amount: number }) => i.amount)).toEqual([500]);
    await get("/me/funds/history?limit=0", "alice-token").expect(400);
    await get("/me/funds/history?before=abc", "alice-token").expect(400);
  });
});
