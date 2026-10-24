import { Body, Controller, HttpCode, Logger, Post } from "@nestjs/common";
import { ApiDoc, SkipTransform } from "../src/common/decorators/http.decorator.js";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll, insertUser } from "./db-test-utils.js";

/**
 * The api's JSON bodies stay under express's 100 kB default: the bound the
 * pnpm audit exception for zod < 4.6.6 (GHSA-mrhx-c7xc-m3w5, memory
 * exhaustion on oversized constrained collections; pnpm-workspace.yaml)
 * relies on. A larger body is refused before any schema sees it.
 */
@Controller()
class BodyLimitProbeController {
  @Post("/body-limit-probe") @HttpCode(200) @SkipTransform() @ApiDoc("Body limit probe (test only; no response contract)")
  probe(@Body() body: { items?: unknown[] }) { return { items: body.items?.length ?? 0 }; }
}

const db = getTestDb();
const privy = stubPrivy({ alice: { privyUserId: "did:privy:body-limit-alice" } });
let app: INestApplication, auth: AuthService;
beforeAll(async () => {
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [BodyLimitProbeController] }));
  await truncateAll(db); auth.clearCache();
  await insertUser(db, { privyUserId: "did:privy:body-limit-alice", embeddedWalletAddress: `0x${"33".repeat(20)}` });
});
afterAll(async () => { await app?.close(); await closeTestDb(); });

const post = (body: object) => request(app.getHttpServer()).post("/body-limit-probe").set("Authorization", "Bearer alice").send(body);

describe("JSON body limit", () => {
  it("accepts a body under 100 kB and refuses one over it with 413 before any handler runs", async () => {
    const errors = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const small = { items: Array.from({ length: 1_000 }, (_, i) => i) };
    expect(JSON.stringify(small).length).toBeLessThan(100 * 1024);
    const ok = await post(small);
    if (ok.status !== 200) throw new Error(`${ok.status} ${ok.text.slice(0, 200)} :: ${JSON.stringify(errors.mock.calls.map((c) => c[0])).slice(0, 1200)}`);
    expect(ok.body.items).toBe(1_000);
    const big = { items: Array.from({ length: 30_000 }, (_, i) => `item-${i}`) };
    expect(JSON.stringify(big).length).toBeGreaterThan(100 * 1024);
    await post(big).expect(413);
  });
});
