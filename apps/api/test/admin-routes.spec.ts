import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { RequestMethod } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { AdminController, PublicSettingsController } from "../src/admin/admin.controller.js";
import { PERMISSIONS_KEY } from "../src/common/auth/permissions.js";
import { IS_PUBLIC_KEY } from "../src/common/auth/public.decorator.js";

type Handler = (...args: unknown[]) => unknown;

function routesOf(controller: { prototype: object }): { name: string; handler: Handler; method: string; path: string }[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor" && typeof proto[name] === "function")
    .map((name) => ({ name, handler: proto[name] as Handler }))
    .filter(({ handler }) => Reflect.getMetadata(PATH_METADATA, handler) !== undefined)
    .map(({ name, handler }) => ({
      name,
      handler,
      method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number],
      path: Reflect.getMetadata(PATH_METADATA, handler) as string,
    }));
}

describe("admin route metadata", () => {
  const reflector = new Reflector();

  it("exposes exactly the admin routes of the contract", () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminController)).toBe("admin");
    const routes = routesOf(AdminController).map((r) => `${r.method} /admin/${r.path}`).sort();
    expect(routes).toEqual([
      "GET /admin/overview",
      "GET /admin/revenue",
      "GET /admin/settings",
      "GET /admin/users",
      "PATCH /admin/settings",
      "PATCH /admin/users/:id",
    ]);
  });

  it("requires a specific permission on every administrative handler", () => {
    const expected: Record<string, string> = {
      getSettings: "settings.read", patchSettings: "settings.write",
      listUsers: "users.read", patchUser: "users.manage",
      overview: "overview.read", revenueReport: "revenue.read",
    };
    for (const { name, handler } of routesOf(AdminController)) {
      expect(reflector.get(PERMISSIONS_KEY, handler), name).toEqual([expected[name]]);
      expect(reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, AdminController]), name).toBeUndefined();
    }
  });

  it("marks GET /settings @Public() with no permission requirement", () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicSettingsController)).toBe("settings");
    const routes = routesOf(PublicSettingsController);
    expect(routes.map((r) => r.method)).toEqual(["GET"]);
    const [{ handler }] = routes;
    expect(reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, PublicSettingsController])).toBe(true);
    expect(reflector.getAllAndOverride(PERMISSIONS_KEY, [handler, PublicSettingsController])).toBeUndefined();
  });
});
