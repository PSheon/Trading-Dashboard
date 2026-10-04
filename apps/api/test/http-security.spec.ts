import { Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { expect, it } from "vitest";
import request from "supertest";
import { configureHttpSecurity } from "../src/common/http/security.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { requestContext } from "../src/runtime/request-middleware.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";

it("sets security headers and exposes metadata only to explicitly allowed browser origins", async () => {
  @Controller("probe") class Probe { @Get() read() { return { ok: true }; } }
  const ref = await Test.createTestingModule({ controllers: [Probe] }).compile();
  const app = ref.createNestApplication({ logger: false });
  configureHttpSecurity(app, validateEnvironment({ NODE_ENV: "production", DATABASE_URL: "postgres://test@localhost/test", API_CORS_ORIGINS: "https://app.example.com", HYPERLIQUID_EGRESS_KEY: "test-egress" }));
  app.use(requestContext(new BackgroundJobs()));
  await app.listen(0, "127.0.0.1");
  try {
    const allowed = await request(app.getHttpServer()).get("/probe").set("origin", "https://app.example.com").set("x-request-id", "probe-id").expect(200);
    expect(allowed.headers).toMatchObject({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "access-control-allow-origin": "https://app.example.com", "x-request-id": "probe-id", "cache-control": "no-store" });
    expect(allowed.headers["access-control-expose-headers"]).toContain("Retry-After");
    expect(allowed.headers["strict-transport-security"]).toBeDefined();
    expect(allowed.headers["x-powered-by"]).toBeUndefined();
    const denied = await request(app.getHttpServer()).get("/probe").set("origin", "https://attacker.example.com").expect(200);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await request(app.getHttpServer()).options("/probe").set("origin", "https://app.example.com").set("access-control-request-method", "GET").expect(204);
    expect(preflight.headers["access-control-allow-headers"]).toContain("Authorization");
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
  } finally { await app.close(); }
});
