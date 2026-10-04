"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * The orange pill of a capsule control slides to the chosen option. The
 * container gets the ref; the chosen option carries `data-active="true"`.
 * Returns the pill's box once measured (null on the server and until then,
 * when the option paints its own background instead).
 */
export function useSlidingIndicator<T extends HTMLElement>(activeKey: unknown) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector<HTMLElement>('[data-active="true"]');
      setBox(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeKey]);
  return [ref, box] as const;
}
