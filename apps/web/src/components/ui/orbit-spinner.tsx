import { cn } from "cn"

/**
 * Orbie's busy mark: a small planet with a moon circling it on a faint
 * ring, in the current text colour. It takes an icon's place (it sizes like
 * the icons around it). Reduced motion: the moon stays still and the mark
 * breathes instead (`.orbit-spinner` in globals.css).
 */
function OrbitSpinner({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      data-orbit-spinner=""
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("orbit-spinner", className)}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2.25" fill="currentColor" fillOpacity="0.85" />
      <g className="orbit-spinner-moon">
        <circle cx="8" cy="2" r="1.9" fill="currentColor" />
      </g>
    </svg>
  )
}

export { OrbitSpinner }
