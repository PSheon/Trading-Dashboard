import { cn } from "cn";

import { APP_NAME } from "@/lib/config";

/**
 * The Orbie mark (docs/Orbie Logo.html): an orange planet with a ring tilted
 * −22° and a moon, on a 100×100 box. The ring's back half is drawn first,
 * then the planet, then the front half and the moon, so the ring passes
 * behind and in front of the planet.
 */
export type MarkVariant = "dark" | "light" | "app" | "auto";

export const BRAND = {
  orange: "#ff7a45",
  navy: "#1e1b3a",
  cream: "#fbf6ee",
} as const;

const COLORS: Record<MarkVariant, { ring: string; planet: string }> = {
  dark: { ring: BRAND.cream, planet: BRAND.orange },
  light: { ring: BRAND.navy, planet: BRAND.orange },
  app: { ring: BRAND.navy, planet: BRAND.cream },
  /** On the page: the ring takes the theme's text colour. */
  auto: { ring: "var(--foreground)", planet: BRAND.orange },
};

/** Thicker ring and bigger moon at small sizes so the mark survives. */
export function markWeights(px: number): { stroke: number; moon: number } {
  if (px <= 16) return { stroke: 9, moon: 10 };
  if (px <= 32) return { stroke: 7, moon: 8 };
  if (px <= 48) return { stroke: 6, moon: 7 };
  return { stroke: 5, moon: 6.5 };
}

/** The mark's inner SVG, as a string (for icon routes and data URIs). */
export function markSvgBody(variant: Exclude<MarkVariant, "auto">, px: number): string {
  const { ring, planet } = COLORS[variant];
  const { stroke, moon } = markWeights(px);
  return (
    `<g transform="rotate(-22 50 52)"><ellipse cx="50" cy="52" rx="45" ry="15" fill="none" stroke="${ring}" stroke-width="${stroke}"/></g>` +
    `<circle cx="50" cy="52" r="25" fill="${planet}"/>` +
    `<g transform="rotate(-22 50 52)"><path d="M 95,52 A 45,15 0 0 1 5,52" fill="none" stroke="${ring}" stroke-width="${stroke}" stroke-linecap="round"/><circle cx="75" cy="64.5" r="${moon}" fill="${ring}"/></g>`
  );
}

/** App icon / favicon: orange rounded square, mark at 75 %. */
export function appIconSvg(px: number, { rounded = true } = {}): string {
  const radius = rounded ? 22 : 0;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${px}" height="${px}">` +
    `<rect width="100" height="100" rx="${radius}" fill="${BRAND.orange}"/>` +
    `<g transform="translate(12.5 11) scale(0.75)">${markSvgBody("app", px)}</g>` +
    `</svg>`
  );
}

export function OrbieMark({
  variant = "auto",
  size = 32,
  className,
  title,
}: {
  variant?: MarkVariant;
  size?: number;
  className?: string;
  title?: string;
}) {
  const { ring, planet } = COLORS[variant];
  const { stroke, moon } = markWeights(size);
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <g transform="rotate(-22 50 52)">
        <ellipse cx="50" cy="52" rx="45" ry="15" fill="none" stroke={ring} strokeWidth={stroke} />
      </g>
      <circle cx="50" cy="52" r="25" fill={planet} />
      <g transform="rotate(-22 50 52)">
        <path
          d="M 95,52 A 45,15 0 0 1 5,52"
          fill="none"
          stroke={ring}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <circle cx="75" cy="64.5" r={moon} fill={ring} />
      </g>
    </svg>
  );
}

/** Wordmark in Fredoka 600, tracking −0.03em (Orbit: "Orbie"). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn("font-wordmark leading-none font-semibold", className)}
    >
      {APP_NAME}
    </span>
  );
}

/** Nav lockup: mark + wordmark. */
export function Lockup({ className, markSize = 38 }: { className?: string; markSize?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <OrbieMark size={markSize} />
      <Wordmark className="text-[1.75rem] text-foreground" />
    </span>
  );
}
