import { adminSettingsSchema, type AdminSettings, type AppSettingsKey } from "@trading-dashboard/shared/contracts";

/** Missing rows use bootstrap defaults; malformed persisted switches fail closed. */
export function recoverSettingsSection<K extends AppSettingsKey>(key: K, raw: unknown, stored = true): { value: AdminSettings[K]; invalid: boolean } {
  const schema = adminSettingsSchema.shape[key];
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const sensitive = (field: string) => field === "signupsOpen" || field === "copyTradingEnabled" || field === "alertsEnabled";
  const invalidSwitch = stored && Object.keys(schema.shape).some(field => sensitive(field) && typeof input[field] !== "boolean");
  const parsed = schema.safeParse(raw);
  if (parsed.success && !invalidSwitch) return { value: parsed.data as AdminSettings[K], invalid: false };
  const defaults = schema.parse({}) as Record<string, unknown>;
  const value = Object.fromEntries(Object.entries(schema.shape).map(([field, fieldSchema]) => {
    const candidate = fieldSchema.safeParse(input[field]);
    if (stored && sensitive(field) && typeof input[field] !== "boolean") return [field, false];
    return [field, candidate.success ? candidate.data : defaults[field]];
  })) as AdminSettings[K];
  return { value, invalid: true };
}
