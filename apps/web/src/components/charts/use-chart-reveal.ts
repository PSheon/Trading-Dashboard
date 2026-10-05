"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import { MOTION, easeOutQuad, prefersReducedMotion } from "@/lib/motion";

interface RevealOptions {
  /** The chart is drawn (its geometry is known and its SVG is in the DOM). */
  ready: boolean;
  /** What the chart shows: a window, a mode, a unit. A new value replays the
   * entrance once the data for it has arrived (see `data`). */
  replayKey?: unknown;
  /** The series itself. A change under the same `replayKey` (a background
   * refetch, a live tick) never replays; a new `replayKey` waits for new
   * data, so a window switch that keeps the previous series on screen while
   * the next one loads draws the new series, not the old one twice. */
  data: unknown;
}

const FIRST = Symbol("first");

/**
 * A chart's entrance: the line draws from left to right and the area fill
 * fades in behind it (MOTION.chartDraw, ease-out), on first appearance and
 * when what it shows changes. The plot sits in a clip rect whose width is
 * animated from 0 to its full width, so every path in it (the line, the
 * fill, both colours of a zero-crossing series) is revealed together, and the
 * reveal follows x rather than the path's length.
 *
 * Wire-up: `<clipPath><rect ref={clipRef} data-full={W} width={W} … /></clipPath>`
 * around the plot, `ref={fillRef}` on the area fill(s) and `ref={endRef}` on
 * what should appear once the line arrives (the end dot), `ref={rootRef}` on
 * the `<svg>`. The DOM is changed directly (no re-render per frame), and React's
 * own attribute values are the resting state, so a re-render mid-animation
 * (a hover) leaves it alone.
 *
 * A chart below the fold waits until it scrolls into view. Under reduced
 * motion nothing moves. Geometry never changes, so there is no layout shift.
 */
export function useChartReveal({ ready, replayKey, data }: RevealOptions) {
  const root = useRef<SVGSVGElement>(null);
  const clip = useRef<SVGRectElement>(null);
  const fill = useRef<SVGGElement>(null);
  const end = useRef<SVGGElement>(null);
  const played = useRef<{ key: unknown; data: unknown }>({ key: FIRST, data: FIRST });
  const stop = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (!ready) return;
    const last = played.current;
    if (Object.is(last.key, replayKey)) {
      // Same view: a refetch or a live tick redraws in place.
      last.data = data;
      return;
    }
    // A new view whose data hasn't changed yet (the previous series is
    // still up while the next one loads): wait for it.
    if (last.key !== FIRST && last.data === data) return;
    played.current = { key: replayKey, data };
    stop.current?.();
    stop.current = null;
    if (prefersReducedMotion()) return;
    const rect = clip.current;
    const svg = root.current;
    if (!rect || !svg) return;

    const fullWidth = () => rect.getAttribute("data-full") ?? "0";
    const paint = (t: number) => {
      const p = easeOutQuad(t);
      rect.setAttribute("width", String(Number(fullWidth()) * p));
      if (fill.current) fill.current.style.opacity = String(Math.min(1, p * 1.15));
    };
    let frame = 0;
    let observer: IntersectionObserver | null = null;
    let fade: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      rect.setAttribute("width", fullWidth());
      if (fill.current) fill.current.style.opacity = "";
      const dot = end.current;
      if (dot) {
        dot.style.transition = `opacity ${MOTION.base}ms ease-out`;
        dot.style.opacity = "";
        fade = setTimeout(() => { dot.style.transition = ""; }, MOTION.base);
      }
      stop.current = null;
    };
    const run = () => {
      let start = 0;
      const step = (now: number) => {
        if (!start) start = now;
        const t = (now - start) / MOTION.chartDraw;
        if (t >= 1) return finish();
        paint(t);
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    paint(0);
    if (end.current) end.current.style.opacity = "0";
    stop.current = () => {
      finish();
      if (fade) clearTimeout(fade);
    };
    if (typeof IntersectionObserver === "undefined") return run();
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        observer = null;
        run();
      }
    }, { threshold: 0.15 });
    observer.observe(svg);
  }, [ready, replayKey, data]);

  // Leaving the page mid-animation.
  useEffect(() => () => stop.current?.(), []);

  return { rootRef: root, clipRef: clip, fillRef: fill, endRef: end };
}
