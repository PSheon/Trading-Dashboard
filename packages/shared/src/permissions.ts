import type { UserRole } from "./enums.js";

/** Application authorization. Privy authenticates identity, not these grants. */
export const PERMISSIONS = [
  "admin.access", "overview.read", "revenue.read", "settings.read", "settings.write",
  "users.read", "users.manage", "lists.read", "leaders.manage", "leaders.import",
  "rules.read", "rules.manage", "alerts.readAll",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  user: [],
  admin: PERMISSIONS,
};
