import { Controller, Get, type INestApplication } from "@nestjs/common";
import { EventEmitter2, EventEmitterModule } from "@nestjs/event-emitter";
import { actions, leaders, userFavorites, users, wireActionSchema } from "@trading-dashboard/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACTION_STREAM_OPTIONS, ActionStreamService, clientAddress } from "../src/api/actions/action-stream.service.js";
import { ActionsController } from "../src/api/actions/actions.controller.js";
import { ActionsService } from "../src/api/actions/actions.service.js";
import { Public } from "../src/common/auth/public.decorator.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";
import { requestContext } from "../src/runtime/request-middleware.js";
import { FAVORITES_CHANGED_EVENT } from "../src/users/favorites.service.js";
import { ACTION_CORRECTED_EVENT, ACTION_CREATED_EVENT } from "../src/watcher/action-created.event.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";
import { openSse, type SseConnection } from "./sse-test-client.js";

const WHALE = "0x" + "aa".repeat(20);
const OTHER = "0x" + "bb".repeat(20);
const DEADLINE_MS = 300;

/** A normal route, to show the deadline the stream is exempt from. */
@Public()
@Controller("probe")
class SlowProbeController {
  @Get("slow")
  async slow() {
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 3));
    return { late: true };
  }
}

describe("GET /actions/stream (SSE) — real Postgres", () => {
  const db = getTestDb();
  const privy = stubPrivy({ "alice-token": { privyUserId: "did:privy:alice" } });
  const jobs = new BackgroundJobs();
  let app: INestApplication;
  let streams: ActionStreamService;
  let events: EventEmitter2;
  let base: string;
  const open: SseConnection[] = [];

  const sse = async (path: string, headers: Record<string, string> = {}) => {
    const conn = await openSse(`${base}${path}`, headers);
    open.push(conn);
    return conn;
  };
  const row = (overrides: Partial<typeof actions.$inferInsert> = {}) => ({
    address: WHALE, coin: "BTC", kind: "open" as const, side: "long", notionalUsd: "1000.5", avgPx: "65000",
    leverage: "10", fillIds: [9007199254740993n], ts: new Date(), ...overrides,
  });
  /** Inserts rows and emits `action.created` for them, like the watcher. */
  const create = async (...values: Array<ReturnType<typeof row>>) => {
    const rows = await db.insert(actions).values(values).returning();
    for (const r of rows) events.emit(ACTION_CREATED_EVENT, r);
    await streams.settled();
    return rows;
  };
  const waitUntil = async (check: () => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("condition not met");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const ready = (conn: SseConnection) => conn.waitFor((f) => f.some((x) => x.comments.includes("ok")));

  beforeAll(async () => {
    ({ app } = await createAuthedApp({
      db,
      privy,
      imports: [EventEmitterModule.forRoot()],
      controllers: [ActionsController, SlowProbeController],
      providers: [
        ActionsService,
        ActionStreamService,
        { provide: BackgroundJobs, useValue: jobs },
        {
          provide: ACTION_STREAM_OPTIONS,
          useValue: { heartbeatMs: 100, maxPerIp: 3, maxTotal: 5, trustedProxyHops: 1, replayLimit: 5, replayWindowMs: 60 * 60_000 },
        },
      ],
      // main.ts's middleware, with a short deadline.
      beforeListen: (a) => a.use(requestContext(jobs, DEADLINE_MS)),
    }));
    streams = app.get(ActionStreamService);
    events = app.get(EventEmitter2);
    const address = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    for (const conn of open.splice(0)) conn.close();
    await waitUntil(() => streams.stats().total === 0);
    await truncateAll(db);
    await db.insert(leaders).values([{ address: WHALE, tier: "A", label: "Whale" }, { address: OTHER, tier: "C" }]);
  });

  afterAll(async () => {
    for (const conn of open) conn.close();
    await app?.close();
    await closeTestDb();
  });

  it("pushes each new action as the /actions feed shapes it, filtered by address, coin and kind", async () => {
    const all = await sse("/actions/stream");
    expect(all.status).toBe(200);
    expect(all.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(all.headers.get("cache-control")).toContain("no-cache");
    const byAddress = await sse(`/actions/stream?address=0x${"AA".repeat(20)}`);
    const eth = await sse("/actions/stream?coin=ETH");
    const closes = await sse("/actions/stream?kind=close&tier=C", { "x-forwarded-for": "10.0.0.2" });
    await Promise.all([all, byAddress, eth, closes].map(ready));

    const [btc, ethRow, close] = await create(row(), row({ coin: "ETH", address: OTHER }), row({ address: OTHER, kind: "close", side: "short" }));
    await all.waitFor(() => all.events("action").length === 3);
    const rest = (await request(app.getHttpServer()).get("/actions").expect(200)).body as unknown[];
    // Byte-for-byte the REST row (same mapper and leader join), and valid wire.
    expect(all.events("action").map((e) => e.data)).toEqual([...rest].reverse());
    expect(wireActionSchema.parse(all.events("action")[0].data)).toMatchObject({ id: String(btc.id), leaderLabel: "Whale", leaderTier: "A", fillIds: ["9007199254740993"] });
    expect(all.events("action").map((e) => e.id)).toEqual([btc, ethRow, close].map((r) => String(r.id)));

    await byAddress.waitFor(() => byAddress.events().length >= 1);
    await eth.waitFor(() => eth.events().length >= 1);
    await closes.waitFor(() => closes.events().length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(byAddress.events().map((e) => e.id)).toEqual([String(btc.id)]);
    expect(eth.events().map((e) => e.id)).toEqual([String(ethRow.id)]);
    expect(closes.events().map((e) => e.id)).toEqual([String(close.id)]);
  });

  it("sends a slow-path correction as an update event without moving the resume cursor", async () => {
    const opens = await sse("/actions/stream?kind=open");
    await ready(opens);
    const [created] = await create(row());
    await opens.waitFor(() => opens.events("action").length === 1);

    const [fixed] = await db.update(actions).set({ kind: "reduce", side: "short" }).where(eq(actions.id, created.id)).returning();
    events.emit(ACTION_CORRECTED_EVENT, { updated: [fixed], inserted: [] });
    await streams.settled();
    await opens.waitFor(() => opens.events("update").length === 1);
    const update = opens.events("update")[0];
    expect(update.id).toBeUndefined();
    expect(update.data).toMatchObject({ id: String(created.id), kind: "reduce", side: "short" });
  });

  it("filters a favorites stream by the caller's favorites and follows changes to them", async () => {
    const anonymous = await sse("/actions/stream?scope=favorites");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toMatchObject({ statusCode: 401 });

    await request(app.getHttpServer()).get("/actions").set("Authorization", "Bearer alice-token").expect(200);
    const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
    await db.insert(userFavorites).values({ userId: alice.id, address: WHALE });

    const mine = await sse("/actions/stream?scope=favorites", { Authorization: "Bearer alice-token" });
    expect(mine.status).toBe(200);
    await ready(mine);
    const [whale] = await create(row(), row({ address: OTHER }));
    await mine.waitFor(() => mine.events().length === 1);

    await db.insert(userFavorites).values({ userId: alice.id, address: OTHER });
    await (events.emitAsync(FAVORITES_CHANGED_EVENT, { userId: alice.id }));
    const [other] = await create(row({ address: OTHER }));
    await mine.waitFor(() => mine.events().length === 2);
    expect(mine.events().map((e) => e.id)).toEqual([String(whale.id), String(other.id)]);
  });

  it("sends a heartbeat comment", async () => {
    const conn = await sse("/actions/stream");
    await conn.waitFor((f) => f.filter((x) => x.comments.includes("hb")).length >= 2, 1000);
  });

  it("replays actions after Last-Event-ID, newest 200 at most, and says when it truncated", async () => {
    const rows = await db.insert(actions).values([
      row({ ts: new Date(Date.now() - 2 * 60 * 60_000) }), // older than the replay window
      ...Array.from({ length: 4 }, () => row()),
    ]).returning();
    const conn = await sse("/actions/stream", { "Last-Event-ID": String(rows[1].id) });
    await conn.waitFor(() => conn.events("action").length === 3);
    expect(conn.events("reset")).toEqual([]);
    expect(conn.events("action").map((e) => e.id)).toEqual(rows.slice(2).map((r) => String(r.id)));

    // Live events after the replay continue from there, without duplicates.
    const [live] = await create(row());
    await conn.waitFor(() => conn.events("action").length === 4);
    expect(conn.events("action").at(-1)?.id).toBe(String(live.id));

    // More missed rows than the bound (5 here; 200 in production).
    const more = await db.insert(actions).values(Array.from({ length: 8 }, () => row())).returning();
    const gap = await sse("/actions/stream", { "Last-Event-ID": String(rows[0].id), "x-forwarded-for": "10.0.0.3" });
    await gap.waitFor(() => gap.events("action").length === 5);
    expect(gap.events("reset")).toEqual([{ event: "reset", id: undefined, data: { reason: "replay_truncated" } }]);
    expect(gap.events("action").map((e) => e.id)).toEqual(more.slice(-5).map((r) => String(r.id)));

    expect((await sse("/actions/stream", { "Last-Event-ID": "abc" })).status).toBe(400);
  });

  it("answers 429 over the per-IP and the global limit", async () => {
    const first = await Promise.all([1, 2, 3].map(() => sse("/actions/stream", { "x-forwarded-for": "10.0.0.1" })));
    expect(first.map((c) => c.status)).toEqual([200, 200, 200]);
    const perIp = await sse("/actions/stream", { "x-forwarded-for": "10.0.0.1" });
    expect(perIp.status).toBe(429);
    expect(perIp.headers.get("retry-after")).toBe("30");
    expect(perIp.body).toMatchObject({ code: "rate_limited", limit: "ip" });

    const second = await Promise.all([1, 2].map(() => sse("/actions/stream", { "x-forwarded-for": "10.0.0.9" })));
    expect(second.map((c) => c.status)).toEqual([200, 200]);
    const global = await sse("/actions/stream", { "x-forwarded-for": "10.0.0.7" });
    expect(global.status).toBe(429);
    expect(global.body).toMatchObject({ limit: "total" });
    expect(streams.stats()).toEqual({ total: 5, perIp: { "10.0.0.1": 3, "10.0.0.9": 2 } });

    // Freed slots are reusable.
    first[0].close();
    await waitUntil(() => streams.stats().total === 4);
    expect((await sse("/actions/stream", { "x-forwarded-for": "10.0.0.7" })).status).toBe(200);
  });

  it("cleans up when the client disconnects", async () => {
    const conns = await Promise.all([1, 2].map(() => sse("/actions/stream?coin=BTC")));
    await Promise.all(conns.map(ready));
    expect(streams.stats().total).toBe(2);
    for (const c of conns) c.close();
    await waitUntil(() => streams.stats().total === 0);
    expect(streams.stats().perIp).toEqual({});
    // Nothing is written to (or looked up for) a closed stream.
    await create(row());
  });

  it("is exempt from the request deadline that ends other routes", async () => {
    await request(app.getHttpServer()).get("/probe/slow").expect(504);
    const conn = await sse("/actions/stream");
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 3));
    const [late] = await create(row());
    await conn.waitFor(() => conn.events("action").some((e) => e.id === String(late.id)));
    expect(streams.stats().total).toBe(1);
  });

  it("identifies the client through the trusted proxy hops only", () => {
    const req = (xff: string | undefined, peer = "::ffff:127.0.0.1") =>
      ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: peer } }) as never;
    expect(clientAddress(req("1.2.3.4"), 0)).toBe("127.0.0.1");
    expect(clientAddress(req("6.6.6.6, 1.2.3.4"), 1)).toBe("1.2.3.4");
    expect(clientAddress(req("6.6.6.6, 1.2.3.4, 10.0.0.5"), 2)).toBe("1.2.3.4");
    expect(clientAddress(req(undefined), 2)).toBe("127.0.0.1");
    expect(clientAddress(req("not-an-ip"), 1)).toBe("::ffff:127.0.0.1");
  });

  // Last: stops the shared BackgroundJobs.
  it("ends every open stream when shutdown starts, and refuses new ones", async () => {
    const conns = await Promise.all([1, 2].map(() => sse("/actions/stream")));
    await Promise.all(conns.map(ready));
    jobs.stop();
    await Promise.all(conns.map((c) => c.ended));
    expect(streams.stats().total).toBe(0);
    expect((await sse("/actions/stream")).status).toBe(503);
  });
});
