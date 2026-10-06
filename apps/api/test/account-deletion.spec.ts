import type { INestApplication } from "@nestjs/common";
import {
  accountDeletionMarkers, adminAuditLogs, copyAgentSetups, copyExecutionAccounts, copyFollowerLedger, copyFollowerReceipts, copyFundingOperations, copyLiveDispatches, copyLiveExecutions,
  copyLiveMandates, copyLiveSetups, copyLiveSourceFills, copyLiveStopOperations, copyStrategies, copyWalletAuthorizationEvents, copyWalletAuthorizations,
  favoriteGroups, notificationChannels, paperAccounts, referralAttributions, referralClaims, referralCodes, referralPolicies, userFavorites, users, walletWithdrawals,
} from "@trading-dashboard/shared/database";
import { eq, isNotNull, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { RetentionRepository } from "../src/retention/retention.repository.js";
import { RetentionService } from "../src/retention/retention.service.js";
import type { SettingsService } from "../src/settings/settings.service.js";
import { AccountDeletionService } from "../src/users/account-deletion.service.js";
import { COPY_ACCOUNT_CLOSURE, CopySignerAttached } from "../src/users/account-closure.port.js";
import { purgeStatements, USER_REFERENCES } from "../src/users/account-closure.plan.js";
import { AccountRepository } from "../src/users/account.repository.js";
import { AppConfig } from "../src/config/app-config.js";
import { ReferralRepository } from "../src/referral/referral.repository.js";
import { FavoritesService } from "../src/users/favorites.service.js";
import { MeController } from "../src/users/me.controller.js";
import { ProfileRepository } from "../src/users/profile.repository.js";
import { ProfileService } from "../src/users/profile.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { preparationFixture } from "./copy-live-preparation-test-utils.js";
import { now } from "./copy-live-risk-test-utils.js";
import { closeTestDb, getTestDb, insertUser } from "./db-test-utils.js";

/**
 * Account deletion at the industry standard (docs/account-deletion.md):
 * only in-flight state blocks it, history never does; personal data goes;
 * kept financial and audit records move to an anonymous tombstone and are
 * purged with it after 365 days. Real Postgres; the exchange and Privy are
 * fakes (COPY_ACCOUNT_CLOSURE).
 */
const db = getTestDb();
const OWNER_MAIN = `0x${"55".repeat(20)}`, OTHER = `0x${"77".repeat(20)}`, PAPER_LEADER = `0x${"66".repeat(20)}`;
const STOP = "11111111-1111-4111-8111-111111111111";
const closure = { isEmpty: vi.fn(async (_network: string, _address: string) => true), assertSignerDetached: vi.fn(async (_walletId: string) => {}) };
let app: INestApplication, auth: AuthService, settings: SettingsService, seed: Awaited<ReturnType<typeof preparationFixture>>;
let inviter: number, invitee: number;

beforeAll(async () => {
  const privy = stubPrivy({ "owner-token": { privyUserId: "did:privy:risk-source" } });
  ({ app, auth, settings } = await createAuthedApp({ db, privy, controllers: [MeController],
    providers: [ProfileRepository, ProfileService, FavoritesService, AccountRepository, AccountDeletionService, { provide: COPY_ACCOUNT_CLOSURE, useValue: closure }] }));
});
beforeEach(async () => {
  seed = await preparationFixture(db);
  auth.clearCache();
  closure.isEmpty.mockReset().mockResolvedValue(true);
  closure.assertSignerDetached.mockReset().mockResolvedValue(undefined);
  inviter = (await insertUser(db, { privyUserId: "did:privy:inviter" })).id;
  invitee = (await insertUser(db, { privyUserId: "did:privy:invitee" })).id;
});
afterAll(async () => { await app.close(); await closeTestDb(); });

const deleteMe = () => request(app.getHttpServer()).delete("/me").set("Authorization", "Bearer owner-token").set("X-Confirm-Delete", "delete-account");
const tombstones = () => db.select().from(users).where(isNotNull(users.deletedAt));
const account = () => seed.f.identity.accountAddress;
const execution = (key: string, state: string) => ({ key, network: "testnet", accountAddress: account(), signerAddress: `0x${"33".repeat(20)}`, cloid: `0x${key.at(-1)!.repeat(32)}`,
  nonce: now + key.length + key.charCodeAt(key.length - 1), userId: 1, strategyId: 9, state, updatedAt: new Date(now), record: { key, state } });
const funding = (id: string, overrides: Partial<typeof copyFundingOperations.$inferInsert>) => ({ id, userId: 1, accountId: "account", strategyId: 9, idempotencyKey: `fund-${id.slice(0, 8)}`,
  network: "testnet" as const, address: OWNER_MAIN, destination: account(), amount: "50", nonce: now, ...overrides });
const credited = (hash: string) => ({ status: "credited" as const, claimedAt: new Date(now), attemptedAt: new Date(now), evidenceHash: "a".repeat(64), transactionHash: `0x${hash.repeat(64)}`, creditedAmount: "50", fee: "0" });
const setup = (id: string, stage: string, overrides: Partial<typeof copyLiveSetups.$inferInsert> = {}) => ({ id, userId: 1, strategyId: 9, accountId: "account", kind: "start" as const,
  idempotencyKey: `setup-${id}-000000000000`.slice(0, 32), stage: stage as never, leaderAddress: `0x${"44".repeat(20)}`, sourceNetwork: "testnet" as const, budgetUsd: "100", settings: {}, ...overrides });
const consented = { signerKind: "owner_session" as const, intentDigest: "a".repeat(64), consentDigest: "b".repeat(64), confirmedAt: new Date(now), setupDeadline: new Date(now + 600_000) };

/** The owner's copy is over and only history is left: a stopped testnet copy
 * with its stop, deposit, sweep, order, fill, setup and a finished main-wallet
 * withdrawal; an inviter and an invitee. Plus personal data and a paper copy. */
async function history() {
  await db.update(copyStrategies).set({ status: "stopped", pauseNewRisk: true, stoppedAt: new Date(now) }).where(eq(copyStrategies.id, 9));
  await db.update(copyLiveMandates).set({ state: "stopped" });
  await db.insert(copyLiveStopOperations).values({ id: STOP, userId: 1, strategyId: 9, accountId: "account", mandateId: "mandate", idempotencyKey: "history-stop-0001",
    originalMandateRevision: 2, network: "testnet", accountAddress: account(), ownerPrivyUserId: "did:privy:risk-source", ownerAddress: OWNER_MAIN, accountWalletId: "master",
    accountOwnerQuorumId: "owner", originalIntentDigest: "a".repeat(64), originalConsentDigest: "b".repeat(64), state: "stopped", targetManifest: {}, targetDigest: "c".repeat(64),
    trackedExecutionCount: 0, trackingComplete: true, flatCertificate: {}, flatDigest: "d".repeat(64), flatVerifiedAt: new Date(now), createdAt: new Date(now - 1000), updatedAt: new Date(now) });
  await db.insert(copyFundingOperations).values([
    funding("22222222-2222-4222-8222-222222222222", credited("b")),
    funding("33333333-3333-4333-8333-333333333333", { ...credited("c"), address: account(), destination: OWNER_MAIN, direction: "to_main", stopId: STOP, nonce: now + 1, idempotencyKey: `sweep:${STOP}` }),
  ]);
  await db.insert(copyLiveExecutions).values(execution("k3", "filled"));
  await db.insert(copyLiveDispatches).values({ id: "leg-1", mandateId: "mandate", userId: 1, strategyId: 9, accountId: "account", sourceFillId: seed.fill.id, leg: "open", coin: "BTC",
    state: "settled", executionKey: "k3", leaderTime: new Date(now - 1000), receivedAt: new Date(now - 900) });
  await db.insert(copyFollowerReceipts).values({ key: "receipt-1", accountId: "account", network: "testnet", accountAddress: account(), kind: "fill", sourceId: "tid-1", coin: "BTC",
    providerTime: new Date(now), digest: "e".repeat(64), record: { oid: 1 }, executionKey: "k3", attribution: "execution" });
  await db.insert(copyFollowerLedger).values({ receiptKey: "receipt-1", component: "realized_pnl", amount: "1.5" });
  await db.insert(copyLiveSetups).values(setup("run", "running", consented));
  await db.insert(walletWithdrawals).values({ id: "withdrawal-done", userId: 1, network: "testnet", address: OWNER_MAIN, destination: OTHER, amount: "12.5", nonce: now,
    status: "accepted", origin: "client", claimedAt: new Date(now), attemptedAt: new Date(now), evidenceHash: "c".repeat(64) });
  await db.insert(referralPolicies).values({ version: "deletion-test", effectiveFrom: new Date(0) });
  await db.insert(referralCodes).values([{ id: "code-inviter", userId: inviter, code: "INVITER1", kind: "custom" },
    { id: "code-owner", userId: 1, code: "OWNERCODE", kind: "custom" }, { id: "code-owner-old", userId: 1, code: "OWNEROLD", kind: "default", isCurrent: false }]);
  await db.insert(referralAttributions).values([
    { id: "attr-owner", referredUserId: 1, referrerUserId: inviter, codeId: "code-inviter", policyVersion: "deletion-test", boundAt: new Date(now) },
    { id: "attr-invitee", referredUserId: invitee, referrerUserId: 1, codeId: "code-owner", policyVersion: "deletion-test", boundAt: new Date(now) }]);
  // Personal data, and a running paper copy (never money: deleted with the account).
  await db.update(users).set({ email: "owner@example.com", displayName: "Owner", walletAddress: OWNER_MAIN }).where(eq(users.id, 1));
  await db.insert(userFavorites).values({ userId: 1, address: OTHER });
  await db.insert(favoriteGroups).values({ userId: 1, name: "Core" });
  await db.insert(notificationChannels).values({ userId: 1, kind: "telegram", target: "555", enabled: true });
  await db.insert(paperAccounts).values({ userId: 1, balance: "9900", startingBalance: "10000" });
  await db.insert(copyStrategies).values({ id: 10, userId: 1, leaderAddress: PAPER_LEADER, allocated: "100", cash: "100", activatedAt: new Date(now) });
}

describe("DELETE /me — only in-flight state blocks", () => {
  const cases: Array<[string, string, () => Promise<unknown>]> = [
    // The fixture's testnet copy is still running.
    ["a running testnet copy", "copies_active", async () => {}],
    ["a stop still closing", "stop_in_progress", async () => { await history(); await db.update(copyLiveStopOperations).set({ state: "closing", flatCertificate: null, flatDigest: null, flatVerifiedAt: null }); }],
    ["a setup whose deposit was sent", "setup_in_progress", async () => { await history(); await db.insert(copyLiveSetups).values(setup("mid", "funding_submitted", consented)); }],
    ["a deposit sent but not credited", "transfer_pending", async () => { await history(); await db.insert(copyFundingOperations).values(funding("44444444-4444-4444-8444-444444444444",
      { status: "accepted", claimedAt: new Date(now), attemptedAt: new Date(now), evidenceHash: "a".repeat(64), nonce: now + 5, idempotencyKey: "fund-pending-1" })); }],
    ["an order still resting", "execution_pending", async () => { await history(); await db.insert(copyLiveExecutions).values(execution("k4", "resting")); }],
    ["a main-wallet withdrawal being confirmed", "withdrawal_pending", async () => { await history(); await db.insert(walletWithdrawals).values({ id: "withdrawal-open", userId: 1, network: "testnet",
      address: OWNER_MAIN, destination: OTHER, amount: "3", nonce: now + 9, status: "unknown", origin: "client", claimedAt: new Date(now), attemptedAt: new Date(now) }); }],
    ["a reward claim being paid", "referral_claim_pending", async () => { await history(); await db.insert(referralClaims).values({ id: "claim-open", userId: 1, key: "claim-open-key",
      requestHash: "a".repeat(64), policyVersion: "deletion-test", network: "mainnet", token: "USDC", destination: OTHER, amountUnits: "1", status: "unknown", attemptId: "claim-attempt", createdAt: new Date(), updatedAt: new Date() }); }],
    ["a copy account that still holds funds", "copy_account_not_empty", async () => { await history(); closure.isEmpty.mockResolvedValue(false); }],
  ];
  for (const [what, code, arrange] of cases) {
    it(`${what}: 409 ${code}, and nothing changes`, async () => {
      await arrange();
      const response = await deleteMe().expect(409);
      expect(response.body.error.code).toBe(code);
      if (code !== "withdrawal_pending" && code !== "referral_claim_pending") expect(response.body.error.details.strategyIds).toEqual([9]);
      expect(response.body.error.details.blockers[0]).toMatchObject({ code });
      expect(await db.select({ id: users.id }).from(users).where(eq(users.privyUserId, "did:privy:risk-source"))).toHaveLength(1);
      expect(await tombstones()).toHaveLength(0);
      expect((await db.select().from(copyWalletAuthorizations))[0]!.revokedAt).toBeNull();
    });
  }

  it("an exchange that can't be read answers 503 and deletes nothing", async () => {
    await history();
    closure.isEmpty.mockRejectedValue(new Error("down"));
    expect((await deleteMe().expect(503)).body.error.code).toBe("closure_check_unavailable");
    expect(await tombstones()).toHaveLength(0);
  });

  it("a start that failed after its deposit arrived (no generation ever) stops with the deletion: only funds left on the exchange block it", async () => {
    await history();
    const ABANDONED = `0x${"88".repeat(20)}`;
    await db.insert(copyStrategies).values({ id: 12, userId: 1, mode: "testnet", leaderAddress: OTHER, allocated: "0", cash: "0", status: "paused", pauseNewRisk: true, activatedAt: new Date(now) });
    await db.insert(copyExecutionAccounts).values({ id: "account-12", userId: 1, strategyId: 12, network: "testnet", state: "ready", address: ABANDONED, privyUserId: "did:privy:risk-source",
      externalId: "abandoned-master", privyWalletId: "master-12", ownerQuorumId: "owner" });
    await db.insert(copyFundingOperations).values(funding("66666666-6666-4666-8666-666666666666", { ...credited("d"), accountId: "account-12", strategyId: 12, destination: ABANDONED, nonce: now + 11, idempotencyKey: "fund-abandoned-1" }));
    await db.insert(copyLiveSetups).values(setup("failed", "failed", { ...consented, strategyId: 12, accountId: "account-12", leaderAddress: OTHER, issue: "setup_account_mode_failed",
      fundingOperationId: "66666666-6666-4666-8666-666666666666" }));
    // Its funds are still there: that is the blocker, not copies_active.
    closure.isEmpty.mockImplementation(async (_network, address) => address !== ABANDONED);
    const response = await deleteMe().expect(409);
    expect(response.body.error).toMatchObject({ code: "copy_account_not_empty", details: { strategyIds: [12] } });
    // Returned to the main wallet: the deletion goes through and the copy is stopped.
    closure.isEmpty.mockResolvedValue(true);
    await deleteMe().expect(204);
    expect((await db.select().from(copyStrategies).where(eq(copyStrategies.id, 12)))[0]).toMatchObject({ status: "stopped" });
  });

  it("what was prepared but never sent is cancelled, not blocking", async () => {
    await history();
    await db.insert(copyFundingOperations).values(funding("55555555-5555-4555-8555-555555555555", { nonce: now + 7, idempotencyKey: "fund-unsent-1" }));
    await db.insert(copyLiveSetups).values(setup("unsent", "awaiting_consent", { fundingOperationId: "55555555-5555-4555-8555-555555555555" }));
    await db.insert(walletWithdrawals).values({ id: "withdrawal-unsent", userId: 1, network: "testnet", address: OWNER_MAIN, destination: OTHER, amount: "3", nonce: now + 8, status: "prepared", origin: "client" });
    await deleteMe().expect(204);
    expect((await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, "unsent")))[0]!.stage).toBe("cancelled");
    expect((await db.select().from(copyFundingOperations).where(eq(copyFundingOperations.id, "55555555-5555-4555-8555-555555555555")))[0]!.status).toBe("cancelled");
    expect((await db.select().from(walletWithdrawals).where(eq(walletWithdrawals.id, "withdrawal-unsent")))[0]!.status).toBe("cancelled");
  });
});

describe("DELETE /me — a user with only history", () => {
  it("deletes cleanly: personal data is gone, kept records point at an anonymous tombstone, grants are revoked and the signer is detached", async () => {
    await history();
    await db.update(copyExecutionAccounts).set({ masterPolicyId: "policy-1", masterPolicyFingerprint: "c".repeat(64), masterSignerQuorumId: "worker", sweepDestination: OWNER_MAIN, signerAttachedAt: new Date(now) });

    await deleteMe().expect(204);

    // The person is gone, and nothing anywhere still holds their id.
    expect(await db.select().from(users).where(eq(users.privyUserId, "did:privy:risk-source"))).toHaveLength(0);
    for (const reference of Object.keys(USER_REFERENCES)) {
      const [table, column] = reference.split(".");
      const where = column === "scope_id" ? sql`scope = 'user' and scope_id = 1` : sql`${sql.identifier(column!)} = 1`;
      const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table!)} where ${where}`);
      expect(rows[0]!.n, reference).toBe(0);
    }
    const [tomb, ...more] = await tombstones();
    expect(more).toHaveLength(0);
    expect(tomb).toMatchObject({ email: null, walletAddress: null, embeddedWalletAddress: null, displayName: null, role: "user" });
    expect(tomb!.privyUserId).toMatch(/^deleted:[0-9a-f-]{36}$/);
    expect(tomb!.disabledAt).not.toBeNull();
    const t = tomb!.id;

    // Personal data and the paper copy went with the account.
    expect(await db.select().from(userFavorites)).toHaveLength(0);
    expect(await db.select().from(favoriteGroups)).toHaveLength(0);
    expect(await db.select().from(notificationChannels)).toHaveLength(0);
    expect(await db.select().from(paperAccounts)).toHaveLength(0);
    expect((await db.select().from(copyStrategies)).map((s) => [s.id, s.userId])).toEqual([[9, t]]);

    // Financial records are kept under the tombstone.
    expect((await db.select().from(copyExecutionAccounts))[0]).toMatchObject({ userId: t, signerDetachedAt: expect.any(Date) });
    expect((await db.select().from(copyLiveMandates))[0]!.userId).toBe(t);
    expect((await db.select().from(copyFundingOperations)).map((f) => f.userId)).toEqual([t, t]);
    expect((await db.select().from(copyLiveExecutions))[0]!.userId).toBe(t);
    expect((await db.select().from(copyLiveStopOperations))[0]!.userId).toBe(t);
    expect((await db.select().from(copyLiveSetups))[0]!.userId).toBe(t);
    expect((await db.select().from(walletWithdrawals))[0]!.userId).toBe(t);
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(1);
    // Invites: both sides see "a deleted user"; the code an invite used is
    // kept but never current, the unused one is deleted.
    expect(Object.fromEntries((await db.select().from(referralAttributions)).map((a) => [a.id, [a.referredUserId, a.referrerUserId]])))
      .toEqual({ "attr-owner": [t, inviter], "attr-invitee": [invitee, t] });
    expect((await db.select().from(referralCodes)).map((c) => [c.id, c.userId, c.isCurrent]).sort()).toEqual([["code-inviter", inviter, true], ["code-owner", t, false]]);

    // Grants and agents are revoked; Privy shows the worker off the wallet (the owner's browser removed it).
    const [grant] = await db.select().from(copyWalletAuthorizations);
    expect(grant).toMatchObject({ revokedAt: expect.any(Date), version: 5 });
    expect(await db.select().from(copyWalletAuthorizationEvents)).toEqual([expect.objectContaining({ authorizationId: "grant", userId: t, version: 5, action: "revoked" })]);
    expect((await db.select().from(copyAgentSetups))[0]).toMatchObject({ state: "revoked", issue: "account_deleted" });
    expect(closure.isEmpty).toHaveBeenCalledWith("testnet", account());
    expect(closure.assertSignerDetached).toHaveBeenCalledExactlyOnceWith("master");

    // One audit entry, counts only, under the tombstone.
    const [audit] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.event, "user.delete"));
    expect(audit).toMatchObject({ actorUserId: t, target: "user:1", beforeJson: { favorites: 1, groups: 1, telegramLinked: true },
      afterJson: expect.objectContaining({ tombstoneUserId: t, signersDetached: 1, revoked: { grants: 1, agents: 1 } }) });
    expect((audit!.afterJson as { kept: Record<string, number> }).kept).toMatchObject({ "copy_strategies.user_id": 1, "copy_funding_operations.user_id": 2, "wallet_withdrawals.user_id": 1 });
    expect(JSON.stringify([audit!.beforeJson, audit!.afterJson, audit!.target])).not.toMatch(/owner@example\.com|risk-source|0x5555/);

    // The same session can't reach the account (or the tombstone) any more.
    await request(app.getHttpServer()).get("/me").set("Authorization", "Bearer owner-token").expect(401);
  });

  it("a signer still on the wallet answers 409 copy_signer_attached, one Privy can't check 503; either deletes nothing", async () => {
    await history();
    await db.update(copyExecutionAccounts).set({ masterPolicyId: "policy-1", masterPolicyFingerprint: "c".repeat(64), masterSignerQuorumId: "worker", sweepDestination: OWNER_MAIN, signerAttachedAt: new Date(now) });
    closure.assertSignerDetached.mockRejectedValueOnce(new CopySignerAttached());
    expect((await deleteMe().expect(409)).body.error.code).toBe("copy_signer_attached");
    closure.assertSignerDetached.mockRejectedValueOnce(new Error("privy down"));
    expect((await deleteMe().expect(503)).body.error.code).toBe("closure_check_unavailable");
    expect(await tombstones()).toHaveLength(0);
    expect((await db.select().from(copyExecutionAccounts))[0]!.signerDetachedAt).toBeNull();
  });
});

describe("retention purges a deleted account's kept records after 365 days", () => {
  it("nothing before the period ends; then the tombstone and every record under it, never shared rows", async () => {
    await history();
    await deleteMe().expect(204);
    const t = (await tombstones())[0]!.id;
    const service = new RetentionService(new RetentionRepository(db), settings, new UnitOfWork(db));
    const day = 86_400_000;
    const early = await service.run(new Date(Date.now() + 364 * day), true);
    expect(early).toMatchObject({ ran: true, status: "ok", removed: { deleted_accounts: 0 } });
    expect(await tombstones()).toHaveLength(1);

    const late = await service.run(new Date(Date.now() + 366 * day), true);
    expect(late).toMatchObject({ ran: true, status: "ok", removed: { deleted_accounts: 1 } });
    expect(await tombstones()).toHaveLength(0);
    // Every table the purge covers is empty of the tombstone's records (the
    // other two users never had any) …
    for (const { table } of purgeStatements(t)) {
      if (["users", "referral_codes", "copy_controls", "copy_control_events"].includes(table)) continue;
      const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`);
      expect(rows[0]!.n, table).toBe(0);
    }
    // … while the other people and the leader's public fills stay.
    expect((await db.select({ id: users.id }).from(users)).map((u) => u.id).sort()).toEqual([inviter, invitee].sort());
    expect((await db.select().from(referralCodes)).map((c) => c.id)).toEqual(["code-inviter"]);
    expect(await db.select().from(copyLiveSourceFills)).toHaveLength(1);
    expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from copy_controls where scope = 'user'`)).rows[0]!.n).toBe(0);
  });
});

describe("deleting and signing up again can't farm invites (keyed identity hashes, 365 days)", () => {
  const page = { cursor: null, limit: 20 };
  it("a returning identity can't bind again or refer itself, and the inviter's count doesn't grow", async () => {
    const referrals = new ReferralRepository(db, app.get(AppConfig));
    await db.insert(referralCodes).values({ id: "code-inviter", userId: inviter, code: "INVITER1", kind: "custom" });
    const first = await insertUser(db, { privyUserId: "did:privy:returning", email: "Returning@Example.com", embeddedWalletAddress: `0x${"88".repeat(20)}` });
    await referrals.bind(first.id, "INVITER1");
    await referrals.setCode(first.id, "MYOLDCODE");
    expect((await referrals.friends(inviter, page)).invited).toBe(1);

    await app.get(AccountDeletionService).delete(first.id);
    // Only keyed hashes are kept: no Privy id, email or address in them.
    const markers = await db.select().from(accountDeletionMarkers);
    expect(markers).toHaveLength(3);
    expect(JSON.stringify(markers)).not.toMatch(/returning|example|8888/i);

    // Signing up again works, but binds nothing: not to the inviter again …
    const again = await insertUser(db, { privyUserId: "did:privy:returning", email: "returning@example.com", embeddedWalletAddress: `0x${"88".repeat(20)}` });
    await expect(referrals.bind(again.id, "INVITER1")).rejects.toMatchObject({ status: 409, response: { code: "referral_bind_closed" } });
    expect((await referrals.overview(again.id)).bindOpenUntil).toBeNull();
    // … nor to its own old code (reserved under the tombstone) …
    await expect(referrals.bind(again.id, "MYOLDCODE")).rejects.toMatchObject({ status: 404 });
    // … nor through another login with the same email.
    const twin = await insertUser(db, { privyUserId: "did:privy:returning-twin", email: "RETURNING@example.com" });
    await expect(referrals.bind(twin.id, "INVITER1")).rejects.toMatchObject({ status: 409, response: { code: "referral_bind_closed" } });
    // The inviter still counts the person once, as a deleted user.
    expect((await referrals.friends(inviter, page)).invited).toBe(1);
    // Someone new still binds normally.
    const stranger = await insertUser(db, { privyUserId: "did:privy:stranger" });
    await referrals.bind(stranger.id, "INVITER1");
    expect((await referrals.friends(inviter, page)).invited).toBe(2);

    // After the retention window the hashes are gone too.
    const service = new RetentionService(new RetentionRepository(db), settings, new UnitOfWork(db));
    expect(await service.run(new Date(Date.now() + 366 * 86_400_000), true)).toMatchObject({ removed: { account_deletion_markers: 3 } });
    expect(await db.select().from(accountDeletionMarkers)).toHaveLength(0);
  });
});
