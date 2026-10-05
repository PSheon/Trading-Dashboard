/**
 * Orbie's motion tokens: one small set of durations and easings for every
 * in-page transition (tab panels, collapsibles, segmented pills, chart
 * entrances), so nothing invents its own timing. The CSS side is the same
 * set as custom properties in globals.css (`--dur-*`, `--ease-orbit`).
 *
 * Under `prefers-reduced-motion: reduce` every one of them is instant.
 */
export const MOTION = {
  /** Small state changes: a crossfade, a pill, a chevron. */
  fast: 150,
  /** Panels switching (tabs, sub-tabs), dropdowns. */
  base: 200,
  /** Collapsibles opening (height + opacity). */
  slow: 250,
  /** A chart's line drawing in from left to right. */
  chartDraw: 850,
} as const;

/** The CSS `--ease-orbit` curve: a soft ease-out. */
export const EASE_ORBIT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** A gentle (quadratic) ease-out for JS-driven animation: the chart's line
 * reveal, which should read as drawing all the way to its end rather than
 * jumping most of the way at once. CSS: `--ease-draw`. */
export function easeOutQuad(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u;
}

/** True when the visitor asked for less motion (read at the moment of use,
 * so a change in the OS setting applies to the next animation). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
