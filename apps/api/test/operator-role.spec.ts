import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { OPERATOR_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "@trading-dashboard/shared/contracts";
import { describe, expect, it } from "vitest";

import { documentationControllers } from "../src/bootstrap/documentation-controllers.js";
import { PERMISSIONS_KEY } from "../src/common/auth/permissions.js";
import { IS_PUBLIC_KEY } from "../src/common/auth/public.decorator.js";

interface Route { method: string; path: string; permissions: Permission[]; isPublic: boolean }

/** Every HTTP route of the api with the permissions its handler (or, failing that, its controller) requires. */
function routes(): Route[] {
  const out: Route[] = [];
  for (const controller of documentationControllers) {
    const base = String(Reflect.getMetadata("path", controller) ?? "");
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, object>)[name];
      const method = typeof handler === "function" ? Reflect.getMetadata("method", handler) : undefined;
      if (method === undefined) continue;
      const path = `/${[base, String(Reflect.getMetadata("path", handler) ?? "")].filter((p) => p && p !== "/").join("/")}`;
      out.push({
        method: RequestMethod[method as RequestMethod], path,
        permissions: Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? Reflect.getMetadata(PERMISSIONS_KEY, controller) ?? [],
        isPublic: Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, controller)),
      });
    }
  }
  return out;
}

describe("the operator pack: read-only plus the copy stop commands (review finding 14; Paul 2026-10-05)", () => {
  const operator = new Set<Permission>(ROLE_PERMISSIONS.operator);
  const all = routes();

  it("is exactly: enter the admin area, every *.read grant, reading every user's alerts, and the stop commands", () => {
    expect([...operator].sort()).toEqual([
      "admin.access", "alerts.readAll", "audit.read", "copy.read", "execution.pause", "jobs.read", "lists.read", "overview.read", "revenue.read",
      "rules.read", "settings.read", "sources.read", "traders.read", "users.read",
    ]);
    expect(ROLE_PERMISSIONS.operator).toBe(OPERATOR_PERMISSIONS);
    // A new *.read permission joins the pack by its name; a new write permission never does.
    for (const p of PERMISSIONS) expect(operator.has(p), p).toBe(p.endsWith(".read") || p === "admin.access" || p === "alerts.readAll" || p === "execution.pause");
    expect(operator.has("execution.resume")).toBe(false);
    expect(operator.has("risk.manage")).toBe(false);
    expect(ROLE_PERMISSIONS.user).toEqual([]);
    expect(ROLE_PERMISSIONS.admin).toBe(PERMISSIONS);
  });

  it("the only routes that change anything the operator's grants satisfy are the copy stops", () => {
    const writes = all.filter((r) => r.method !== "GET" && r.permissions.length > 0);
    expect(writes.length).toBeGreaterThan(10);
    const open = writes.filter((r) => r.permissions.every((p) => operator.has(p)));
    // POST /admin/copy/controls carries execution.pause on the route itself
    // (the service still asks execution.resume for resume, admin only); a
    // testnet copy's grant revoke stops that copy at once, under the same grant.
    expect(open.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["POST /admin/copy/controls", "POST /admin/copy/live/grants/:id/revoke"]);
    for (const route of open) expect(route.permissions).toContain("execution.pause");
  });

  it("every admin route requires a permission, and the operator can read each admin page except the KOL registry", () => {
    const admin = all.filter((r) => r.path.startsWith("/admin"));
    expect(admin.filter((r) => r.permissions.length === 0)).toEqual([]);
    expect(admin.filter((r) => r.isPublic)).toEqual([]);
    const unreadable = admin.filter((r) => r.method === "GET" && !r.permissions.every((p) => operator.has(p)));
    expect(unreadable.map((r) => r.path)).toEqual(["/admin/kols"]);
  });
});
