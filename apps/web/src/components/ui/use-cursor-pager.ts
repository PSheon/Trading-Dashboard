"use client";

import { useState } from "react";

/** Retain the cursor for each visited page so Previous reads that page again. */
export function useCursorPager<C extends string | number>(reset?: unknown) {
  const [state, setState] = useState<{ cursors: C[]; reset: unknown }>({ cursors: [], reset });
  let cursors = state.cursors;
  if (state.reset !== reset) {
    cursors = [];
    setState({ cursors, reset });
  }
  return {
    cursor: cursors.at(-1),
    page: cursors.length,
    onPage: (page: number, next?: C | null) => {
      if (page < cursors.length) setState({ cursors: cursors.slice(0, Math.max(0, page)), reset });
      else if (page === cursors.length + 1 && next != null) setState({ cursors: [...cursors, next], reset });
    },
  };
}
