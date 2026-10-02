import { localeEnum, type Locale } from "@trading-dashboard/shared/contracts";

/** Chinese tags without a region we list: script and region decide. */
const TRADITIONAL = /^zh-(hant|tw|hk|mo)\b/;

function match(tag: string): Locale | undefined {
  const lower = tag.toLowerCase();
  const exact = localeEnum.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  if (lower === "zh" || lower.startsWith("zh-")) return TRADITIONAL.test(lower) ? "zh-TW" : "zh-CN";
  const primary = lower.split("-")[0];
  return localeEnum.find((l) => l === primary);
}

/**
 * The first supported language of an `Accept-Language` header, in the
 * order the client prefers them (q-values honoured). The web app sends the
 * language the page is shown in; any other client sends its own
 * preference. Undefined when nothing listed is supported or the header is
 * absent: the caller keeps its default.
 */
export function preferredLocale(header: string | string[] | undefined): Locale | undefined {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw || raw.length > 400) return undefined;
  const tags = raw.split(",").map((part, index) => {
    const [tag, ...params] = part.trim().split(";");
    const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    const weight = q === undefined ? 1 : Number(q);
    return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
  }).filter((t) => t.tag && t.tag !== "*" && t.weight > 0);
  tags.sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of tags) {
    const locale = match(tag);
    if (locale) return locale;
  }
  return undefined;
}
