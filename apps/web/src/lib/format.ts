import { TIME_ZONE, type Locale } from "@/i18n/config";

/**
 * Locale-aware number/currency/percent/time formatting, all through `Intl`
 * with the active locale (zh-TW compact figures use 萬/億, English K/M/B).
 * Times are always Asia/Taipei. Use `useFormat()` in components; this
 * factory exists so the formatters are built once per locale.
 */

type Numeric = number | string | null | undefined;
type DateLike = Date | string | number | null | undefined;

export function toNumber(value: Numeric): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value: DateLike): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface UsdOptions {
  compact?: boolean;
  /** Always show + / − (PnL figures). */
  sign?: boolean;
  /** Fraction digits for the non-compact form (default 0 for ≥ $1,000). */
  digits?: number;
}

export interface Formatter {
  locale: Locale;
  usd(value: Numeric, options?: UsdOptions): string;
  /** `value` is a ratio: 0.125 → 12.5%. */
  pct(value: Numeric, options?: { sign?: boolean; digits?: number }): string;
  num(value: Numeric, digits?: number): string;
  compactNum(value: Numeric): string;
  /** Price with sensible precision for its magnitude. */
  price(value: Numeric): string;
  dateTime(value: DateLike): string;
  date(value: DateLike): string;
  time(value: DateLike): string;
  /** Short date for chart axes ("26年9月" / "Sep 26"). */
  axisDate(value: DateLike, span: "hours" | "days" | "months"): string;
  relative(value: DateLike, now?: number): string;
  duration(seconds: Numeric): string;
}

const DASH = "—";

export function createFormatter(locale: Locale): Formatter {
  const cache = new Map<string, Intl.NumberFormat>();
  const nf = (key: string, options: Intl.NumberFormatOptions) => {
    let f = cache.get(key);
    if (!f) {
      f = new Intl.NumberFormat(locale, options);
      cache.set(key, f);
    }
    return f;
  };

  const dtCache = new Map<string, Intl.DateTimeFormat>();
  const df = (key: string, options: Intl.DateTimeFormatOptions) => {
    let f = dtCache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, ...options });
      dtCache.set(key, f);
    }
    return f;
  };

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });

  return {
    locale,

    usd(value, options = {}) {
      const n = toNumber(value);
      if (n === null) return DASH;
      const { compact = false, sign = false } = options;
      const signDisplay = sign ? "exceptZero" : "auto";
      if (compact && Math.abs(n) >= 1000) {
        return nf(`usdc-${sign}`, {
          style: "currency",
          currency: "USD",
          currencyDisplay: "narrowSymbol",
          notation: "compact",
          maximumSignificantDigits: 3,
          signDisplay,
        }).format(n);
      }
      const digits = options.digits ?? (Math.abs(n) >= 1000 || n === 0 ? 0 : 2);
      return nf(`usd-${sign}-${digits}`, {
        style: "currency",
        currency: "USD",
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        signDisplay,
      }).format(n);
    },

    pct(value, options = {}) {
      const n = toNumber(value);
      if (n === null) return DASH;
      const { sign = false } = options;
      const abs = Math.abs(n);
      const digits = options.digits ?? (abs >= 10 ? 0 : abs >= 1 ? 1 : 2);
      return nf(`pct-${sign}-${digits}`, {
        style: "percent",
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
        signDisplay: sign ? "exceptZero" : "auto",
      }).format(n);
    },

    num(value, digits = 2) {
      const n = toNumber(value);
      if (n === null) return DASH;
      return nf(`num-${digits}`, { maximumFractionDigits: digits }).format(n);
    },

    compactNum(value) {
      const n = toNumber(value);
      if (n === null) return DASH;
      return nf("cnum", { notation: "compact", maximumSignificantDigits: 3 }).format(n);
    },

    price(value) {
      const n = toNumber(value);
      if (n === null) return DASH;
      const abs = Math.abs(n);
      const digits = abs >= 1000 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 7;
      return nf(`px-${digits}`, {
        style: "currency",
        currency: "USD",
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
      }).format(n);
    },

    dateTime(value) {
      const d = toDate(value);
      if (!d) return DASH;
      return df("dt", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
    },

    date(value) {
      const d = toDate(value);
      if (!d) return DASH;
      return df("d", { dateStyle: "long" }).format(d);
    },

    time(value) {
      const d = toDate(value);
      if (!d) return DASH;
      return df("t", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
    },

    axisDate(value, span) {
      const d = toDate(value);
      if (!d) return "";
      if (span === "hours") return df("ah", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
      if (span === "days") return df("ad", { month: "numeric", day: "numeric" }).format(d);
      return df("am", { year: "2-digit", month: "short" }).format(d);
    },

    relative(value, now = Date.now()) {
      const d = toDate(value);
      if (!d) return DASH;
      const seconds = Math.round((d.getTime() - now) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 60) return rtf.format(seconds, "second");
      if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
      if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
      // A holder's last trade can be months back: "3 個月前", not "92 天前".
      if (abs < 45 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
      if (abs < 365 * 86400) return rtf.format(Math.round(seconds / (30.44 * 86400)), "month");
      return rtf.format(Math.round(seconds / (365.25 * 86400)), "year");
    },

    duration(value) {
      const seconds = toNumber(value);
      if (seconds === null) return DASH;
      const unit = (u: "minute" | "hour" | "day", n: number, digits: number) =>
        nf(`dur-${u}-${digits}`, {
          style: "unit",
          unit: u,
          unitDisplay: "narrow",
          maximumFractionDigits: digits,
        }).format(n);
      if (seconds < 3600) return unit("minute", Math.round(seconds / 60), 0);
      if (seconds < 48 * 3600) return unit("hour", seconds / 3600, 1);
      return unit("day", seconds / 86400, 1);
    },
  };
}

export function truncateAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function traderName(trader: { displayName?: string | null; address: string }): string {
  return trader.displayName?.trim() || truncateAddress(trader.address);
}

/** Hyperliquid coin ids carry a dex prefix for builder-deployed markets
 * ("xyz:TSLA") and an index for spot ("@107"). */
export function coinLabel(coin: string): string {
  const i = coin.indexOf(":");
  return i >= 0 ? coin.slice(i + 1) : coin;
}

export function coinDex(coin: string): string | null {
  const i = coin.indexOf(":");
  return i >= 0 ? coin.slice(0, i) : null;
}

export function signClass(value: Numeric): string {
  const n = toNumber(value);
  if (n === null || n === 0) return "text-foreground";
  return n > 0 ? "text-positive" : "text-negative";
}
