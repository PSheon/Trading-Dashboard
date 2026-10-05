import "reflect-metadata";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { findHttpContract } from "@trading-dashboard/shared/contracts";
import { describe, expect, it } from "vitest";

import { documentationControllers } from "../src/bootstrap/documentation-controllers.js";

/** Every route the api serves, from the controllers' metadata ("GET /admin/users"). */
function routes(): Set<string> {
  const out = new Set<string>();
  for (const controller of documentationControllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
      if (typeof handler !== "function" || name === "constructor") continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (path === undefined || method === undefined) continue;
      const full = `/${[base, String(path)].map((p) => p.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`;
      out.add(`${RequestMethod[method]} ${full}`);
    }
  }
  return out;
}

describe("routes removed by the admin simplification (2026-10-05)", () => {
  const served = routes();
  it.each([
    ["GET", "/admin/system/heartbeat"],
    ["GET", "/admin/outbox"],
    ["GET", "/lists/diff"],
  ])("%s %s is neither served nor in the HTTP contract (no caller)", (method, path) => {
    expect(served.has(`${method} ${path}`)).toBe(false);
    expect(findHttpContract(method as "GET", path)).toBeUndefined();
  });

  it("what replaced them is still there", () => {
    for (const route of ["GET /admin/system/overview", "GET /lists", "GET /admin/data-sources", "GET /admin/settings/runtime"]) {
      expect(served.has(route), route).toBe(true);
    }
  });
});
