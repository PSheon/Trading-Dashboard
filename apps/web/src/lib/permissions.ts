import type { Permission } from "@trading-dashboard/shared/contracts";

/** Display policy only. The API enforces permissions on every request. */
export function hasPermission(me: { permissions: readonly Permission[] } | undefined, permission: Permission): boolean {
  return me?.permissions.includes(permission) ?? false;
}
