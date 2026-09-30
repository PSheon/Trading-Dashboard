import { SkipTransform } from "../src/common/decorators/http.decorator.js";
import { describe, expect, it } from "vitest";
import { OVERFLOW_MULTIPLIER, RequestRateLimiter } from "../src/common/auth/rate-limit.guard.js";

describe("bounded inbound rate limits", () => {
  it("rejects overflow with a retry delay and admits after expiration", () => {
    const limiter = new RequestRateLimiter();
    expect(limiter.consume("alice", 2, 1000)).toBe(0);
    expect(limiter.consume("alice", 2, 1001)).toBe(0);
    expect(limiter.consume("alice", 2, 2000)).toBe(59);
    expect(limiter.consume("bob", 2, 2000)).toBe(0);
    expect(limiter.consume("alice", 2, 61000)).toBe(0);
  });
  it("at capacity sends new keys to a shared overflow bucket instead of refusing them, never evicting active limits", () => {
    const limiter = new RequestRateLimiter();
    limiter.maxKeys = 100;
    for (let i = 0; i < 100; i++) expect(limiter.consume(`read:ip${i}`, 1, 0)).toBe(0);
    // Active keys keep their windows: no reset by eviction.
    expect(limiter.consume("read:ip0", 1, 1)).toBe(60);
    // New clients are admitted through the category's overflow bucket
    // (OVERFLOW_MULTIPLIER × the limit), not refused outright …
    for (let i = 0; i < OVERFLOW_MULTIPLIER; i++) expect(limiter.consume(`read:new${i}`, 1, 1)).toBe(0);
    // … which, once spent, limits the flood rather than everyone.
    expect(limiter.consume("read:another", 1, 1)).toBe(60);
    // Other categories have their own overflow.
    expect(limiter.consume("write:new", 1, 1)).toBe(0);
    // Once windows expire the new keys get their own buckets again.
    expect(limiter.consume("read:new0", 1, 60_000)).toBe(0);
    expect(limiter.consume("read:new0", 1, 60_001)).toBeGreaterThan(0);
    expect(limiter.consume("read:new1", 1, 60_001)).toBe(0);
  });
  it("evicts expired keys before overflowing, even between sweeps", () => {
    const limiter = new RequestRateLimiter();
    limiter.maxKeys = 3;
    expect(limiter.consume("read:a", 1, 0)).toBe(0);
    expect(limiter.consume("read:b", 1, 0)).toBe(0);
    expect(limiter.consume("read:c", 1, 59_999)).toBe(0);
    // a and b expired at 60 000; the periodic sweep last ran at 59 999.
    expect(limiter.consume("read:d", 1, 60_100)).toBe(0);
    expect(limiter.consume("read:d", 1, 60_101)).toBeGreaterThan(0); // its own bucket, not overflow
    expect(limiter.consume("read:e", 1, 60_101)).toBe(0);
  });
});

import { CallerRateGuard, IngressRateGuard } from "../src/common/auth/rate-limit.guard.js";
import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import type { ExecutionContext } from "@nestjs/common";
import { vi } from "vitest";

const config = new AppConfig(validateEnvironment({ DATABASE_URL: "postgres://test@localhost/test", API_READ_PER_MINUTE: "1", API_INGRESS_PER_MINUTE: "1" }));
function context(request: object) {
  const setHeader = vi.fn();
  return { setHeader, ctx: { switchToHttp: () => ({ getRequest: () => ({ method: "GET", path: "/traders", ip: "127.0.0.1", socket: {}, ...request }), getResponse: () => ({ setHeader }) }) } as unknown as ExecutionContext };
}
it("uses verified user identity across token/IP rotation, separating different users", () => {
  const guard = new CallerRateGuard(new RequestRateLimiter(), config);
  expect(guard.canActivate(context({ user: { kind: "user", id: 1 } }).ctx)).toBe(true);
  const second = context({ user: { kind: "user", id: 1 }, ip: "203.0.113.1", headers: { authorization: "Bearer different" } });
  expect(() => guard.canActivate(second.ctx)).toThrow("Too many requests");
  expect(second.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  expect(guard.canActivate(context({ user: { kind: "user", id: 2 } }).ctx)).toBe(true);
});
it("does not accept forged forwarded headers as an IP identity", () => {
  const guard = new IngressRateGuard(new RequestRateLimiter(), config);
  expect(guard.canActivate(context({ headers: { "x-forwarded-for": "203.0.113.1" } }).ctx)).toBe(true);
  expect(() => guard.canActivate(context({ headers: { "x-forwarded-for": "203.0.113.2" } }).ctx)).toThrow();
});

import { Controller, Get } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HttpModule } from "../src/common/http/http.module.js";

it("returns canonical 429 and Retry-After through the actual HTTP filter", async () => {
  @SkipTransform() @Controller("rate-probe") class Probe { @Get() read() { return { ok: true }; } }
  const module = await Test.createTestingModule({
    imports: [HttpModule], controllers: [Probe],
    providers: [RequestRateLimiter, { provide: AppConfig, useValue: config }, { provide: APP_GUARD, useClass: IngressRateGuard }],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  await app.listen(0, "127.0.0.1");
  try {
    await request(app.getHttpServer()).get("/rate-probe").set("x-forwarded-for", "203.0.113.1").expect(200);
    const res = await request(app.getHttpServer()).get("/rate-probe").set("x-forwarded-for", "203.0.113.2").set("x-api-contract", "1").expect(429);
    expect(res.body.error.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  } finally { await app.close(); }
});

it("throttles /health and /health/ready per client in their own bucket, apart from ingress and reads", async () => {
  const { HEALTH_PER_MINUTE } = await import("../src/common/auth/rate-limit.guard.js");
  const limiter = new RequestRateLimiter();
  const ingress = new IngressRateGuard(limiter, config);
  const caller = new CallerRateGuard(limiter, config);
  for (let i = 0; i < HEALTH_PER_MINUTE; i++) {
    const path = i % 2 ? "/health" : "/health/ready";
    expect(ingress.canActivate(context({ path, ip: "198.51.100.5" }).ctx)).toBe(true);
    expect(caller.canActivate(context({ path, ip: "198.51.100.5" }).ctx)).toBe(true);
  }
  const over = context({ path: "/health/ready", ip: "198.51.100.5" });
  expect(() => ingress.canActivate(over.ctx)).toThrow("Too many requests");
  expect(over.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  // The platform's checker (another address) and the client's normal
  // requests are unaffected.
  expect(ingress.canActivate(context({ path: "/health/ready", ip: "10.0.0.2" }).ctx)).toBe(true);
  expect(ingress.canActivate(context({ path: "/traders", ip: "198.51.100.5" }).ctx)).toBe(true);
});

it("counts IPv6 clients per /64 and IPv4 per address", () => {
  const guard = new IngressRateGuard(new RequestRateLimiter(), config); // 1 per minute
  expect(guard.canActivate(context({ ip: "2001:db8:aa:bb::1" }).ctx)).toBe(true);
  // Rotating inside the /64 is the same client.
  expect(() => guard.canActivate(context({ ip: "2001:db8:aa:bb:ffff:1:2:3" }).ctx)).toThrow("Too many requests");
  expect(guard.canActivate(context({ ip: "2001:db8:aa:bc::1" }).ctx)).toBe(true);
  expect(guard.canActivate(context({ ip: "198.51.100.1" }).ctx)).toBe(true);
  expect(guard.canActivate(context({ ip: "198.51.100.2" }).ctx)).toBe(true);
  expect(() => guard.canActivate(context({ ip: "::ffff:198.51.100.2" }).ctx)).toThrow("Too many requests");
});
