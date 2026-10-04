import { SkipTransform } from "../src/common/decorators/http.decorator.js";
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
  StreamableFile,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { HttpModule } from "../src/common/http/http.module.js";
import { addressSchema, httpRouteContracts } from "@trading-dashboard/shared/contracts";
import { parseOr400 } from "../src/common/http/validation.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

@Controller()
class ProbeController {
  @Get("actions") actions() { return [{ id: 9007199254740993n, chain: "hyperliquid", address: "0xabc", coin: "BTC", kind: "open", side: "long", notionalUsd: "1.01", avgPx: "1", fillIds: [9007199254740994n], ts: new Date("2026-01-01T00:00:00Z"), privateColumn: "never expose" }]; }
  @Get("bad") bad() { return parseOr400(addressSchema, "invalid"); }
  @Get("conflict") conflict() { throw new ConflictException({ code: "alert_limit", limit: 3, message: "Limit reached" }); }
  @Get("bug") bug() { throw new Error("secret SQL token value"); }
  @Get("invalid") invalid() { throw new BadRequestException({ message: "Bad fields", issues: [{ path: ["rows", 0, "address"], message: "Invalid address" }] }); }
  @SkipTransform() @Get("health") health() { return { ok: true }; }
  @Get("file") file() { return new StreamableFile(Buffer.from("hello")); }
  @Post("empty") @HttpCode(204) empty() {}
  @Get("settings") brokenOutput() { return { secret: "should not pass schema" }; }
}
@Module({ imports: [HttpModule], controllers: [ProbeController] }) class ProbeModule {}

describe("default HTTP contract", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = module.createNestApplication({ logger: false });
    app.getHttpAdapter().getInstance().set("json replacer", (_: string, v: unknown) => typeof v === "bigint" ? v.toString() : v);
    await app.listen(0, "127.0.0.1");
  });
  afterAll(async () => app.close());
  const get = (path: string) => request(app.getHttpServer()).get(path).set("x-api-contract", "1");
  it("whitelists output and preserves dates, decimal and bigint precision over real HTTP", async () => {
    const res = await get("/actions?ignored=secret").set("x-request-id", "test_123").expect(200);
    expect(res.headers["x-api-contract"]).toBe("1");
    expect(res.body).toMatchObject({ success: true, statusCode: 200, meta: { requestId: "test_123", path: "/actions" } });
    expect(res.body.data[0]).toMatchObject({ id: "9007199254740993", fillIds: ["9007199254740994"], ts: "2026-01-01T00:00:00.000Z", notionalUsd: "1.01" });
    expect(res.body.data[0]).not.toHaveProperty("privateColumn");
  });
  it("returns the canonical envelope without a negotiation header", async () => {
    const res = await request(app.getHttpServer()).get("/actions").expect(200);
    expect(res.body.success).toBe(true);
    expect(new Date(res.body.meta.timestamp).toISOString()).toBe(res.body.meta.timestamp);
    expect(res.body.data[0]).not.toHaveProperty("privateColumn");
    expect(res.headers["x-api-contract"]).toBe("1");
  });
  it("cannot opt out with an unknown header and wraps unknown-route errors", async () => {
    const res = await request(app.getHttpServer()).get("/actions").set("x-api-contract", "legacy").expect(200);
    expect(res.body.success).toBe(true);
    expect(res.headers.vary ?? "").not.toContain("x-api-contract");
    const missing = await request(app.getHttpServer()).get("/health/not-a-probe").expect(404);
    expect(missing.body).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(new Date(missing.body.meta.timestamp).toISOString()).toBe(missing.body.meta.timestamp);
  });
  it("rejects invalid DTOs without envelope negotiation", async () => {
    const res = await request(app.getHttpServer()).get("/settings").expect(500);
    expect(res.body.error.code).toBe("internal_error");
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });
  it("normalizes field paths and preserves business codes/details", async () => {
    expect((await get("/bad").expect(400)).body.error).toMatchObject({ code: "validation_error", fields: [{ path: "" }] });
    expect((await get("/invalid").expect(400)).body.error.fields[0].path).toBe("rows.0.address");
    expect((await get("/conflict").expect(409)).body.error).toMatchObject({ code: "alert_limit", details: { limit: 3 } });
  });
  it("hides internal errors and rejects invalid response DTOs", async () => {
    for (const path of ["/bug", "/settings"]) {
      const res = await get(path).expect(500);
      expect(res.body).toMatchObject({ success: false, error: { code: "internal_error" } });
      expect(JSON.stringify(res.body)).not.toMatch(/SQL|token|secret|stack|issues/);
    }
  });
  it("returns a safe 400 for malformed JSON before controller invocation", async () => {
    const res = await request(app.getHttpServer()).post("/empty").set("x-api-contract", "1").set("Content-Type", "application/json").send("{broken").expect(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(res.body.message).toBe("Invalid request");
  });
  it("returns 413 for bodies rejected by Express before controller invocation", async () => {
    const res = await request(app.getHttpServer()).post("/empty").set("x-api-contract", "1").send({ value: "x".repeat(110000) }).expect(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });
  it("leaves health, files and no-content responses raw", async () => {
    expect((await get("/health").expect(200)).body).toEqual({ ok: true });
    expect((await get("/file").expect(200)).body.toString()).toBe("hello");
    expect((await request(app.getHttpServer()).post("/empty").set("x-api-contract", "1").expect(204)).text).toBe("");
  });
});

it("every production controller route has exactly one shared response contract", () => {
  const discovered: string[] = [];
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith(".controller.ts")) {
        const source = readFileSync(path, "utf8");
        const blocks = source.split(/@Controller\(["']([^"']*)["']\)/);
        for (let i = 1; i < blocks.length; i += 2) {
          const prefix = blocks[i];
          for (const match of blocks[i + 1].matchAll(/@(Get|Post|Put|Patch|Delete)\((?:["']([^"']*)["'])?\)/g)) {
            discovered.push(`${match[1].toUpperCase()} /${[prefix, match[2]].filter(Boolean).join("/")}`);
          }
        }
      }
    }
  }
  scan(join(import.meta.dirname, "../src"));
  expect(httpRouteContracts.map((r) => `${r.method} ${r.path}`).sort()).toEqual(discovered.sort());
});

it("declares every streaming route's event schemas in the registry", () => {
  const streams = httpRouteContracts.filter((r) => r.stream);
  expect(streams.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /actions/stream", "GET /me/copy/stream"]);
  const copy = streams[1].stream!.events;
  expect(Object.keys(copy).sort()).toEqual(["copy", "reset"]);
  expect(copy.copy.safeParse({ id: "12", strategyId: 3, type: "order_filled", payload: { mode: "paper", action: "open" }, createdAt: "2026-10-04T00:00:00.000Z" }).success).toBe(true);
  expect(copy.copy.safeParse({ id: 12, strategyId: 3, type: "order_filled", payload: {}, createdAt: "2026-10-04T00:00:00.000Z" }).success).toBe(false);
  expect(streams[1].response.safeParse(undefined).success).toBe(false);
  const events = streams[0].stream!.events;
  expect(Object.keys(events).sort()).toEqual(["action", "reset", "update"]);
  const wire = { id: "9007199254740993", chain: "hyperliquid", address: "0xabc", coin: "BTC", kind: "open", side: "long", notionalUsd: "1.01", avgPx: "1", fillIds: [], ts: "2026-01-01T00:00:00.000Z" };
  expect(events.action.safeParse(wire).success).toBe(true);
  expect(events.update.safeParse({ ...wire, id: 1 }).success).toBe(false);
  expect(events.reset.safeParse({ reason: "replay_truncated" }).success).toBe(true);
  // A stream never serves a JSON body.
  expect(streams[0].response.safeParse(undefined).success).toBe(false);
});
