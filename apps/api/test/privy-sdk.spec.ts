import { SkipTransform } from "../src/common/decorators/http.decorator.js";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { SdkPrivyVerifier } from "../src/common/auth/privy-verifier.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const second = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const appId = "local-sdk-test-app";
const did = "did:privy:local-sdk-user";
function verifier(publicKey = keys.publicKey) {
  return new SdkPrivyVerifier(new AppConfig(validateEnvironment({
    NODE_ENV: "test", DATABASE_URL: "postgres://unused@localhost/unused_test",
    PRIVY_APP_ID: appId, PRIVY_APP_SECRET: "local-test-only-secret",
    PRIVY_VERIFICATION_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
  })));
}
function token(claims: Record<string, unknown> = {}, key: KeyObject = keys.privateKey, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = [ { alg: "ES256", typ: "JWT", kid: "local-test", ...header },
    { iss: "privy.io", aud: appId, sub: did, sid: "local-session", iat: now, exp: now + 3600, ...claims } ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  return `${encoded}.${sign("sha256", Buffer.from(encoded), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
afterEach(() => vi.unstubAllGlobals());

describe("installed Privy SDK verification with ephemeral ES256 keys", () => {
  it("verifies through the production adapter without a network request or SDK mock", async () => {
    const fetcher = vi.fn(() => { throw new Error("Unexpected network access"); });
    vi.stubGlobal("fetch", fetcher);
    const result = await verifier().verifyAccessToken(token({ role: "admin", permissions: ["users.manage"] }));
    expect(result.privyUserId).toBe(did);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "privyUserId"]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { iss: "attacker.invalid" }, { aud: "another-app" }, { exp: 1 }, { exp: undefined },
    { sub: undefined }, { sid: undefined }, { iat: undefined }, { nbf: 9999999999 },
  ])("rejects invalid claims %j", async (claims) => {
    await expect(verifier().verifyAccessToken(token(claims))).rejects.toThrow();
  });
  it("rejects an invalid signature, algorithm confusion and malformed tokens", async () => {
    await expect(verifier().verifyAccessToken(token({}, second.privateKey))).rejects.toThrow();
    await expect(verifier().verifyAccessToken(token({}, keys.privateKey, { alg: "HS256" }))).rejects.toThrow();
    await expect(verifier().verifyAccessToken("not-a-jwt")).rejects.toThrow();
  });
  it("a restarted verifier accepts only the newly pinned verification key", async () => {
    const rotated = verifier(second.publicKey);
    await expect(rotated.verifyAccessToken(token())).rejects.toThrow();
    expect((await rotated.verifyAccessToken(token({}, second.privateKey))).privyUserId).toBe(did);
  });
});

import { Controller, Get } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { users } from "@trading-dashboard/shared/database";
import { RequirePermissions } from "../src/common/auth/permissions.js";
import { getTestDb, truncateAll, closeTestDb } from "./db-test-utils.js";
import { createAuthedApp } from "./auth-test-utils.js";

it("real signed Privy tokens resolve database RBAC through the HTTP guards", async () => {
  const db = getTestDb();
  await truncateAll(db);
  await db.insert(users).values({ privyUserId: did, email: "local@example.com", role: "user" });
  @SkipTransform() @Controller("sdk-probe") class Probe {
    @RequirePermissions("users.manage") @Get() read() { return { ok: true }; }
  }
  const fetcher = vi.fn(() => { throw new Error("Unexpected network access"); });
  vi.stubGlobal("fetch", fetcher);
  const { app } = await createAuthedApp({ db, privy: verifier(), controllers: [Probe] });
  const signed = token({ role: "admin", permissions: ["users.manage"] });
  try {
    await request(app.getHttpServer()).get("/sdk-probe").set("Authorization", `Bearer ${signed}`).expect(403);
    await db.update(users).set({ role: "admin" }).where(eq(users.privyUserId, did));
    await request(app.getHttpServer()).get("/sdk-probe").set("Authorization", `Bearer ${signed}`).expect(200);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.privyUserId, did));
    await request(app.getHttpServer()).get("/sdk-probe").set("Authorization", `Bearer ${signed}`).expect(401);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await app.close(); await closeTestDb(); }
});
