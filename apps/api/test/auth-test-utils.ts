import { LeadersRepository } from "../src/api/leaders/leaders.repository.js";
import { AlertsRepository } from "../src/api/alerts/alerts.repository.js";
import { FavoritesRepository } from "../src/users/favorites.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { HttpModule } from "../src/common/http/http.module.js";
import { Global, Module, type INestApplication, type Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { vi } from "vitest";

import { AuthModule, AUTH_GUARD_PROVIDERS } from "../src/common/auth/auth.module.js";
import { AuthService } from "../src/common/auth/auth.service.js";
import { PRIVY_VERIFIER, type PrivyProfile, type PrivyVerifier } from "../src/common/auth/privy-verifier.js";
import { DRIZZLE_CLIENT } from "../src/db/db.constants.js";
import { SettingsModule } from "../src/settings/settings.module.js";
import { SettingsService } from "../src/settings/settings.service.js";
import type { TestDb } from "./db-test-utils.js";

export interface StubAccount {
  privyUserId: string;
  /** Default: an hour from now. */
  expiresAt?: Date;
  profile?: PrivyProfile | null;
}

/** Privy stand-in: `accounts` maps an access token to who it belongs to;
 * any other token is rejected the way the SDK rejects a bad signature. */
export function stubPrivy(accounts: Record<string, StubAccount>) {
  const byDid = new Map(Object.values(accounts).map((a) => [a.privyUserId, a]));
  const verifier = {
    verifyAccessToken: vi.fn(async (token: string) => {
      const account = accounts[token];
      if (!account) throw new Error("JWSSignatureVerificationFailed");
      return {
        privyUserId: account.privyUserId,
        expiresAt: account.expiresAt ?? new Date(Date.now() + 3_600_000),
      };
    }),
    fetchProfile: vi.fn(async (did: string) => byDid.get(did)?.profile ?? null),
  } satisfies PrivyVerifier;
  return verifier;
}

/** A Nest app with the real AuthModule + global AuthGuard, the given
 * controllers/providers, a real test DB and a stubbed Privy. */
export async function createAuthedApp(opts: {
  db: TestDb;
  privy: PrivyVerifier;
  controllers?: Type<unknown>[];
  providers?: Parameters<typeof Test.createTestingModule>[0]["providers"];
  imports?: Parameters<typeof Test.createTestingModule>[0]["imports"];
}): Promise<{ app: INestApplication; auth: AuthService; settings: SettingsService }> {
  @Global()
  @Module({ providers: [UnitOfWork, { provide: DRIZZLE_CLIENT, useValue: opts.db }], exports: [DRIZZLE_CLIENT, UnitOfWork] })
  class TestDbModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [HttpModule, TestDbModule, SettingsModule, AuthModule, ...(opts.imports ?? [])],
    controllers: opts.controllers ?? [],
    providers: [LeadersRepository, AlertsRepository, FavoritesRepository, ...AUTH_GUARD_PROVIDERS, ...(opts.providers ?? [])],
  })
    .overrideProvider(PRIVY_VERIFIER)
    .useValue(opts.privy)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app
    .getHttpAdapter()
    .getInstance()
    .set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  // Keep one loopback listener for the suite. Letting Supertest start/close
  // the server per request churns ephemeral ports and can race socket reuse
  // when many HTTP integration requests run back-to-back.
  await app.listen(0, "127.0.0.1");
  return { app, auth: app.get(AuthService), settings: app.get(SettingsService) };
}
