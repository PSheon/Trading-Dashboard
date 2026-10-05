import { ServiceUnavailableException, type INestApplication } from "@nestjs/common";
import { publicHealthSchema } from "@trading-dashboard/shared/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HealthController } from "../src/api/health/health.controller.js";
import { HealthService } from "../src/api/health/health.service.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const WATCHED = "0x" + "ab".repeat(20);
/** A heartbeat as the worker reports it, with every operational field set. */
const full = (feedConnected = true) => ({
  feedConnected, feedSocketsOpen: feedConnected ? 2 : 0, feedSocketsTotal: 2, marketsSubscribed: 329, feedDisconnectedSince: feedConnected ? null : new Date(),
  lastTradeAt: new Date(), lastFillAt: new Date(), lastSnapshotAt: new Date(), lastSnapshotAttemptAt: new Date(), lastSnapshotFailureAt: null, lastSweepAt: new Date(),
  requestsLastMinute: 38, weightLastMinute: 737, queuedRequests: { live: 1, background: 14 },
  budget: { effectivePerMin: 840, pageWeightLastMinute: 120, reserveTokens: 50, reserveCapacity: 210, backgroundFactor: 0.8, consumers: { pool: 240, history: 120 } },
  discovery: { visibleRows: 180, medianVisibleAgeSeconds: 60, oldestVisibleAgeSeconds: 600, poolRows: 1000, poolReady: 950, medianPoolAgeSeconds: 300, oldestPoolAgeSeconds: 3600 },
  fillsUnavailable: [{ address: WATCHED, missedTrades: 4, since: new Date() }],
  dryRun: true,
  archive: { enabled: true, liveNextHour: new Date(), backfillCursorHour: null, lagSeconds: 5400, objects: 10, bytes: 123456, fillsSeen: 9000, fillsKept: 40, spendDayBytes: 1000, spendDayUsd: 0.1234, maxDailyUsd: 2,
    addresses: { total: 12, backfilled: 10, pending: 2, excluded: 0 }, lastObjectKey: "node_fills_by_block/hourly/20261002/7.lz4", lastRunAt: new Date(), lastError: null },
  now: new Date(),
});

describe("GET /health says only what a status check needs (review finding 36)", () => {
  const db = getTestDb();
  const heartbeat = vi.fn(async () => full());
  let app: INestApplication;
  let auth: AuthService;
  const get = (path: string, token?: string) => {
    const r = request(app.getHttpServer()).get(path);
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };

  beforeAll(async () => {
    ({ app, auth } = await createAuthedApp({
      db,
      privy: stubPrivy({ "admin-token": { privyUserId: "did:privy:h-admin" }, "operator-token": { privyUserId: "did:privy:h-operator" }, "user-token": { privyUserId: "did:privy:h-user" } }),
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { heartbeat } }],
    }));
  });
  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
    await insertUser(db, { privyUserId: "did:privy:h-admin", role: "admin" });
    await insertUser(db, { privyUserId: "did:privy:h-operator", role: "operator" });
    await insertUser(db, { privyUserId: "did:privy:h-user" });
    heartbeat.mockClear();
    // Each test gets a fresh one-second window.
    await new Promise((resolve) => setTimeout(resolve, 1050));
  });
  afterAll(async () => { await app.close(); await truncateAll(db); await closeTestDb(); });

  it("the public answer is status, feedConnected and the time; nothing operational, for anyone", async () => {
    for (const token of [undefined, "user-token", "admin-token", "forged"]) {
      const res = await get("/health", token).expect(200);
      expect(publicHealthSchema.strict().parse(res.body)).toEqual(res.body);
      expect(Object.keys(res.body).sort()).toEqual(["feedConnected", "now", "status"]);
      expect(res.body).toMatchObject({ status: "ok", feedConnected: true });
      const text = JSON.stringify(res.body);
      for (const secret of ["budget", "consumers", "dryRun", "queuedRequests", "weightLastMinute", "discovery", "archive", "fillsUnavailable", "spendDay", WATCHED, "lastObjectKey", "marketsSubscribed"]) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });

  it("a feed that is down is `degraded`; an unreachable worker is still a 503 with no detail", async () => {
    heartbeat.mockResolvedValueOnce(full(false));
    expect((await get("/health").expect(200)).body).toMatchObject({ status: "degraded", feedConnected: false });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    heartbeat.mockRejectedValueOnce(new ServiceUnavailableException("Worker unavailable at http://worker.internal:3000"));
    const down = await get("/health").expect(503);
    expect(JSON.stringify(down.body)).not.toContain("worker.internal");
  });

  it("GET /admin/system/heartbeat is gone (no caller; the system overview carries the worker's heartbeat)", async () => {
    for (const token of [undefined, "user-token", "admin-token", "operator-token"]) await get("/admin/system/heartbeat", token).expect(404);
  });

  it("callers share one heartbeat read per second", async () => {
    await Promise.all(Array.from({ length: 20 }, () => get("/health")));
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
