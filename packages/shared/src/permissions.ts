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
/**
 * What a read-only operator may do: enter the admin area and read. Every
 * `*.read` grant plus `alerts.readAll`; nothing that changes state. The
 * KOL registry is behind `kols.manage` (reads included), so an operator
 * does not see it.
 */
export const OPERATOR_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) => p === "admin.access" || p === "alerts.readAll" || p.endsWith(".read"));
export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  user: [],
  operator: OPERATOR_PERMISSIONS,
  admin: PERMISSIONS,
};
