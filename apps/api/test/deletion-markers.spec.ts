import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountDeletionMarkers } from "@trading-dashboard/shared/database";

import type { AppConfig } from "../src/config/app-config.js";
import { isReturningIdentity, recordDeletedIdentity, type DeletedIdentity } from "../src/users/deletion-markers.js";
import { closeTestDb, getTestDb, truncateAll, type TestDb } from "./db-test-utils.js";

/**
 * The deletion markers' key (logic review 2026-10-06 §D): its own secret,
 * ACCOUNT_DELETION_MARKER_KEY, so rotating the Privy app secret can't make a
 * year of markers stop matching; a rotated marker key is kept as a previous
 * key; markers made before the key existed (under the key derived from
 * PRIVY_APP_SECRET) keep matching once it is set.
 */
const config = (appSecret: string, key?: string, previousKeys: string[] = []) =>
  ({ value: { auth: { appSecret, serviceToken: undefined, deletionMarker: { key, previousKeys } } } }) as unknown as AppConfig;
const person: DeletedIdentity = { privyUserId: "did:privy:returning", email: "returning@example.com", walletAddress: null, embeddedWalletAddress: `0x${"88".repeat(20)}` };
let db: TestDb;
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);

describe("deletion markers' key", () => {
  it("rotating the Privy app secret leaves markers made under the marker key matching", async () => {
    await recordDeletedIdentity(db, person, config("privy-secret-one", "marker-key-a"));
    expect(await isReturningIdentity(db, person, config("privy-secret-two", "marker-key-a"))).toBe(true);
  });

  it("markers made before the marker key existed keep matching once it is set", async () => {
    await recordDeletedIdentity(db, person, config("privy-secret-one"));
    expect(await isReturningIdentity(db, person, config("privy-secret-one", "marker-key-a"))).toBe(true);
    // New markers are made under the marker key, not the derived one.
    await truncateAll(db);
    await recordDeletedIdentity(db, person, config("privy-secret-one", "marker-key-a"));
    expect(await isReturningIdentity(db, person, config("privy-secret-one"))).toBe(false);
  });

  it("a rotated marker key keeps matching while it is listed as a previous key", async () => {
    await recordDeletedIdentity(db, person, config("privy-secret-one", "marker-key-a"));
    expect(await isReturningIdentity(db, person, config("privy-secret-one", "marker-key-b", ["marker-key-a"]))).toBe(true);
    expect(await isReturningIdentity(db, person, config("privy-secret-one", "marker-key-b"))).toBe(false);
    // Only keyed hashes: nothing of the identity in the rows.
    expect(JSON.stringify(await db.select().from(accountDeletionMarkers))).not.toMatch(/returning|example|8888/i);
  });
});
