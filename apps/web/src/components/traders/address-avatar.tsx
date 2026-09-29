import { cn } from "cn";

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Generated avatar for an address: a small "planet" — two hues from the
 * address hash in a lit radial gradient, with a thin ring on some of them.
 * Deterministic, no network, no artwork.
 */
export function AddressAvatar({
  seed,
  size = 36,
  className,
}: {
  seed: string;
  size?: number;
  className?: string;
}) {
  const h = hash(seed.toLowerCase());
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + ((h >>> 9) % 120)) % 360;
  const ringed = ((h >>> 17) & 3) === 0;
  const tilt = -30 + ((h >>> 20) % 60);
  return (
    <span
      aria-hidden
      className={cn("relative inline-block shrink-0 rounded-full", className)}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 32% 28%, hsl(${hue1} 85% 72%) 0%, hsl(${hue1} 70% 52%) 38%, hsl(${hue2} 65% 30%) 100%)`,
        boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08)",
      }}
    >
      {ringed ? (
        <span
          className="absolute top-1/2 left-1/2 rounded-[50%] border border-foreground/60"
          style={{
            width: size * 1.35,
            height: size * 0.42,
            transform: `translate(-50%, -50%) rotate(${tilt}deg)`,
          }}
        />
      ) : null}
    </span>
  );
}
