import { SetMetadata } from "@nestjs/common";
import { ROLE_PERMISSIONS, type Permission } from "@trading-dashboard/shared";
import type { RequestUser } from "./current-user.js";

export const PERMISSIONS_KEY = "app:permissions";
/** All listed permissions are required. Method metadata overrides the class default. */
export const RequirePermissions = (first: Permission, ...rest: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, [first, ...rest]);

export function hasPermission(user: RequestUser | null, permission: Permission): boolean {
  if (!user) return false;
  const granted = user.kind === "service" ? user.permissions : ROLE_PERMISSIONS[user.role];
  return granted?.includes(permission) ?? false;
}
