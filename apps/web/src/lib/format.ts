/** Shared display formatting for D1-D5. §11 決策紀錄 "時區": DB is UTC, the
 * frontend displays Asia/Taipei. */
const TAIPEI_TZ = "Asia/Taipei";

export function formatUsd(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(0)}%`;
}

export function formatNumber(value: number | string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "n/a";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "n/a";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("en-US", { timeZone: TAIPEI_TZ, hour12: false });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "n/a";
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.round(seconds / 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function leaderLabel(leader: { label?: string | null; address: string }): string {
  return leader.label ?? truncateAddress(leader.address);
}
