import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_COPY_RISK_LIMITS, copyRiskLimitsSchema } from "@trading-dashboard/shared/contracts";
import { copyControls, copyRiskPolicies } from "@trading-dashboard/shared/database";
import { asc, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

/**
 * One-click testnet copy, step 2 (plan §3e, Paul's decision 5): live copy
 * preparation and the live risk authority need the platform control row and
 * an explicit risk policy; migration 0062 writes both on a fresh deployment.
 */
const db = getTestDb();
const migration = readFileSync(fileURLToPath(new URL("../../../packages/shared/drizzle/0062_copy_platform_control_seed.sql", import.meta.url)), "utf8");
const apply = async () => { for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement)); };

beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);

describe("migration 0062: the platform control row and risk policy v1", () => {
  it("seeds a clear platform row and today's defaults as policy v1, once", async () => {
    await apply();
    await apply();
    expect(await db.select().from(copyControls)).toEqual([expect.objectContaining({ scope: "platform", scopeId: 0, pauseNewRisk: false, reduceOnly: false, revision: 0 })]);
    const policies = await db.select().from(copyRiskPolicies);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ reason: "seeded defaults", createdByUserId: null });
    // Exactly the shared defaults: the live check needs every key present.
    expect(policies[0]!.limits).toEqual(DEFAULT_COPY_RISK_LIMITS);
    expect(copyRiskLimitsSchema.parse(policies[0]!.limits)).toEqual(DEFAULT_COPY_RISK_LIMITS);
  });

  it("keeps an admin's paused platform row and saved policy as they are", async () => {
    await db.insert(copyControls).values({ scope: "platform", scopeId: 0, pauseNewRisk: true, reduceOnly: true, revision: 4 });
    await db.insert(copyRiskPolicies).values({ limits: { ...DEFAULT_COPY_RISK_LIMITS, maxLeverage: 3 }, reason: "admin", createdByUserId: null });
    await apply();
    expect(await db.select().from(copyControls)).toEqual([expect.objectContaining({ pauseNewRisk: true, reduceOnly: true, revision: 4 })]);
    const policies = await db.select().from(copyRiskPolicies).orderBy(asc(copyRiskPolicies.version));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ reason: "admin", limits: expect.objectContaining({ maxLeverage: 3 }) });
  });
});
