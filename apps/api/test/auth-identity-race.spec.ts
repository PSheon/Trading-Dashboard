import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminAuditLogs, users } from "@trading-dashboard/shared/database";
import { AuthRepository } from "../src/common/auth/auth.repository.js";
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from "./db-test-utils.js";

let db: TestDb;
let repository: AuthRepository;
const did = "did:privy:concurrent-owner";
const wallet = `0x${"ab".repeat(20)}`;
const input = { privyUserId: did, email: "owner@example.com", walletAddress: null, embeddedWalletAddress: wallet, role: "user" as const };
const conflict = () => Object.assign(new Error("Query failed"), { cause: { code: "23505" } });
beforeAll(() => { db = getTestDb(); repository = new AuthRepository(db); });
beforeEach(async () => { await truncateAll(db); });
afterEach(() => vi.restoreAllMocks());
afterAll(closeTestDb);

describe("concurrent identity conflict recovery", () => {
  it("recovers a wrapped non-arbiter unique conflict only after reading the committed same-DID winner", async () => {
    const winner = await insertUser(db, { privyUserId: did, embeddedWalletAddress: wallet });
    vi.spyOn(db, "insert").mockImplementationOnce(() => { throw conflict(); });
    expect(await repository.createIfAbsent(input)).toBeUndefined();
    expect(await repository.findByPrivyId(did)).toMatchObject({ id: winner.id, role: "user", embeddedWalletAddress: wallet });
    expect(await db.select().from(users)).toHaveLength(1);
  });
  it("does not turn another identity's wallet collision into a successful registration", async () => {
    const owner = await insertUser(db, { privyUserId: "did:privy:other-owner", embeddedWalletAddress: wallet });
    await expect(repository.createIfAbsent(input)).rejects.toThrow();
    expect(await repository.findByPrivyId(did)).toBeUndefined();
    expect(await db.select().from(users)).toEqual([owner]);
  });
  it("a recovered disabled identity remains disabled and its role is never overwritten", async () => {
    const disabledAt = new Date();
    const winner = await insertUser(db, { privyUserId: did, embeddedWalletAddress: wallet, role: "user", disabledAt });
    vi.spyOn(db, "insert").mockImplementationOnce(() => { throw conflict(); });
    expect(await repository.createIfAbsent({ ...input, role: "admin" })).toBeUndefined();
    expect(await repository.findByPrivyId(did)).toEqual(winner);
  });
  it("reads a bootstrap winner outside the failed transaction without restoring a demoted role or creating an audit", async () => {
    const winner = await insertUser(db, { privyUserId: did, embeddedWalletAddress: wallet, role: "user" });
    vi.spyOn(db, "transaction").mockRejectedValueOnce(conflict());
    expect(await repository.createBootstrapCandidate(input)).toBeUndefined();
    expect(await repository.findByPrivyId(did)).toEqual(winner);
    expect(await db.select().from(adminAuditLogs)).toHaveLength(0);
  });
  it("does not suppress unrelated database failures even when that identity exists", async () => {
    await insertUser(db, { privyUserId: did, embeddedWalletAddress: wallet });
    const failure = Object.assign(new Error("Database unavailable"), { cause: { code: "40001" } });
    vi.spyOn(db, "insert").mockImplementationOnce(() => { throw failure; });
    await expect(repository.createIfAbsent(input)).rejects.toBe(failure);
  });
});
