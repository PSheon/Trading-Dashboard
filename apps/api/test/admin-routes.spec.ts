import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { RequestMethod } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { AdminController, PublicSettingsController } from "../src/admin/admin.controller.js";
import { ROLES_KEY } from "../src/common/auth/current-user.js";
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

  it("marks every admin route @Roles('admin') on the handler and the class, and none @Public()", () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminController)).toEqual(["admin"]);
    for (const { name, handler } of routesOf(AdminController)) {
      expect(reflector.get(ROLES_KEY, handler), name).toEqual(["admin"]);
      expect(reflector.getAllAndOverride(ROLES_KEY, [handler, AdminController]), name).toEqual(["admin"]);
      expect(reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, AdminController]), name).toBeUndefined();
    }
  });

  it("marks GET /settings @Public() with no role", () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicSettingsController)).toBe("settings");
    const routes = routesOf(PublicSettingsController);
    expect(routes.map((r) => r.method)).toEqual(["GET"]);
    const [{ handler }] = routes;
    expect(reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, PublicSettingsController])).toBe(true);
    expect(reflector.getAllAndOverride(ROLES_KEY, [handler, PublicSettingsController])).toBeUndefined();
  });
});
