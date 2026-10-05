"use client";

import { useState, type ComponentProps } from "react";
import { cn } from "cn";

/**
 * The content of a switch (a tab panel, a sub-tab's page): when `value`
 * changes, the new content crossfades in with a 6px slide from the side the
 * tab sits on (right for a later tab, left for an earlier one), in
 * `--dur-base` with `--ease-orbit`. Only opacity and transform move, so the
 * layout never shifts; under reduced motion it is instant (globals.css,
 * `.switch-panel`). The first render doesn't animate.
 *
 * `order` lists the values in their on-screen order (for the direction).
 */
export function SwitchPanel<T extends string>({ value, order, className, style, ...rest }: { value: T; order: readonly T[] } & ComponentProps<"div">) {
  const dir = useSwitchDirection(value, order);
  return (
    <div
      key={value}
      {...rest}
      className={cn(dir !== 0 && "switch-panel", className)}
      style={dir !== 0 ? ({ ...style, "--switch-from": dir > 0 ? "6px" : "-6px" } as React.CSSProperties) : style}
    />
  );
}

/** +1 when `value` moved to a later item of `order`, -1 to an earlier one,
 * 0 until it first changes. */
export function useSwitchDirection<T>(value: T, order: readonly T[]): -1 | 0 | 1 {
  const [seen, setSeen] = useState<{ value: T; dir: -1 | 0 | 1 }>({ value, dir: 0 });
  if (!Object.is(seen.value, value)) {
    const dir = order.indexOf(value) >= order.indexOf(seen.value) ? 1 : -1;
    // Adjusting state while rendering (React's pattern for "the previous
    // value"): React re-renders at once with the new direction.
    setSeen({ value, dir });
    return dir;
  }
  return seen.dir;
}
