"use client";

import type { ComponentProps } from "react";

/** The button that opens a {@link Collapsible}: it says whether the panel
 * is open (`aria-expanded`) and which panel it controls. */
export function CollapsibleTrigger({
  open,
  controls,
  onOpenChange,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "onClick" | "aria-expanded" | "aria-controls"> & {
  open: boolean;
  /** The id of the panel it opens. */
  controls: string;
  onOpenChange: (open: boolean) => void;
}) {
  return <button type={type} aria-expanded={open} aria-controls={controls} onClick={() => onOpenChange(!open)} {...props} />;
}

/** A panel that opens with its height and opacity (globals.css
 * `.collapse-panel`: a one-row grid whose row grows from 0fr to 1fr while
 * its child clips; instant under `prefers-reduced-motion`). It stays
 * mounted so it can animate; closed, it is `inert` and `aria-hidden`, out
 * of the tab order and of assistive technology. `className` styles the
 * content inside the clipping child, so its margins and padding are
 * clipped too and the closed panel is 0 px tall. */
export function Collapsible({
  open,
  id,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "inert" | "aria-hidden"> & { open: boolean; id: string }) {
  return (
    <div {...props} id={id} className="collapse-panel" data-open={open} inert={!open} aria-hidden={open ? undefined : true}>
      <div>
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
