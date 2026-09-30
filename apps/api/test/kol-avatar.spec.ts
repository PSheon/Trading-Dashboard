import type { INestApplication } from "@nestjs/common";
import { kolAvatars, kolTraders } from "@trading-dashboard/shared/database";
import { wireKolSchema, wireTraderProfileSchema } from "@trading-dashboard/shared/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminKolController, KolAvatarController } from "../src/discovery/discovery.controller.js";
import { allowedImageUrl, avatarSource, kolAvatarPath, sniffImageType } from "../src/discovery/kol-avatar.js";
import { KolAvatarRepository } from "../src/discovery/kol-avatar.repository.js";
import { KolAvatarService, nextDue, retryDelayMs } from "../src/discovery/kol-avatar.service.js";
import { KolRepository } from "../src/discovery/kol.repository.js";
import { KolService } from "../src/discovery/kol.service.js";
import { insertUser } from "./admin-test-utils.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

const image = (bytes: Buffer, type = "image/jpeg") => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const limited = (retryAfter?: number) => new Response("{}", { status: 429, headers: retryAfter ? { "retry-after": String(retryAfter) } : {} });

describe("KOL avatar rules", () => {
  it("fetches the admin's URL, else the 𝕏 handle; never CopyDog's CDN or a private host", () => {
    expect(avatarSource({ avatarUrl: "https://example.com/a.png", xHandle: "x" })).toBe("https://example.com/a.png");
    expect(avatarSource({ avatarUrl: null, xHandle: "mk4_lul" })).toBe("x:mk4_lul");
    expect(avatarSource({ avatarUrl: "https://cdn.copydog.xyz/kol/mk4.png", xHandle: "mk4_lul" })).toBe("x:mk4_lul");
    expect(avatarSource({ avatarUrl: null, xHandle: null })).toBeNull();
    for (const bad of ["http://example.com/a.png", "https://127.0.0.1/a.png", "https://localhost/a", "https://[::1]/a", "https://api.copydog.xyz/x", "https://example.com:8443/a"]) {
      expect(allowedImageUrl(bad), bad).toBe(false);
    }
  });

  it("recognises images by their bytes, never SVG", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(Buffer.from("GIF89a...."))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(SVG)).toBeNull();
  });

  it("versions the served URL by the ETag", () => {
    expect(kolAvatarPath(addr(1), null)).toBeNull();
    expect(kolAvatarPath(addr(1), '"AbCdEfGhIjKlMn"')).toBe(`/kols/${addr(1)}/avatar?v=AbCdEfGhIjKl`);
  });

  it("picks new or changed sources first, then the oldest due refresh", () => {
    const now = Date.parse("2026-09-30T00:00:00Z");
    const base = { avatarUrl: null, etag: null, failures: 0 };
    const due = nextDue([
      { ...base, address: addr(1), xHandle: "a", source: "x:a", nextAttemptAt: new Date(now - 60_000) },
      { ...base, address: addr(2), xHandle: "b", source: "x:b", nextAttemptAt: new Date(now + 60_000) },
      { ...base, address: addr(3), xHandle: null, source: null, nextAttemptAt: null },
      { ...base, address: addr(4), xHandle: "d2", source: "x:d", nextAttemptAt: new Date(now + 60_000) },
    ], now);
    expect(due).toMatchObject({ address: addr(4), want: "x:d2" });
    expect(nextDue([{ ...base, address: addr(2), xHandle: "b", source: "x:b", nextAttemptAt: new Date(now + 1) }], now)).toBeUndefined();
    expect(retryDelayMs("not_found", 0)).toBe(24 * 3_600_000);
    expect(retryDelayMs("error", 0)).toBe(15 * 60_000);
    expect(retryDelayMs("error", 10)).toBe(24 * 3_600_000);
  });
});

describe("KOL avatar cache (db)", () => {
  const db = getTestDb();
  const repository = new KolAvatarRepository(db);
  const config = { value: { ...testConfig().value, app: { ...testConfig().value.app, nodeEnv: "development" } } } as ReturnType<typeof testConfig>;
  let service: KolAvatarService;
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await truncateAll(db);
    service = new KolAvatarService(config, repository);
    fetcher = vi.fn();
    service.fetchImpl = fetcher as unknown as typeof fetch;
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it("fetches one avatar per tick, stores it type-checked and serves it back", async () => {
    await db.insert(kolTraders).values([
      { address: addr(1), xHandle: "one", sortOrder: 1 },
      { address: addr(2), avatarUrl: "https://img.example.com/two.png", sortOrder: 2 },
      { address: addr(3), sortOrder: 3 },
    ]);
    fetcher.mockResolvedValueOnce(image(JPEG));
    expect(await service.tick()).toBe("saved");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://unavatar.io/x/one?fallback=false");
    fetcher.mockResolvedValueOnce(image(PNG, "image/png"));
    expect(await service.tick()).toBe("saved");
    expect(String(fetcher.mock.calls[1][0])).toBe("https://img.example.com/two.png");
    expect(await service.tick()).toBe("idle"); // addr(3) has nothing to fetch
    const stored = await repository.find(addr(2));
    expect(stored).toMatchObject({ contentType: "image/png" });
    expect(Buffer.compare(stored!.bytes, PNG)).toBe(0);
    const card = await repository.card(addr(1));
    expect(card).toMatchObject({ xHandle: "one", avatarEtag: expect.stringMatching(/^".+"$/) });
    // Weekly refresh: nothing is due until then.
    expect(await service.tick(Date.now() + 6 * 24 * 3_600_000)).toBe("idle");
    fetcher.mockResolvedValueOnce(image(JPEG));
    expect(await service.tick(Date.now() + 8 * 24 * 3_600_000)).toBe("saved");
  });

  it("falls back to fxtwitter when unavatar answers 429, and pauses unavatar", async () => {
    await db.insert(kolTraders).values([{ address: addr(1), xHandle: "one" }, { address: addr(2), xHandle: "two" }]);
    fetcher
      .mockResolvedValueOnce(limited(78_312))
      .mockResolvedValueOnce(json({ code: 200, user: { avatar_url: "https://pbs.twimg.com/profile_images/1/abc_normal.jpg" } }))
      .mockResolvedValueOnce(image(JPEG));
    expect(await service.tick()).toBe("saved");
    expect(fetcher.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://unavatar.io/x/one?fallback=false",
      "https://api.fxtwitter.com/one",
      "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg",
    ]);
    expect(service.pausedUntil.get("unavatar")).toBeGreaterThan(Date.now() + 20 * 3_600_000);
    // Next KOL skips the paused provider; a 429 there too pauses the drip
    // without recording a failure on the row.
    fetcher.mockResolvedValueOnce(limited());
    expect(await service.tick()).toBe("paused");
    expect(fetcher.mock.calls.at(-1)![0]).toBe("https://api.fxtwitter.com/two");
    expect(await service.tick()).toBe("paused");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect((await repository.candidates()).find((c) => c.address === addr(2))?.source).toBeNull();
  });

  it("rejects SVG and oversized bodies, keeps last week's picture when a refresh fails", async () => {
    await db.insert(kolTraders).values([{ address: addr(1), avatarUrl: "https://img.example.com/a.svg" }]);
    fetcher.mockResolvedValueOnce(image(SVG, "image/svg+xml"));
    expect(await service.tick()).toBe("error");
    let [row] = await db.select().from(kolAvatars);
    expect(row).toMatchObject({ bytes: null, failures: 1, lastError: "not an image" });

    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(600 * 1024), { headers: { "content-type": "image/png" } }));
    expect(await service.tick(Date.now() + 16 * 60_000)).toBe("error");
    [row] = await db.select().from(kolAvatars);
    expect(row).toMatchObject({ failures: 2, lastError: "image too large" });

    fetcher.mockResolvedValueOnce(image(PNG, "image/png"));
    expect(await service.tick(Date.now() + 2 * 3_600_000)).toBe("saved");
    fetcher.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await service.tick(Date.now() + 8 * 24 * 3_600_000)).toBe("error");
    [row] = await db.select().from(kolAvatars);
    expect(row.bytes).not.toBeNull();
    expect(row).toMatchObject({ failures: 1, lastError: "HTTP 500" });
  });

  it("drops a changed source's old picture and orphaned rows", async () => {
    await db.insert(kolTraders).values([{ address: addr(1), xHandle: "one" }, { address: addr(2), xHandle: "two" }]);
    await db.insert(kolAvatars).values([
      { address: addr(1), source: "x:old", bytes: JPEG, contentType: "image/jpeg", etag: '"x"', fetchedAt: new Date(), nextAttemptAt: new Date(Date.now() + 1e9) },
      { address: addr(2), source: "x:two", bytes: JPEG, contentType: "image/jpeg", etag: '"y"', fetchedAt: new Date(), nextAttemptAt: new Date(Date.now() + 1e9) },
      { address: addr(9), source: "x:gone", bytes: JPEG, contentType: "image/jpeg", etag: '"z"', fetchedAt: new Date() },
    ]);
    fetcher.mockImplementation(async () => new Response("", { status: 404 }));
    expect(await service.tick()).toBe("not_found");
    const rows = await db.select().from(kolAvatars);
    expect(rows.map((r) => r.address).sort()).toEqual([addr(1), addr(2)]);
    expect(rows.find((r) => r.address === addr(1))).toMatchObject({ source: "x:one", bytes: null, etag: null });
  });

  describe("HTTP", () => {
    let app: INestApplication;
    const privy = stubPrivy({ "admin-token": { privyUserId: "did:privy:admin" } });

    beforeAll(async () => {
      ({ app } = await createAuthedApp({
        db,
        privy,
        controllers: [KolAvatarController, AdminKolController],
        providers: [KolAvatarRepository, KolAvatarService, KolRepository, KolService],
      }));
    });
    afterAll(async () => {
      await app.close();
    });

    it("serves the cached bytes with a long cache for the current version, ETag and 304", async () => {
      await insertUser(db, { privyUserId: "did:privy:admin", role: "admin" });
      await db.insert(kolTraders).values([{ address: addr(1), xHandle: "one" }]);
      const server = app.getHttpServer();
      await request(server).get(`/kols/${addr(1)}/avatar`).expect(404);
      await db.insert(kolAvatars).values({ address: addr(1), source: "x:one", bytes: PNG, contentType: "image/png", etag: '"AbCdEfGhIjKlMn"', fetchedAt: new Date() });
      const res = await request(server).get(`/kols/${addr(1)}/avatar?v=AbCdEfGhIjKl`).buffer(true).parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => done(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["cache-control"]).toBe("public, max-age=2592000, immutable");
      expect(res.headers.etag).toBe('"AbCdEfGhIjKlMn"');
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
      const stale = await request(server).get(`/kols/${addr(1).toUpperCase().replace("0X", "0x")}/avatar?v=old`).expect(200);
      expect(stale.headers["cache-control"]).toBe("public, max-age=3600");
      await request(server).get(`/kols/${addr(1)}/avatar`).set("If-None-Match", '"AbCdEfGhIjKlMn"').expect(304);
      await request(server).get(`/kols/${addr(1)}/avatar?v=../x`).expect(400);
      const list = await request(server).get("/admin/kols").set("Authorization", "Bearer admin-token").expect(200);
      expect(wireKolSchema.array().parse(list.body.data)[0].cachedAvatarUrl).toBe(`/kols/${addr(1)}/avatar?v=AbCdEfGhIjKl`);
    });
  });
});

it("the trader profile contract carries the KOL card", () => {
  const kol = { displayName: "mk4", xHandle: "mk4_lul", verified: true, avatarUrl: `/kols/${addr(1)}/avatar?v=abc` };
  expect(wireTraderProfileSchema.shape.kol.parse(kol)).toEqual(kol);
  expect(wireTraderProfileSchema.shape.kol.parse(null)).toBeNull();
});
