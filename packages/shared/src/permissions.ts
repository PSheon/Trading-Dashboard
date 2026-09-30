import type { UserRole } from "./enums.js";

/** Application authorization. Privy authenticates identity, not these grants. */
export const PERMISSIONS = [
  "admin.access", "audit.read", "jobs.read", "jobs.retry", "overview.read", "revenue.read", "settings.read", "settings.write",
  "sources.read", "traders.read", "users.read", "users.manage", "lists.read", "leaders.manage", "leaders.import",
  "rules.read", "rules.manage", "alerts.readAll", "kols.manage",
  // Copy trading (review A06): reading copy state, stopping and resuming execution, and risk limits are separate grants.
  "copy.read", "execution.pause", "execution.resume", "risk.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  user: [],
  admin: PERMISSIONS,
};
