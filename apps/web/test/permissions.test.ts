import { describe, expect, it } from "vitest";
import { OPERATOR_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS } from "@trading-dashboard/shared/contracts";
import { hasPermission } from "../src/lib/permissions";

describe("effective permissions", () => {
  it("fails closed while absent and does not infer permissions from role", () => {
    expect(hasPermission(undefined, "admin.access")).toBe(false);
    expect(hasPermission({ permissions: [] }, "admin.access")).toBe(false);
    expect(hasPermission({ permissions: ["users.read"] }, "users.manage")).toBe(false);
    expect(hasPermission({ permissions: ["users.read"] }, "users.read")).toBe(true);
  });

  it("an operator opens the admin area, reads and may stop copying; every other control that writes stays off", () => {
    const operator = { permissions: ROLE_PERMISSIONS.operator };
    expect(ROLE_PERMISSIONS.operator).toBe(OPERATOR_PERMISSIONS);
    for (const read of ["admin.access", "users.read", "settings.read", "copy.read", "audit.read", "jobs.read", "revenue.read", "execution.pause"] as const) {
      expect(hasPermission(operator, read), read).toBe(true);
    }
    const writes = PERMISSIONS.filter((p) => !OPERATOR_PERMISSIONS.includes(p));
    expect(writes).toEqual(["jobs.retry", "settings.write", "users.manage", "leaders.manage", "leaders.import", "rules.manage", "kols.manage", "execution.resume", "risk.manage"]);
    for (const write of writes) expect(hasPermission(operator, write), write).toBe(false);
  });
});
