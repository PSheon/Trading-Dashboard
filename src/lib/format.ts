// Display formatting shared by server and client components. Pure, UTC only,
// so server-rendered and hydrated output agree.

export const DASH = "–";

// A value that rounds to zero prints without a sign, never as "-0.000".
function fixed(v: number, digits: number): string {
  const out = v.toFixed(digits);
  return /^-0(\.0*)?$/.test(out) ? out.slice(1) : out;
}

export const sol = (v: number | null | undefined, digits = 3) =>
  v == null ? DASH : `${v > 0 ? "+" : ""}${fixed(v, digits)}`;
export const num = (v: number | null | undefined, digits = 3) => (v == null ? DASH : fixed(v, digits));
export const pct = (v: number | null | undefined) => (v == null ? DASH : `${fixed(v * 100, 1)}%`);
export const int = (v: number | null | undefined) => (v == null ? DASH : v.toLocaleString("en-US"));

export function dur(s: number | null | undefined): string {
  if (s == null) return DASH;
  const a = Math.abs(s);
  if (a < 60) return `${Math.round(s)}s`;
  if (a < 3600) return `${(s / 60).toFixed(1)}m`;
  if (a < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export const time = (ts: number | null | undefined) =>
  ts == null ? DASH : new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");

/** Relative to `now`, which the server passes down so both renders agree. */
export const ago = (ts: number | null | undefined, now: number) =>
  ts == null ? DASH : now < ts ? time(ts) : `${dur(now - ts)} ago`;

export const short = (addr: string | null | undefined) => (addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : DASH);

export const compact = (v: number | null | undefined) =>
  v == null ? DASH : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);

// SOL per token: plain decimals down to 0.01, scientific below, so a column lines up.
export const price = (v: number | null | undefined) =>
  v == null ? DASH : v >= 0.01 ? v.toPrecision(3) : v.toExponential(2);

export const signClass = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "pos" : "neg");

export const links = {
  solscanAccount: (a: string) => `https://solscan.io/account/${a}`,
  solscanToken: (m: string) => `https://solscan.io/token/${m}`,
  solscanTx: (s: string) => `https://solscan.io/tx/${s}`,
  gmgn: (a: string) => `https://gmgn.ai/sol/address/${a}`,
};
