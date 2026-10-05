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
 * Two fixed role packs (Paul, 2026-10-05): **admin** holds every grant;
 * **operator** reads and stops. The operator enters the admin area, holds
 * every `*.read` grant plus `alerts.readAll`, and may send the copy stop
 * commands (`execution.pause`: pause new risk, reduce only, cancel pending,
 * close positions, platform-wide or for one user) — resuming, risk limits,
 * settings, users, lists, rules, jobs and KOLs stay with the admin. The KOL
 * registry is behind `kols.manage` (reads included), so an operator does not
 * see it. The individual grants remain for the service token
 * (AUTH_SERVICE_PERMISSIONS); people get one of the packs by their role.
 */
export const OPERATOR_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) =>
  p === "admin.access" || p === "alerts.readAll" || p === "execution.pause" || p.endsWith(".read"));
export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  user: [],
  operator: OPERATOR_PERMISSIONS,
  admin: PERMISSIONS,
};
