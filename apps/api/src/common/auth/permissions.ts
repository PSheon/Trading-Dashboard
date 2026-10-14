import { SetMetadata } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { ROLE_PERMISSIONS, type Permission } from "@trading-dashboard/shared/contracts";
import type { RequestUser } from "./current-user.js";

export const PERMISSIONS_KEY = "app:permissions";
/** All listed permissions are required; method metadata adds to the class's (gap audit 2026-10-05). */
export const RequirePermissions = (first: Permission, ...rest: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, [first, ...rest]);

export function hasPermission(user: RequestUser | null, permission: Permission): boolean {
  if (!user) return false;
  const granted = user.kind === "service" ? user.permissions : ROLE_PERMISSIONS[user.role];
  return granted?.includes(permission) ?? false;
}

/** Every permission a route requires: its class's and its method's. */
export function requiredPermissions(reflector: Reflector, targets: Parameters<Reflector["getAllAndMerge"]>[1]): Permission[] {
  return [...new Set(reflector.getAllAndMerge<Permission[]>(PERMISSIONS_KEY, targets) ?? [])];
}
