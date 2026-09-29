import { PERMISSIONS, type Permission } from "@trading-dashboard/shared";

/** Errors name keys only: never interpolate secrets or connection strings. */
export function booleanValue(key: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${key} must be true, false, 1 or 0`);
}

export function integerValue(key: string, raw: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function servicePermissions(raw: string | undefined): Permission[] {
  if (!raw?.trim()) return [];
  const names = raw.split(",").map((name) => name.trim());
  if (names.some((name) => !(PERMISSIONS as readonly string[]).includes(name))) {
    throw new Error("AUTH_SERVICE_PERMISSIONS contains an unknown permission");
  }
  return [...new Set(names)] as Permission[];
}

export function databaseUrl(raw: string | undefined): string {
  if (!raw?.trim()) throw new Error("DATABASE_URL is required");
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length <= 1 || url.hash) throw new Error();
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL with a host and database name");
  }
  return raw;
}
