import { describe, expect, it } from "vitest";
import { hasPermission } from "../src/lib/permissions";

describe("effective permissions", () => {
  it("fails closed while absent and does not infer permissions from role", () => {
    expect(hasPermission(undefined, "admin.access")).toBe(false);
    expect(hasPermission({ permissions: [] }, "admin.access")).toBe(false);
    expect(hasPermission({ permissions: ["users.read"] }, "users.manage")).toBe(false);
    expect(hasPermission({ permissions: ["users.read"] }, "users.read")).toBe(true);
  });
});
