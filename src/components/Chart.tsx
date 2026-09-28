"use client";

import { useEffect, useRef } from "react";

import { type ChartOptions, drawChart } from "./drawChart";

export function Chart({ options }: { options: ChartOptions }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    drawChart(el, options);
    let last = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - last) > 4) {
        last = el.clientWidth;
        drawChart(el, options);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [options]);
  return <div ref={ref} />;
}
